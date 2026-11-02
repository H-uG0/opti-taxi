/**
 * Recomputes the routes a trip has just left (cancelled, rescheduled out of
 * its window, cancelled or changed by a referential change).
 *
 * Taking a trip out (detach.ts) keeps the order of the remaining stops, but
 * their times, the route totals and the co-passengers' results still date from
 * the last optimization. Once the detaching transaction has committed, the
 * optimizer's POST /evaluate recomputes them from the stored stop sequence
 * (same timing as /optimize) and they are written back with the pure mapping
 * of persist.ts. When the optimizer cannot be reached, the stored values stay:
 * the next optimization rebuilds everything.
 *
 * A route the crew has started (a stop done) keeps what was done as planned:
 * /evaluate re-times the whole sequence from the depot, so only the stops after
 * the last one done, the route's end, break and totals take the new values
 * (see routeRefresh).
 *
 * Never written here: route status (a VALIDATED route stays VALIDATED), crew,
 * RouteStop.completedAt, stop positions (detach.ts renumbers them), trip
 * status, and the routes of other dates.
 *
 * The pure parts are unit-tested; `refreshRoutes` receives the Prisma client
 * and the optimizer call as parameters, so this module has no server-only import.
 */
import {
  Prisma,
  type PrismaClient,
  type SharingStatus,
  type StopKind,
  type TripStatus,
  type VehicleType,
} from "@prisma/client";
import { buildOptimizeRequest, loadOptimizeInput } from "@/lib/optimizer/build-request";
import type { EvaluateRequest, OptimizeRequest, PlanResponse, ViolationCode } from "@/lib/optimizer/contract";
import {
  FIELD_TRIP_STATUSES,
  planRoutes,
  planTripUpdates,
  type CurrentTrip,
  type RouteRow,
  type VehicleCrew,
} from "@/lib/optimizer/persist";
import { fromIsoDate, toIsoDate } from "@/lib/time";

/** Same budget as savePlan: the write locks the routes, a re-optimization in flight may hold them. */
const REFRESH_TX_OPTIONS = { maxWait: 15_000, timeout: 60_000 } as const;

/** Statuses of trips that are no longer carried: their results are never rewritten. */
const OFF_ROUTE_STATUSES = ["CANCELLED", "NO_SHOW"] as const;

/** Cross-route rule: the patient's outbound and return may be served by two vehicles. */
const PATIENT_WIDE_VIOLATIONS: readonly ViolationCode[] = ["TOTAL_WAIT"];

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type StoredStop = {
  id: string;
  tripId: string;
  kind: StopKind;
  sequence: number;
  arrivalMinute: number;
  startMinute: number;
  departureMinute: number;
  /** Pick-up / drop-off recorded by the crew. */
  completedAt: Date | null;
};

/** A route as stored, with its stops (any order). */
export type StoredRoute = {
  id: string;
  vehicleId: string;
  startMinute: number;
  breakStartMinute: number | null;
  breakEndMinute: number | null;
  stops: StoredStop[];
};

/** A trip of a refreshed route as read just before writing (CurrentTrip of persist.ts plus its route). */
export type RefreshTrip = CurrentTrip & { routeId: string | null };

/** Vehicle of the day's request (contract): type for planRoutes, hourly cost for the route cost. */
export type RefreshVehicle = { id: string; type: VehicleType; costPerHour: number };

export type RouteRefresh = {
  routeId: string;
  data: {
    startMinute: number;
    endMinute: number;
    distanceKm: number;
    emptyKm: number;
    revenue: number;
    cost: number;
    margin: number;
    breakStartMinute: number | null;
    breakEndMinute: number | null;
  };
  /** Stops whose times and load are rewritten, in sequence order. */
  stops: {
    id: string;
    data: { arrivalMinute: number; startMinute: number; departureMinute: number; loadAfter: number };
  }[];
  /**
   * Stops of a started route that keep their stored times (the stops done by
   * the crew and those before them), as stopKey(tripId, kind).
   */
  keptStops: string[];
};

