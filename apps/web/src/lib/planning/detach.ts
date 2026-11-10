/**
 * Taking a trip out of the route(s) serving it: cancelled in « Courses »,
 * rescheduled out of its planned times, or cancelled / changed by a
 * referential change (patient, prescription, recurrence, facility).
 *
 * `planDetach` (pure, unit-tested) decides what changes in the route;
 * `removeTripStops` applies it in the caller's transaction. The Prisma
 * transaction client is a parameter and nothing here imports a Prisma value
 * or "server-only", so any module (and the tests) can import it. Times and
 * route totals are recomputed afterwards by refresh-routes.ts, once the
 * caller's transaction has committed.
 */
import type { Prisma, StopKind } from "@prisma/client";

export type StopForCoPassengers = { routeId: string; tripId: string; kind: StopKind; sequence: number };

export type RouteStopForDetach = StopForCoPassengers & { id: string; loadAfter: number };

export type DetachPlan = {
  /** Stops of the leaving trip, to delete. */
  removedStopIds: string[];
  /**
   * Remaining stops whose position or number of patients on board changes,
   * route by route in sequence order. Positions are renumbered from 0 with no
   * gap, so each new position is at most the old one: applied in this order
   * after the deletion, the updates never collide on (routeId, sequence).
   */
  stopUpdates: { id: string; sequence: number; loadAfter: number }[];
  /**
   * Former co-passengers left alone on board: no longer shared (contract:
   * shared = at least one co-passenger), their shared-discounted revenue and
   * their detour no longer hold.
   */
  nowAlone: string[];
  /** Former co-passengers still sharing with someone else: revenue and detour no longer hold. */
  stillShared: string[];
};

/** Stops grouped by route, each route in sequence order. */
function routesInOrder<S extends StopForCoPassengers>(stops: readonly S[]): S[][] {
  const byRoute = new Map<string, S[]>();
  for (const stop of stops) {
    const list = byRoute.get(stop.routeId);
    if (list) list.push(stop);
    else byRoute.set(stop.routeId, [stop]);
  }
  return [...byRoute.values()].map((list) => list.sort((a, b) => a.sequence - b.sequence));
}

/**
 * Co-passengers of each trip: trips on board at the same time in the same
 * route, read from the ordered stops (a patient is on board from its pickup to
 * its dropoff). The single implementation of this rule: « Courses » shows the
 * co-passengers with it and `planDetach` decides who is left alone.
 */
export function coPassengersFromStops(stops: readonly StopForCoPassengers[]): Map<string, string[]> {
  const links = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    let set = links.get(a);
    if (!set) links.set(a, (set = new Set()));
    set.add(b);
  };
  for (const routeStops of routesInOrder(stops)) {
    const onBoard = new Set<string>();
    for (const stop of routeStops) {
      if (stop.kind === "PICKUP") {
        for (const other of onBoard) {
          link(stop.tripId, other);
          link(other, stop.tripId);
        }
        onBoard.add(stop.tripId);
      } else {
        onBoard.delete(stop.tripId);
      }
    }
  }
  return new Map([...links].map(([tripId, set]) => [tripId, [...set]]));
}

/** New position (0, 1, 2… per route) and number of patients on board after each stop. */
function positionsAfter(stops: readonly RouteStopForDetach[]): Map<string, { sequence: number; loadAfter: number }> {
  const positions = new Map<string, { sequence: number; loadAfter: number }>();
  for (const routeStops of routesInOrder(stops)) {
    const onBoard = new Set<string>();
    routeStops.forEach((stop, index) => {
      if (stop.kind === "PICKUP") onBoard.add(stop.tripId);
      else onBoard.delete(stop.tripId);
      positions.set(stop.id, { sequence: index, loadAfter: onBoard.size });
    });
  }
  return positions;
}

/**
 * Plan of the removal of `tripId` from the given stops (all the stops of the
 * routes that serve it). The other stops keep their order; their position and
 * load are recomputed. Their planned times are recomputed after the
 * transaction (refresh-routes.ts), or by the next optimization.
 */
export function planDetach(stops: readonly RouteStopForDetach[], tripId: string): DetachPlan {
  const remaining = stops.filter((stop) => stop.tripId !== tripId);
  const formerCoPassengers = coPassengersFromStops(stops).get(tripId) ?? [];
  const after = coPassengersFromStops(remaining);
  const sharesAfter = (id: string) => (after.get(id)?.length ?? 0) > 0;
  const positions = positionsAfter(remaining);

  const stopUpdates: DetachPlan["stopUpdates"] = [];
  for (const stop of [...remaining].sort((a, b) => a.routeId.localeCompare(b.routeId) || a.sequence - b.sequence)) {
    const next = positions.get(stop.id);
    if (next && (next.sequence !== stop.sequence || next.loadAfter !== stop.loadAfter)) {
      stopUpdates.push({ id: stop.id, ...next });
    }
  }

  return {
    removedStopIds: stops.filter((stop) => stop.tripId === tripId).map((stop) => stop.id),
    stopUpdates,
    nowAlone: formerCoPassengers.filter((id) => !sharesAfter(id)),
    stillShared: formerCoPassengers.filter(sharesAfter),
  };
}

