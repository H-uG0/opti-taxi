/**
 * Writes of routes that keep what the drivers hold: « Appliquer » (INS-01), the draft (INS-03) and a
 * re-optimization of a day under way (DAY-02).
 *
 * The stops that stay on a route are updated in place, so their ids hold: a driver's roadmap on the
 * phone and the statuses waiting in its offline queue name stops by id (refresh-routes.ts and
 * detach.ts keep them too). A stop done by the crew is never rewritten: its row keeps its planned
 * times and completion (only its position may follow when an earlier stop left).
 *
 * Pure planning (planStopWrites, planStartedWrite) plus the transaction step (writePlacedRoutes),
 * which takes the Prisma transaction as a parameter: no server-only import (savePlan uses it).
 */
import type { Prisma, RouteStatus, StopKind, TripStatus } from "@prisma/client";
import type { RouteRow, StopRow, TripUpdate } from "@/lib/optimizer/persist";
import { isStopDone } from "./stop-done";

/** A stored stop as the writes read it. */
export type StoredStopRef = { id: string; tripId: string; kind: StopKind; sequence?: number; completedAt?: Date | null };

/**
 * How the stops of a route in place are rewritten: the stops that stay (same trip and kind) are
 * updated in place, those that leave are deleted, those that come are created. A frozen stop (done by
 * the crew) only takes its new position, never new times.
 */
export type StopWrites = {
  deleteIds: string[];
  updates: { id: string; data: StopRow | Pick<StopRow, "sequence"> }[];
  creates: StopRow[];
};

export function planStopWrites(
  stored: readonly Pick<StoredStopRef, "id" | "tripId" | "kind">[],
  rows: readonly StopRow[],
  frozen: ReadonlySet<string> = new Set(),
): StopWrites {
  const byKey = new Map(stored.map((stop) => [`${stop.tripId}:${stop.kind}`, stop.id]));
  const kept = new Set<string>();
  const updates: StopWrites["updates"] = [];
  const creates: StopRow[] = [];
  for (const row of rows) {
    const id = byKey.get(`${row.tripId}:${row.kind}`);
    if (id !== undefined && !kept.has(id)) {
      kept.add(id);
      updates.push({ id, data: frozen.has(id) ? { sequence: row.sequence } : row });
    } else {
      creates.push(row);
    }
  }
  // A frozen stop never leaves its route. One the plan no longer carries (its trip closed since, an interrupted
  // transport) keeps its row, after the plan's stops, in its former order: never a position another stop holds.
  let next = rows.length;
  for (const stop of stored) {
    if (frozen.has(stop.id) && !kept.has(stop.id)) updates.push({ id: stop.id, data: { sequence: next++ } });
  }
  return { deleteIds: stored.filter((stop) => !kept.has(stop.id) && !frozen.has(stop.id)).map((stop) => stop.id), updates, creates };
}

/** The results a trip of a written route gets: those of persist.ts, the planned minute of a stop done left out. */
export type TripWrite = Omit<TripUpdate, "data"> & { data: Partial<TripUpdate["data"]> };

/** What a write changes: some routes, the routes left without a stop, the results of their trips. */
export type PlaceWrite = {
  /** Rows of the routes written; routeId null: a route to create. */
  routes: { routeId: string | null; row: RouteRow }[];
  /** Routes in place left without any stop: deleted (their trips have gone elsewhere). */
  deletedRouteIds: string[];
  /** Results of the trips of these routes (persist.ts planTripUpdates). */
  trips: TripWrite[];
};

/**
 * Trip results without the planned minute of a stop done (« tripId/KIND » in `done`): what was done
 * keeps the time it was planned at (lateness is measured against it).
 */
export function keepDoneMinutes(updates: readonly TripUpdate[], done: ReadonlySet<string>): TripWrite[] {
  if (done.size === 0) return [...updates];
  return updates.map((update) => {
    const { plannedPickupMinute, plannedDropoffMinute, ...rest } = update.data;
    return {
      ...update,
      data: {
        ...rest,
        ...(done.has(`${update.tripId}/PICKUP`) ? {} : { plannedPickupMinute }),
        ...(done.has(`${update.tripId}/DROPOFF`) ? {} : { plannedDropoffMinute }),
      },
    };
  });
}

/** A stored route as a re-optimization of a day under way reads it. */
export type StartedStoredRoute = {
  id: string;
  vehicleId: string;
  startMinute: number;
  stops: readonly (StoredStopRef & { sequence: number; completedAt: Date | null })[];
};

/**
 * What a plan of a day under way writes (DAY-02, « Réoptimiser la suite »): only the routes it
 * touches. A route whose stops come in the same order is left as it is (its times too: the driver's
 * roadmap does not move for nothing); a touched route keeps its id, crew and start (its stops done
 * are behind it) and its stops done (writePlacedRoutes); a stored route the plan no longer has is deleted, unless a stop of
 * it is done (never: the optimizer heads each started route with its stops done). The trips written are
 * those of the touched, created and deleted routes and those that change vehicle; a planned minute of a
 * stop done is not rewritten. `frozenStopIds`: the stops done, for planStopWrites.
 */