export type TripRefresh = {
  tripId: string;
  /** Route the trip must still be in for the write to apply. */
  routeId: string;
  /** Sharing status read before writing: the write is guarded on it (a regulator's answer is never overwritten). */
  sharingStatus: SharingStatus;
  data: {
    /** Absent when the pick-up stop keeps its stored times (done by the crew). */
    plannedPickupMinute?: number | null;
    /** Absent when the drop-off stop keeps its stored times (done by the crew). */
    plannedDropoffMinute?: number | null;
    shared: boolean;
    directKm: number | null;
    detourKm: number | null;
    estimatedRevenue: number | null;
    sharingStatus?: SharingStatus;
    sharingProposedAt?: Date | null;
  };
};

export type RefreshPlan = {
  routes: RouteRefresh[];
  trips: TripRefresh[];
  /** Routes the evaluation does not describe stop for stop: they keep their stored values. */
  keptRouteIds: string[];
};

export type RefreshOutcome = {
  /** Routes whose times, loads and totals were recomputed. */
  refreshed: number;
  /** Routes left with their stored values (optimizer unavailable, plan changed meanwhile…). */
  kept: number;
  /** Hard-rule violations reported by /evaluate on the recomputed routes (new or not). */
  violations: number;
  /** The optimizer could not be reached or did not answer in time. */
  unavailable: boolean;
  /** The optimizer answered with an error, or the recomputation failed otherwise. */
  failed: boolean;
  /** A day concerned is under way (stops done): it can no longer be re-optimized. */
  dayStarted: boolean;
};

export const NOTHING_REFRESHED: RefreshOutcome = {
  refreshed: 0,
  kept: 0,
  violations: 0,
  unavailable: false,
  failed: false,
  dayStarted: false,
};

/** Failure reasons of lib/optimizer/client.ts (OptimizerFailureReason). */
export type EvaluateResult =
  | { ok: true; data: PlanResponse }
  | { ok: false; error: string; reason?: "unreachable" | "timeout" | "error" };

export type RefreshDeps = {
  prisma: PrismaClient;
  /** lib/optimizer/client.ts evaluate(). */
  evaluate: (request: EvaluateRequest) => Promise<EvaluateResult>;
  now?: Date;
};

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