export type DetachResult = {
  /**
   * Former co-passengers now travelling alone (trip ids). A batch counts at
   * the end those it did not cancel itself (two co-passengers both ticked).
   */
  nowAlone: string[];
  /** Routes the trip left: their times and totals must be recomputed (refresh-routes.ts). */
  routeIds: string[];
};

export const NOTHING_DETACHED: DetachResult = { nowAlone: [], routeIds: [] };

/**
 * Locks every route serving one of `tripIds`, in one statement and in id
 * order, before a batch takes several trips out of their routes: trip by
 * trip, removeTripStops would lock them in the batch's order, and two batches
 * (or a batch and a recomputation) crossing the same two routes could
 * deadlock. Locking again a route already held (removeTripStops) waits for nothing.
 */
export async function lockRoutesOfTrips(tx: Prisma.TransactionClient, tripIds: readonly string[]): Promise<void> {
  if (tripIds.length === 0) return;
  const stops = await tx.routeStop.findMany({ where: { tripId: { in: [...tripIds] } }, select: { routeId: true } });
  const routeIds = [...new Set(stops.map((stop) => stop.routeId))];
  if (routeIds.length === 0) return;
  await tx.$queryRaw`SELECT "id" FROM "Route" WHERE "id" = ANY(${routeIds}) ORDER BY "id" FOR UPDATE`;
}

/**
 * Takes the trip's stops out of the route(s) serving it, in the caller's
 * transaction. The remaining stops keep their order but get their position and
 * load recomputed; former co-passengers lose their shared-discounted revenue
 * and detour, and those left alone are no longer shared, so neither /courses
 * nor the reception list announce a shared transport that no longer exists.
 * The trip row itself is the caller's business.
 */
export async function removeTripStops(tx: Prisma.TransactionClient, tripId: string): Promise<DetachResult> {
  const own = await tx.routeStop.findMany({ where: { tripId }, select: { routeId: true } });
  if (own.length === 0) return NOTHING_DETACHED;
  // Same lock as savePlan and refresh-routes.ts, taken before the stops are
  // read: two trips leaving one route at the same time are applied one after
  // the other, the second planned from the stops the first left (renumbering
  // never targets a deleted or taken position). A route replaced meanwhile is
  // no longer found.
  const candidates = [...new Set(own.map((stop) => stop.routeId))];
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Route" WHERE "id" = ANY(${candidates}) ORDER BY "id" FOR UPDATE`;
  const routeIds = locked.map((route) => route.id);
  if (routeIds.length === 0) return NOTHING_DETACHED;

  const stops = await tx.routeStop.findMany({
    where: { routeId: { in: routeIds } },
    select: { id: true, routeId: true, tripId: true, kind: true, sequence: true, loadAfter: true },
  });
  const plan = planDetach(stops, tripId);

  await tx.routeStop.deleteMany({ where: { tripId } });
  // In order: see DetachPlan.stopUpdates.
  for (const { id, sequence, loadAfter } of plan.stopUpdates) {
    await tx.routeStop.update({ where: { id }, data: { sequence, loadAfter } });
  }
  if (plan.nowAlone.length > 0) {
    await tx.trip.updateMany({
      where: { id: { in: plan.nowAlone } },
      data: { shared: false, detourKm: null, estimatedRevenue: null },
    });
  }
  if (plan.stillShared.length > 0) {
    await tx.trip.updateMany({ where: { id: { in: plan.stillShared } }, data: { detourKm: null, estimatedRevenue: null } });
  }
  return { nowAlone: plan.nowAlone, routeIds };
}

/** Prisma codes of a lost race: unique key taken, row gone, write conflict or deadlock. */
const CONCURRENT_WRITE_CODES: readonly string[] = ["P2002", "P2025", "P2034"];

/**
 * PostgreSQL codes of a lost race in a raw query (Prisma P2010, the row
 * locks taken with $queryRaw): deadlock detected, serialization failure.
 */
const CONCURRENT_RAW_CODES: readonly string[] = ["40P01", "40001"];

/**
 * True when a transaction failed because another one changed the same rows
 * first: the action answers « changed meanwhile, reload » instead of failing.
 * Duck-typed (PrismaClientKnownRequestError) so that no Prisma value is imported.
 */
export function isConcurrentWriteError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name, code, meta } = error as { name?: unknown; code?: unknown; meta?: unknown };
  if (name !== "PrismaClientKnownRequestError" || typeof code !== "string") return false;
  if (CONCURRENT_WRITE_CODES.includes(code)) return true;
  const rawCode = typeof meta === "object" && meta !== null ? (meta as { code?: unknown }).code : undefined;
  return code === "P2010" && typeof rawCode === "string" && CONCURRENT_RAW_CODES.includes(rawCode);
}