export function planStartedWrite(args: {
  rows: readonly RouteRow[];
  updates: readonly TripUpdate[];
  stored: readonly StartedStoredRoute[];
  statusOf: (tripId: string) => TripStatus | undefined;
}): PlaceWrite & { frozenStopIds: Set<string>; untouched: number } {
  const { rows, updates, stored, statusOf } = args;
  const storedByVehicle = new Map(stored.map((route) => [route.vehicleId, route]));
  const frozenStopIds = new Set<string>();
  const doneKeys = new Set<string>();
  const vehicleOf = new Map<string, string>();
  for (const route of stored) {
    for (const stop of route.stops) {
      vehicleOf.set(stop.tripId, route.vehicleId);
      if (isStopDone(stop, statusOf(stop.tripId))) {
        frozenStopIds.add(stop.id);
        doneKeys.add(`${stop.tripId}/${stop.kind}`);
      }
    }
  }
  const order = (stops: readonly { tripId: string; kind: StopKind }[]) => stops.map((s) => `${s.tripId}/${s.kind}`).join(" ");
  const written: PlaceWrite["routes"] = [];
  const touched = new Set<string>();
  let untouched = 0;
  for (const row of rows) {
    const route = storedByVehicle.get(row.vehicleId);
    if (route && order([...route.stops].sort((a, b) => a.sequence - b.sequence)) === order(row.stops)) {
      untouched += 1;
      continue;
    }
    touched.add(row.vehicleId);
    if (!route) {
      written.push({ routeId: null, row });
      continue;
    }
    const started = route.stops.some((stop) => frozenStopIds.has(stop.id));
    written.push({ routeId: route.id, row: started ? { ...row, startMinute: route.startMinute } : row });
  }
  const planned = new Set(rows.map((row) => row.vehicleId));
  const deleted = stored.filter((route) => !planned.has(route.vehicleId) && !route.stops.some((stop) => frozenStopIds.has(stop.id)));
  for (const route of deleted) touched.add(route.vehicleId);
  const changed = updates.filter((update) => {
    const before = vehicleOf.get(update.tripId) ?? null;
    return before !== update.vehicleId || (before !== null && touched.has(before));
  });
  return { routes: written, deletedRouteIds: deleted.map((route) => route.id), trips: keepDoneMinutes(changed, doneKeys), frozenStopIds, untouched };
}

/**
 * Writes the routes of `write`: each route kept is updated in place, the stops that stay keeping their
 * ids (planStopWrites; `frozenStopIds`, the stops done, keep their row); a route created takes `status`
 * (and its validation time) and the crew of its row; the trips get their results and route; `locks`
 * sets the lock of the trips the regulator moved (null: unlocked); the routes left without a stop are
 * deleted. Run inside the transaction holding the planning lock and the routes' row locks.
 */
export async function writePlacedRoutes(
  tx: Prisma.TransactionClient,
  args: {
    serviceDate: Date;
    write: PlaceWrite;
    storedByVehicle: ReadonlyMap<string, { stops: readonly Pick<StoredStopRef, "id" | "tripId" | "kind">[] }>;
    matrixSource: string;
    status: RouteStatus;
    validatedAt: Date;
    planRunId: string | null;
    locks: ReadonlyMap<string, string | null>;
    frozenStopIds?: ReadonlySet<string>;
  },
): Promise<void> {
  const { serviceDate, write, storedByVehicle, matrixSource, status, validatedAt, planRunId, locks } = args;
  const frozen = args.frozenStopIds ?? new Set<string>();
  const routeIdByVehicle = new Map<string, string>();
  for (const { routeId, row } of write.routes) {
    const { stops, vehicleId: rowVehicle, driverId, crewMateId, ...totals } = row;
    if (routeId) {
      // The stops that stay are updated in place: a driver's phone names them by id (roadmap, offline queue).
      const stopWrites = planStopWrites(storedByVehicle.get(rowVehicle)?.stops ?? [], stops, frozen);
      if (stopWrites.deleteIds.length > 0) await tx.routeStop.deleteMany({ where: { id: { in: stopWrites.deleteIds } } });
      if (stopWrites.updates.length > 0) {
        // Out of the way first (-1, -2…): each stop then takes its new position, never one another still holds
        // (@@unique([routeId, sequence]) is checked row by row).
        await tx.$executeRaw`UPDATE "RouteStop" SET "sequence" = -"sequence" - 1 WHERE "routeId" = ${routeId}`;
        for (const { id, data } of stopWrites.updates) await tx.routeStop.update({ where: { id }, data });
      }
      // The crew of a route in place stays (a crew changed on a started day is the route's own, lot 4).
      await tx.route.update({ where: { id: routeId }, data: { ...totals, matrixSource } });
      if (stopWrites.creates.length > 0) {
        await tx.routeStop.createMany({ data: stopWrites.creates.map((stop) => ({ ...stop, routeId })) });
      }
      routeIdByVehicle.set(rowVehicle, routeId);
    } else {
      const created = await tx.route.create({
        data: {
          ...totals,
          vehicleId: rowVehicle,
          driverId,
          crewMateId,
          serviceDate,
          status,
          ...(status === "VALIDATED" ? { validatedAt } : {}),
          optimizationRunId: planRunId,
          matrixSource,
          stops: { createMany: { data: stops } },
        },
        select: { id: true },
      });
      routeIdByVehicle.set(rowVehicle, created.id);
    }
  }
  for (const update of write.trips) {
    await tx.trip.update({
      where: { id: update.tripId },
      data: {
        ...update.data,
        routeId: update.vehicleId ? (routeIdByVehicle.get(update.vehicleId) ?? null) : null,
        ...(locks.has(update.tripId) ? { lockedVehicleId: locks.get(update.tripId) ?? null } : {}),
      },
    });
  }
  if (write.deletedRouteIds.length > 0) await tx.route.deleteMany({ where: { id: { in: write.deletedRouteIds } } });
}