function bySequence<S extends { sequence: number }>(stops: readonly S[]): S[] {
  return [...stops].sort((a, b) => a.sequence - b.sequence);
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function stopKey(tripId: string, kind: StopKind): string {
  return `${tripId}/${kind}`;
}

/**
 * The day's request plus the stored stop sequence of every route of the day,
 * so that the cross-route rules (a patient's total wait) are checked too.
 */
export function buildEvaluateRequest(request: OptimizeRequest, routes: readonly StoredRoute[]): EvaluateRequest {
  return {
    ...request,
    routes: routes
      .filter((route) => route.stops.length > 0)
      .map((route) => ({
        vehicleId: route.vehicleId,
        stops: bySequence(route.stops).map(({ tripId, kind }) => ({ tripId, kind })),
      })),
  };
}

/** Same stops, in the same order (ids included): the route did not change since `before` was read. */
export function sameStops(before: StoredRoute, after: StoredRoute): boolean {
  const a = bySequence(before.stops);
  const b = bySequence(after.stops);
  return a.length === b.length && a.every((stop, i) => stop.id === b[i]?.id && stop.sequence === b[i]?.sequence);
}

/** A stop the crew has done: recorded, or implied by its trip's field status. */
export function isStopDone(stop: Pick<StoredStop, "kind" | "completedAt">, tripStatus: TripStatus | undefined): boolean {
  if (stop.completedAt !== null) return true;
  if (tripStatus === "DROPPED_OFF") return true;
  return stop.kind === "PICKUP" && (tripStatus === "PICKED_UP" || tripStatus === "NO_SHOW");
}

type Break = { breakStartMinute: number | null; breakEndMinute: number | null };

/**
 * Break of a started route, or null when the evaluation cannot be reconciled
 * with what was done: an evaluated break still to come is taken; one the
 * evaluation places among the stops done only fits a break planned there too
 * (the stored one stays); without evaluated break, a stored break already
 * behind stays and one still to come is dropped.
 */
function startedRouteBreak(route: StoredRoute, row: RouteRow, doneDeparture: number, evaluatedDoneDeparture: number): Break | null {
  const storedBehind = route.breakEndMinute !== null && route.breakEndMinute <= doneDeparture;
  const stored: Break = { breakStartMinute: route.breakStartMinute, breakEndMinute: route.breakEndMinute };
  if (row.breakStartMinute !== null && row.breakEndMinute !== null) {
    if (row.breakStartMinute >= evaluatedDoneDeparture) {
      return { breakStartMinute: row.breakStartMinute, breakEndMinute: row.breakEndMinute };
    }
    return storedBehind ? stored : null;
  }
  return storedBehind ? stored : { breakStartMinute: null, breakEndMinute: null };
}

/**
 * New values of a stored route from the evaluated row of its vehicle, or null
 * when the row does not hold the same stops in the same order (stop of a trip
 * the optimizer does not know, vehicle not working that day…). A route left
 * without stops drives nothing and earns nothing.
 *
 * On a route the crew has started, /evaluate has re-timed the whole sequence
 * from the depot. What was done stays as planned: the departure, the stops up
 * to the last one done and their trips' planned minutes. The evaluated times
 * of the following stops are taken only when they leave the last stop done no
 * earlier than planned (the vehicle never has to leave a stop before it was
 * there); otherwise the route is not recomputed (null). Its cost counts the
 * hours from the stored departure (contract: km x costPerKm + hours x costPerHour).
 */
export function routeRefresh(
  route: StoredRoute,
  row: RouteRow | undefined,
  statusOf: (tripId: string) => TripStatus | undefined = () => undefined,
  costPerHour = 0,
): RouteRefresh | null {
  const stops = bySequence(route.stops);
  if (stops.length === 0) {
    return {
      routeId: route.id,
      data: {
        startMinute: route.startMinute,
        endMinute: route.startMinute,
        distanceKm: 0,
        emptyKm: 0,
        revenue: 0,
        cost: 0,
        margin: 0,
        breakStartMinute: null,
        breakEndMinute: null,
      },
      stops: [],
      keptStops: [],
    };
  }
  if (!row || row.stops.length !== stops.length) return null;
  const pairs = stops.map((stop, i) => ({ stop, evaluated: row.stops[i] }));
  if (pairs.some(({ stop, evaluated }) => evaluated?.tripId !== stop.tripId || evaluated.kind !== stop.kind)) return null;

  const timesOf = (from: number) =>
    pairs.slice(from).flatMap(({ stop, evaluated }) =>
      evaluated
        ? [
            {
              id: stop.id,
              data: {
                arrivalMinute: evaluated.arrivalMinute,
                startMinute: evaluated.startMinute,
                departureMinute: evaluated.departureMinute,
                loadAfter: evaluated.loadAfter,
              },
            },
          ]
        : [],
    );
  const totals = { distanceKm: row.distanceKm, emptyKm: row.emptyKm, revenue: row.revenue };

  const lastDone = stops.findLastIndex((stop) => isStopDone(stop, statusOf(stop.tripId)));
  if (lastDone < 0) {
    return {
      routeId: route.id,
      data: {
        startMinute: row.startMinute,
        endMinute: row.endMinute,
        ...totals,
        cost: row.cost,
        margin: row.margin,
        breakStartMinute: row.breakStartMinute,
        breakEndMinute: row.breakEndMinute,
      },
      stops: timesOf(0),
      keptStops: [],
    };
  }

  const done = stops[lastDone];
  const evaluatedDone = row.stops[lastDone];
  if (!done || !evaluatedDone || evaluatedDone.departureMinute < done.departureMinute) return null;
  const brk = startedRouteBreak(route, row, done.departureMinute, evaluatedDone.departureMinute);
  if (!brk) return null;
  const cost = roundMoney(row.cost + ((row.startMinute - route.startMinute) / 60) * costPerHour);
  return {
    routeId: route.id,
    data: {
      startMinute: route.startMinute,
      endMinute: row.endMinute,
      ...totals,
      cost,
      margin: roundMoney(row.revenue - cost),
      ...brk,
    },
    stops: timesOf(lastDone + 1),
    keptStops: stops.slice(0, lastDone + 1).map((stop) => stopKey(stop.tripId, stop.kind)),
  };
}

/**
 * What to write for `routes` (stored stops, read under lock) from the
 * evaluation: route totals and stop times through planRoutes and routeRefresh,
 * trip results and sharing traceability through planTripUpdates (persist.ts).
 * Trip status is never part of it, nor the planned minutes of a stop done.
 */
export function planRefresh(
  routes: readonly StoredRoute[],
  response: Pick<PlanResponse, "routes" | "trips">,
  vehicles: readonly RefreshVehicle[],
  trips: ReadonlyMap<string, RefreshTrip>,
  now: Date,
): RefreshPlan {
  const affectedVehicles = new Set(routes.map((route) => route.vehicleId));
  const crews = new Map<string, VehicleCrew>(
    vehicles.map((v) => [v.id, { id: v.id, type: v.type, defaultDriverId: null, defaultCrewMateId: null }]),
  );
  const costPerHour = new Map(vehicles.map((v) => [v.id, v.costPerHour]));
  const rows = planRoutes({ routes: response.routes.filter((r) => affectedVehicles.has(r.vehicleId)) }, crews, trips);
  const rowByVehicle = new Map(rows.map((row) => [row.vehicleId, row]));
  const statusOf = (tripId: string) => trips.get(tripId)?.status;

  const refreshes: RouteRefresh[] = [];
  const keptRouteIds: string[] = [];
  const servedRows: RouteRow[] = [];
  const routeOfTrip = new Map<string, string>();
  const keptStops = new Set<string>();
  for (const route of routes) {
    const row = rowByVehicle.get(route.vehicleId);
    const refresh = routeRefresh(route, row, statusOf, costPerHour.get(route.vehicleId) ?? 0);
    if (!refresh) {
      keptRouteIds.push(route.id);
      continue;
    }
    refreshes.push(refresh);
    for (const key of refresh.keptStops) keptStops.add(key);
    if (row && route.stops.length > 0) {
      servedRows.push(row);
      for (const stop of route.stops) routeOfTrip.set(stop.tripId, route.id);
    }
  }

  const updates = planTripUpdates([...routeOfTrip.keys()], response, servedRows, trips, now);
  const tripRefreshes: TripRefresh[] = [];
  for (const { tripId, vehicleId, data } of updates) {
    const routeId = routeOfTrip.get(tripId);
    const trip = trips.get(tripId);
    // A trip served elsewhere in the evaluation, or moved since, is left alone.
    if (!routeId || !trip || vehicleId === null || trip.routeId !== routeId) continue;
    tripRefreshes.push({
      tripId,
      routeId,
      sharingStatus: trip.sharingStatus,
      data: {
        ...(keptStops.has(stopKey(tripId, "PICKUP")) ? {} : { plannedPickupMinute: data.plannedPickupMinute }),
        ...(keptStops.has(stopKey(tripId, "DROPOFF")) ? {} : { plannedDropoffMinute: data.plannedDropoffMinute }),
        shared: data.shared,
        directKm: data.directKm,
        detourKm: data.detourKm,
        estimatedRevenue: data.estimatedRevenue,
        ...(data.sharingStatus !== undefined
          ? { sharingStatus: data.sharingStatus, sharingProposedAt: data.sharingProposedAt ?? null }
          : {}),
      },
    });
  }
  return { routes: refreshes, trips: tripRefreshes, keptRouteIds };
}

/**
 * Violations of the evaluation that concern the recomputed routes: on their
 * vehicles, on their trips, or a total wait of one of their patients (whose
 * other leg may be on another vehicle). Violations of the other routes of the
 * day are not counted. Those of the recomputed routes may predate the change
 * (e.g. a sharing refused but still planned): the wording stays neutral.
 */
export function relevantViolations(
  response: Pick<PlanResponse, "validation">,
  request: Pick<OptimizeRequest, "trips">,
  vehicleIds: ReadonlySet<string>,
  tripIds: ReadonlySet<string>,
): PlanResponse["validation"]["violations"] {
  const patientOf = new Map(request.trips.map((t) => [t.id, t.patientId]));
  const patients = new Set([...tripIds].flatMap((id) => patientOf.get(id) ?? []));
  return response.validation.violations.filter((v) => {
    if (v.vehicleId !== null && vehicleIds.has(v.vehicleId)) return true;
    if (v.tripId === null) return false;
    if (tripIds.has(v.tripId)) return true;
    const patient = patientOf.get(v.tripId);
    return PATIENT_WIDE_VIOLATIONS.includes(v.code) && patient !== undefined && patients.has(patient);
  });
}

/** A day is under way once a stop is done or a trip picked up: replanBlockReason forbids re-optimizing it. */
export function isDayStarted(
  routes: readonly { stops: readonly Pick<StoredStop, "completedAt">[] }[],
  tripStatuses: readonly TripStatus[],
): boolean {
  return (
    routes.some((route) => route.stops.some((stop) => stop.completedAt !== null)) ||
    tripStatuses.some((status) => FIELD_TRIP_STATUSES.includes(status))
  );
}

export function addOutcomes(a: RefreshOutcome, b: RefreshOutcome): RefreshOutcome {
  return {
    refreshed: a.refreshed + b.refreshed,
    kept: a.kept + b.kept,
    violations: a.violations + b.violations,
    unavailable: a.unavailable || b.unavailable,
    failed: a.failed || b.failed,
    dayStarted: a.dayStarted || b.dayStarted,
  };
}

/**
 * True when the regulator should re-optimize: a route keeps old values or
 * breaks a hard rule, on a day that can still be re-optimized.
 */
export function refreshCallsForReoptimization(outcome: RefreshOutcome): boolean {
  return !outcome.dayStarted && (outcome.kept > 0 || outcome.violations > 0);
}

/**
 * French account of the recomputation for the action's message (facts only),
 * "" when no route was concerned. See refreshAdvice for what to do next.
 */
export function refreshNotice(outcome: RefreshOutcome): string {
  const { refreshed, kept, violations } = outcome;
  const sentences: string[] = [];
  if (refreshed > 0) {
    const what = refreshed === 1 && kept === 0 ? "de la tournée" : `de ${refreshed} tournée${refreshed > 1 ? "s" : ""}`;
    let rules = "";
    if (violations === 1) rules = " ; 1 contrainte n'est pas respectée";
    else if (violations > 1) rules = ` ; ${violations} contraintes ne sont pas respectées`;
    sentences.push(`Horaires et totaux ${what} recalculés${rules}.`);
  }
  if (kept > 0) {
    let what: string;
    if (refreshed > 0) what = kept === 1 ? "d'une autre tournée" : `de ${kept} autres tournées`;
    else what = kept === 1 ? "de la tournée" : `des ${kept} tournées concernées`;
    if (outcome.dayStarted) {
      const why = outcome.unavailable ? " (service d'optimisation indisponible)" : "";
      sentences.push(
        `Les horaires et totaux ${what} n'ont pas pu être recalculés${why} : ils restent ceux du dernier calcul, la journée ayant commencé.`,
      );
    } else if (outcome.unavailable) {
      sentences.push(
        `Les horaires et totaux ${what} seront mis à jour à la prochaine optimisation (service d'optimisation indisponible).`,
      );
    } else if (outcome.failed) {
      sentences.push(`Les horaires et totaux ${what} n'ont pas pu être recalculés : ils seront mis à jour à la prochaine optimisation.`);
    } else {
      sentences.push(`Les horaires et totaux ${what} seront mis à jour à la prochaine optimisation.`);
    }
  }
  return sentences.join(" ");
}

/**
 * What the regulator should do after the recomputation, "" when nothing:
 * re-optimize, or, on a day under way (no re-optimization possible), check
 * the route and tell the driver.
 */
export function refreshAdvice(outcome: RefreshOutcome): string {
  if (outcome.kept === 0 && outcome.violations === 0) return "";
  if (outcome.dayStarted) {
    return outcome.violations > 0 ? "Vérifiez la tournée dans le planning et prévenez le chauffeur." : "Prévenez le chauffeur.";
  }
  return "Réoptimisez le planning.";
}

// ---------------------------------------------------------------------------
// Across a redirect
// ---------------------------------------------------------------------------

/** Query parameter carrying the outcome across the redirect after a form save. */
export const REFRESH_PARAM = "tournees";

const FLAG_UNAVAILABLE = 1;
const FLAG_FAILED = 2;
const FLAG_DAY_STARTED = 4;

/** "refreshed-kept-violations-flags", or null when no route was concerned. */
export function encodeRefresh(outcome: RefreshOutcome): string | null {
  if (outcome.refreshed + outcome.kept === 0) return null;
  const flags =
    (outcome.unavailable ? FLAG_UNAVAILABLE : 0) | (outcome.failed ? FLAG_FAILED : 0) | (outcome.dayStarted ? FLAG_DAY_STARTED : 0);
  return `${outcome.refreshed}-${outcome.kept}-${outcome.violations}-${flags}`;
}

export function decodeRefresh(value: string | null | undefined): RefreshOutcome | null {
  const match = /^(\d{1,4})-(\d{1,4})-(\d{1,4})-([0-7])$/.exec(value ?? "");
  if (!match) return null;
  const [refreshed, kept, violations, flags] = match.slice(1).map(Number) as [number, number, number, number];
  if (refreshed + kept === 0) return null;
  return {
    refreshed,
    kept,
    violations,
    unavailable: (flags & FLAG_UNAVAILABLE) !== 0,
    failed: (flags & FLAG_FAILED) !== 0,
    dayStarted: (flags & FLAG_DAY_STARTED) !== 0,
  };
}

/** `path` with the outcome as query parameter (before the #fragment), unchanged when no route was concerned. */
export function withRefreshNotice(path: string, outcome: RefreshOutcome): string {
  const encoded = encodeRefresh(outcome);
  if (!encoded) return path;
  const [base = path, hash] = path.split("#", 2);
  return `${base}${base.includes("?") ? "&" : "?"}${REFRESH_PARAM}=${encoded}${hash !== undefined ? `#${hash}` : ""}`;
}

// ---------------------------------------------------------------------------
// DB + optimizer
// ---------------------------------------------------------------------------

const storedRouteSelect = {
  id: true,
  vehicleId: true,
  startMinute: true,
  breakStartMinute: true,
  breakEndMinute: true,
  stops: {
    select: {
      id: true,
      tripId: true,
      kind: true,
      sequence: true,
      arrivalMinute: true,
      startMinute: true,
      departureMinute: true,
      completedAt: true,
    },
  },
} satisfies Prisma.RouteSelect;

/** Writes the plan under row locks; returns the routes actually rewritten. */
async function writeRefresh(
  tx: Prisma.TransactionClient,
  snapshot: readonly StoredRoute[],
  response: PlanResponse,
  vehicles: readonly RefreshVehicle[],
  now: Date,
): Promise<RouteRefresh[]> {
  // Same lock as savePlan: a re-optimization or a validation in flight is
  // waited for, and a route it replaced is no longer found. The stops are
  // locked too, so a pick-up or drop-off recorded meanwhile is seen below
  // (the stops done keep their times) or waits for this write.
  const ids = snapshot.map((route) => route.id);
  await tx.$queryRaw`SELECT "id" FROM "Route" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "RouteStop" WHERE "routeId" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`;
  const current = await tx.route.findMany({ where: { id: { in: ids } }, select: storedRouteSelect });
  const before = new Map(snapshot.map((route) => [route.id, route]));
  // The evaluation describes the stops read before the call: a route changed since is left alone.
  const unchanged = current.filter((route) => {
    const read = before.get(route.id);
    return read !== undefined && sameStops(read, route);
  });
  if (unchanged.length === 0) return [];

  const tripIds = [...new Set(unchanged.flatMap((route) => route.stops.map((stop) => stop.tripId)))];
  const trips = await tx.trip.findMany({
    where: { id: { in: tripIds } },
    select: { id: true, status: true, sharingStatus: true, pickupAddress: true, dropoffAddress: true, routeId: true },
  });
  const plan = planRefresh(unchanged, response, vehicles, new Map(trips.map((t) => [t.id, t])), now);

  for (const route of plan.routes) {
    await tx.route.update({ where: { id: route.routeId }, data: route.data });
    for (const stop of route.stops) await tx.routeStop.update({ where: { id: stop.id }, data: stop.data });
  }
  for (const trip of plan.trips) {
    await tx.trip.updateMany({
      where: {
        id: trip.tripId,
        routeId: trip.routeId,
        sharingStatus: trip.sharingStatus,
        status: { notIn: [...OFF_ROUTE_STATUSES] },
      },
      data: trip.data,
    });
  }
  return plan.routes;
}

async function refreshDay(deps: RefreshDeps, isoDate: string, routeIds: ReadonlySet<string>): Promise<RefreshOutcome> {
  const { prisma } = deps;
  const [input, dayRoutes] = await Promise.all([
    loadOptimizeInput(prisma, isoDate),
    prisma.route.findMany({ where: { serviceDate: fromIsoDate(isoDate) }, select: storedRouteSelect }),
  ]);
  const snapshot = dayRoutes.filter((route) => routeIds.has(route.id));
  if (snapshot.length === 0) return NOTHING_REFRESHED; // replaced by a re-optimization meanwhile
  const dayStarted = isDayStarted(dayRoutes, input.trips.map((trip) => trip.status));

  const { request } = buildOptimizeRequest(input);
  const result = await deps.evaluate(buildEvaluateRequest(request, dayRoutes));
  if (!result.ok) {
    const unavailable = result.reason === "unreachable" || result.reason === "timeout";
    console.warn(`[planning] routes of ${isoDate} not recomputed: ${result.error}`);
    return { ...NOTHING_REFRESHED, kept: snapshot.length, unavailable, failed: !unavailable, dayStarted };
  }

  const written = await prisma.$transaction(
    (tx) => writeRefresh(tx, snapshot, result.data, request.vehicles, deps.now ?? new Date()),
    REFRESH_TX_OPTIONS,
  );
  const writtenIds = new Set(written.map((route) => route.routeId));
  const writtenRoutes = snapshot.filter((route) => writtenIds.has(route.id));
  const violations = relevantViolations(
    result.data,
    request,
    new Set(writtenRoutes.map((route) => route.vehicleId)),
    new Set(writtenRoutes.flatMap((route) => route.stops.map((stop) => stop.tripId))),
  );
  if (violations.length > 0) {
    console.warn(
      `[planning] recomputed routes of ${isoDate} break ${violations.length} rule(s): ${violations.map((v) => v.code).join(", ")}`,
    );
  }
  if (written.length < snapshot.length) {
    console.warn(`[planning] ${snapshot.length - written.length} route(s) of ${isoDate} kept their stored times and totals`);
  }
  return {
    refreshed: written.length,
    kept: snapshot.length - written.length,
    violations: violations.length,
    unavailable: false,
    failed: false,
    dayStarted,
  };
}

/**
 * Recomputes `routeIds` (routes trips have just left), date by date, after
 * the detaching transaction has committed. Never throws: a failure keeps the
 * stored values and is reported in the outcome.
 */
export async function refreshRoutes(deps: RefreshDeps, routeIds: Iterable<string>): Promise<RefreshOutcome> {
  const ids = [...new Set(routeIds)];
  if (ids.length === 0) return NOTHING_REFRESHED;

  let routes: { id: string; serviceDate: Date }[];
  try {
    routes = await deps.prisma.route.findMany({ where: { id: { in: ids } }, select: { id: true, serviceDate: true } });
  } catch (error) {
    console.error("[planning] reading the routes to recompute failed", error);
    return { ...NOTHING_REFRESHED, kept: ids.length, failed: true };
  }

  const byDate = new Map<string, Set<string>>();
  for (const route of routes) {
    const isoDate = toIsoDate(route.serviceDate);
    const set = byDate.get(isoDate);
    if (set) set.add(route.id);
    else byDate.set(isoDate, new Set([route.id]));
  }

  let outcome = NOTHING_REFRESHED;
  for (const [isoDate, dayIds] of [...byDate].sort(([a], [b]) => a.localeCompare(b))) {
    // An optimizer that could not be reached for one date is not called again for the next ones.
    if (outcome.unavailable) {
      outcome = addOutcomes(outcome, { ...NOTHING_REFRESHED, kept: dayIds.size });
      continue;
    }
    try {
      outcome = addOutcomes(outcome, await refreshDay(deps, isoDate, dayIds));
    } catch (error) {
      console.error(`[planning] recomputing the routes of ${isoDate} failed`, error);
      outcome = addOutcomes(outcome, { ...NOTHING_REFRESHED, kept: dayIds.size, failed: true });
    }
  }
  return outcome;
}
