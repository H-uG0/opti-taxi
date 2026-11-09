/**
 * Saves an optimizer PlanResponse as the routes of a service date.
 *
 * The mapping (which stops, which statuses, sharing traceability) lives in
 * pure functions that are unit-tested; `savePlan` only runs the writes, in
 * one transaction. The Prisma client is a parameter: no server-only import.
 */
import type { Prisma, PrismaClient, SharingStatus, StopKind, TripStatus, VehicleType } from "@prisma/client";
import { lockPlanningDay } from "@/lib/planning/day-lock";
import {
  comparePlans,
  isDrivable,
  planFigures,
  snapshotOf,
  type PlanComparison,
  type TodayCrew,
} from "@/lib/planning/plan-compare";
import { loadPlanVersion } from "@/lib/planning/version";
import { formatLongDate, fromIsoDate } from "@/lib/time";
import type { OptimizeRequest, PlanResponse } from "./contract";
import { readRunDetails, runDetailsJson, type LockChange, type RunKind } from "./run-details";

/** Statuses set by the field (driver) or by cancellation: the planner never overwrites them. */
const FROZEN_STATUSES: readonly TripStatus[] = ["PICKED_UP", "DROPPED_OFF", "CANCELLED", "NO_SHOW"];
/** Trips in these statuses are not put in a route any more (cancelled while the solver ran). */
const OFF_ROUTE_STATUSES: readonly TripStatus[] = ["CANCELLED", "NO_SHOW"];
/** Statuses recorded by the crew during the day. */
export const FIELD_TRIP_STATUSES: readonly TripStatus[] = ["PICKED_UP", "DROPPED_OFF"];

export type CurrentTrip = {
  id: string;
  status: TripStatus;
  sharingStatus: SharingStatus;
  pickupAddress: string;
  dropoffAddress: string;
};

export type VehicleCrew = {
  id: string;
  type: VehicleType;
  defaultDriverId: string | null;
  defaultCrewMateId: string | null;
};

// ---------------------------------------------------------------------------
// Re-planning guard
// ---------------------------------------------------------------------------

/** What, in the database, forbids replacing the routes of a date. */
export type ReplanState = {
  /** Routes of the date in VALIDATED status. */
  validatedRoutes: number;
  /** Trips of the date picked up or dropped off by the crew. */
  startedTrips: number;
  /** Route stops of the date with a field timestamp (completedAt). */
  completedStops: number;
};

/**
 * Why the routes of isoDate cannot be replaced, or null. Deleting the routes
 * would discard a validated planning, or the drivers' pick-up / drop-off
 * timestamps (stops cascade).
 */
export function replanBlockReason(isoDate: string, state: ReplanState): string | null {
  if (state.validatedRoutes > 0) {
    return `Le planning du ${formatLongDate(isoDate)} est validé : rouvrez-le avant de le modifier.`;
  }
  if (state.startedTrips > 0 || state.completedStops > 0) {
    return "La journée a commencé (courses déjà prises en charge) : la réoptimisation en cours de journée n'est pas disponible dans cette version.";
  }
  return null;
}

/** Thrown inside the savePlan transaction when the date changed while the solver ran. */
export class PlanBlockedError extends Error {
  constructor(reason: string) {
    super(`Calcul non enregistré, le planning a changé pendant l'optimisation. ${reason}`);
    this.name = "PlanBlockedError";
  }
}

export type StopRow = {
  sequence: number;
  tripId: string;
  kind: StopKind;
  lat: number;
  lng: number;
  address: string;
  arrivalMinute: number;
  startMinute: number;
  departureMinute: number;
  loadAfter: number;
};

export type RouteRow = {
  vehicleId: string;
  driverId: string | null;
  crewMateId: string | null;
  startMinute: number;
  endMinute: number;
  distanceKm: number;
  emptyKm: number;
  revenue: number;
  cost: number;
  margin: number;
  breakStartMinute: number | null;
  breakEndMinute: number | null;
  stops: StopRow[];
};

export type TripUpdate = {
  tripId: string;
  /** Vehicle whose route serves the trip, null when unassigned. */
  vehicleId: string | null;
  data: {
    status: TripStatus;
    plannedPickupMinute: number | null;
    plannedDropoffMinute: number | null;
    shared: boolean;
    directKm: number | null;
    detourKm: number | null;
    estimatedRevenue: number | null;
    sharingStatus?: SharingStatus;
    sharingProposedAt?: Date | null;
  };
};

export type RunSummary = {
  tripsCount: number;
  lockedCount: number;
  unassignedCount: number;
  objective: number | null;
  wallTimeMs: number;
  matrixSource: string;
  valid: boolean;
  kpis: PlanResponse["kpis"];
};

/**
 * Routes to create. Stops of trips that vanished or were cancelled while the
 * solver ran are dropped (and the sequence renumbered); routes left without
 * stops, unknown vehicles and duplicate vehicles are skipped.
 */
export function planRoutes(
  response: Pick<PlanResponse, "routes">,
  vehicles: ReadonlyMap<string, VehicleCrew>,
  trips: ReadonlyMap<string, CurrentTrip>,
): RouteRow[] {
  const rows: RouteRow[] = [];
  const seen = new Set<string>();
  for (const route of response.routes) {
    const vehicle = vehicles.get(route.vehicleId);
    if (!vehicle || seen.has(route.vehicleId)) continue;
    const stops: StopRow[] = [];
    for (const stop of route.stops) {
      const trip = trips.get(stop.tripId);
      if (!trip || OFF_ROUTE_STATUSES.includes(trip.status)) continue;
      stops.push({
        sequence: stops.length,
        tripId: stop.tripId,
        kind: stop.kind,
        lat: stop.location.lat,
        lng: stop.location.lng,
        address: stop.kind === "PICKUP" ? trip.pickupAddress : trip.dropoffAddress,
        arrivalMinute: stop.arrivalMin,
        startMinute: stop.startMin,
        departureMinute: stop.departureMin,
        loadAfter: stop.loadAfter,
      });
    }
    if (stops.length === 0) continue;
    seen.add(route.vehicleId);
    rows.push({
      vehicleId: route.vehicleId,
      driverId: vehicle.defaultDriverId,
      // Only an ambulance has a crew of two (a crew mate gets access to the route's roadmap).
      crewMateId: vehicle.type === "AMBULANCE" ? vehicle.defaultCrewMateId : null,
      startMinute: route.startMin,
      endMinute: route.endMin,
      distanceKm: route.distanceKm,
      emptyKm: route.emptyKm,
      revenue: route.revenue,
      cost: route.cost,
      margin: route.margin,
      breakStartMinute: route.break?.startMin ?? null,
      breakEndMinute: route.break?.endMin ?? null,
      stops,
    });
  }
  return rows;
}

/** Trip status after planning: field and cancellation statuses are never touched. */
export function nextTripStatus(current: TripStatus, served: boolean): TripStatus {
  if (FROZEN_STATUSES.includes(current)) return current;
  return served ? "ASSIGNED" : "PLANNED";
}

/**
 * Sharing traceability (décret 2025-202): a newly shared trip becomes
 * PROPOSED (timestamped); a proposal that is no longer shared is withdrawn.
 * ACCEPTED, REFUSED and NOT_ELIGIBLE are the patient's / prescription's word
 * and stay as they are. Returns null when nothing changes.
 */
export function nextSharingState(
  current: SharingStatus,
  servedAndShared: boolean,
  now: Date,
): { sharingStatus: SharingStatus; sharingProposedAt: Date | null } | null {
  if (servedAndShared && current === "NOT_PROPOSED") return { sharingStatus: "PROPOSED", sharingProposedAt: now };
  if (!servedAndShared && current === "PROPOSED") return { sharingStatus: "NOT_PROPOSED", sharingProposedAt: null };
  return null;
}

/** Vehicle serving each trip according to the routes that will be saved. */
export function servingVehicles(routes: RouteRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const route of routes) for (const stop of route.stops) map.set(stop.tripId, route.vehicleId);
  return map;
}

/** Updates of every request trip that still exists and is not cancelled. */
export function planTripUpdates(
  requestTripIds: readonly string[],
  response: Pick<PlanResponse, "trips">,
  routes: RouteRow[],
  current: ReadonlyMap<string, CurrentTrip>,
  now: Date,
): TripUpdate[] {
  const results = new Map(response.trips.map((t) => [t.tripId, t]));
  const serving = servingVehicles(routes);
  const updates: TripUpdate[] = [];

  for (const tripId of requestTripIds) {
    const trip = current.get(tripId);
    if (!trip || OFF_ROUTE_STATUSES.includes(trip.status)) continue;
    const result = results.get(tripId);
    const vehicleId = serving.get(tripId) ?? null;
    const served = vehicleId !== null && result !== undefined;
    const shared = served && result.shared;

    const update: TripUpdate = {
      tripId,
      vehicleId: served ? vehicleId : null,
      data: {
        status: nextTripStatus(trip.status, served),
        plannedPickupMinute: served ? result.pickupMin : null,
        plannedDropoffMinute: served ? result.dropoffMin : null,
        shared,
        directKm: result?.directKm ?? null,
        detourKm: served ? result.detourKm : null,
        estimatedRevenue: served ? result.revenue : null,
      },
    };
    const sharing = nextSharingState(trip.sharingStatus, shared, now);
    if (sharing) Object.assign(update.data, sharing);
    updates.push(update);
  }
  return updates;
}

export function summarizeRun(request: OptimizeRequest, response: PlanResponse): RunSummary {
  return {
    tripsCount: request.trips.length,
    lockedCount: request.trips.filter((t) => t.lockedVehicleId).length,
    unassignedCount: response.unassigned.length,
    objective: response.meta.objective,
    wallTimeMs: response.meta.wallTimeMs,
    matrixSource: response.meta.matrixSource,
    valid: response.validation.valid,
    kpis: response.kpis,
  };
}

// ---------------------------------------------------------------------------
// DB writes
// ---------------------------------------------------------------------------

export type SavePlanResult = { routes: number; served: number; unassigned: number; comparison: PlanComparison };

/** What savePlan's guard is given, inside its transaction, before anything is replaced. */
export type SavePlanCheck = {
  tx: Prisma.TransactionClient;
  /** The new plan against the routes in place (lib/planning/plan-compare.ts). */
  comparison: PlanComparison;
  /** Version of the routes in place (lib/planning/version.ts). */
  version: string;
};

/**
 * The routes in place, read under savePlan's locks: their figures, the trips
 * they serve, and the violations last known for them (the latest successful
 * run, kept up to date by /evaluate after a trip left a route). Only the
 * routes that can still be driven as saved count (isDrivable: same vehicle
 * and crew as today's request); the others are reported apart (undrivable).
 * `routes` keeps them all: the snapshot for « Revenir au planning précédent ».
 */
async function readPlanInPlace(tx: Prisma.TransactionClient, serviceDate: Date, todayCrews: ReadonlyMap<string, TodayCrew>) {
  const [routes, served, planRun] = await Promise.all([
    tx.route.findMany({
      where: { serviceDate },
      select: {
        id: true,
        vehicleId: true,
        driverId: true,
        crewMateId: true,
        revenue: true,
        margin: true,
        distanceKm: true,
        optimizationRunId: true,
        vehicle: { select: { label: true } },
        stops: { select: { tripId: true, kind: true, sequence: true } },
      },
    }),
    tx.trip.findMany({
      where: { serviceDate, routeId: { not: null }, status: { notIn: [...OFF_ROUTE_STATUSES] } },
      select: { id: true, routeId: true },
    }),
    tx.optimizationRun.findFirst({
      where: { serviceDate, status: "SUCCESS" },
      orderBy: { startedAt: "desc" },
      select: { id: true, valid: true, details: true, kpis: true },
    }),
  ]);
  if (routes.length === 0) return null;
  const details = planRun ? readRunDetails(planRun) : null;
  const violations = details ? details.violations.length : planRun?.valid === false ? null : 0;
  const drivable = routes.filter((route) => isDrivable(route, todayCrews));
  const drivableIds = new Set(drivable.map((route) => route.id));
  const servedTripIds = served.filter((t) => t.routeId !== null && drivableIds.has(t.routeId)).map((t) => t.id);
  const undrivable = routes.filter((route) => !drivableIds.has(route.id));
  return {
    routes,
    servedTripIds,
    figures: planFigures(drivable, servedTripIds.length, violations),
    undrivable: {
      vehicles: undrivable.map((route) => route.vehicle?.label ?? "Véhicule supprimé"),
      trips: served.length - servedTripIds.length,
    },
    runId: planRun?.id ?? routes[0]?.optimizationRunId ?? null,
  };
}

/**
 * Re-reads, under row locks, what forbids replacing the routes of the date.
 * The routes and stops of the date are locked FOR UPDATE: a validation or a
 * driver's pick-up committed while the solver ran is seen here, and one in
 * flight waits for this transaction (and then finds its stop gone).
 */
async function lockReplanState(tx: Prisma.TransactionClient, isoDate: string, serviceDate: Date): Promise<ReplanState> {
  const routes = await tx.$queryRaw<Array<{ status: string }>>`
    SELECT "status"::text AS "status" FROM "Route" WHERE "serviceDate" = ${isoDate}::date FOR UPDATE`;
  const stops = await tx.$queryRaw<Array<{ completed: boolean }>>`
    SELECT (rs."completedAt" IS NOT NULL) AS "completed"
    FROM "RouteStop" rs JOIN "Route" r ON r."id" = rs."routeId"
    WHERE r."serviceDate" = ${isoDate}::date
    FOR UPDATE OF rs`;
  const startedTrips = await tx.trip.count({ where: { serviceDate, status: { in: [...FIELD_TRIP_STATUSES] } } });
  return {
    validatedRoutes: routes.filter((r) => r.status === "VALIDATED").length,
    startedTrips,
    completedStops: stops.filter((s) => s.completed).length,
  };
}

/**
 * Replaces the routes of `isoDate` with the plan and marks run `runId` as
 * SUCCESS, all in one transaction, under the planning lock of the date.
 * Throws PlanBlockedError (nothing written) when the date was validated or
 * started while the solver ran. Before replacing anything, the new plan is
 * compared with the routes in place and `check` may refuse it by throwing
 * (lib/planning/plan-compare.ts: worse or invalid plans wait for the
 * regulator). The stop sequences replaced are kept in the run's details
 * (previous), for « Revenir au planning précédent ».
 */
export async function savePlan(
  prisma: PrismaClient,
  args: {
    runId: string;
    isoDate: string;
    request: OptimizeRequest;
    response: PlanResponse;
    /** Crew sent with each vehicle (BuildResult.crews); without it, the vehicle's default crew. */
    crews?: ReadonlyMap<string, { driverId: string; crewMateId: string | null }>;
    kind?: RunKind;
    /** End of the computation (a plan confirmed later keeps its own); now by default. */
    finishedAt?: Date;
    /** Throws to keep the routes in place (nothing written). */
    check?: (context: SavePlanCheck) => Promise<void> | void;
    /** The trip lock changed with this plan, kept in the run's details (restoring the plan replaced undoes it). */
    lockChange?: LockChange;
    now?: Date;
  },
): Promise<SavePlanResult> {
  const { runId, isoDate, request, response } = args;
  const now = args.now ?? new Date();
  const serviceDate = fromIsoDate(isoDate);
  const tripIds = request.trips.map((t) => t.id);

  return prisma.$transaction(
    async (tx) => {
      // Serialized with the creation of runs and the validation of the date (day-lock.ts).
      await lockPlanningDay(tx, isoDate);
      const blocker = replanBlockReason(isoDate, await lockReplanState(tx, isoDate, serviceDate));
      if (blocker) throw new PlanBlockedError(blocker);

      const [currentTrips, vehicles] = await Promise.all([
        tx.trip.findMany({
          where: { id: { in: tripIds } },
          select: { id: true, status: true, sharingStatus: true, pickupAddress: true, dropoffAddress: true },
        }),
        tx.vehicle.findMany({
          where: { id: { in: request.vehicles.map((v) => v.id) } },
          select: { id: true, type: true, defaultDriverId: true, defaultCrewMateId: true },
        }),
      ]);
      const current = new Map(currentTrips.map((t) => [t.id, t]));
      // The route gets the crew the optimizer planned with: the crew of the day.
      const crewed = vehicles.map((v) => {
        const crew = args.crews?.get(v.id);
        return crew ? { ...v, defaultDriverId: crew.driverId, defaultCrewMateId: crew.crewMateId } : v;
      });
      // The crew a new route of each vehicle gets: a route in place saved with another one can no longer be driven.
      const todayCrews = new Map<string, TodayCrew>(
        crewed.map((v) => [
          v.id,
          v.type === "AMBULANCE" ? { driverId: v.defaultDriverId, crewMateId: v.defaultCrewMateId } : { driverId: v.defaultDriverId },
        ]),
      );
      const inPlace = await readPlanInPlace(tx, serviceDate, todayCrews);
      const routes = planRoutes(response, new Map(crewed.map((v) => [v.id, v])), current);
      const updates = planTripUpdates(tripIds, response, routes, current, now);
      const servedTripIds = updates.filter((u) => u.vehicleId !== null).map((u) => u.tripId);
      const comparison = comparePlans(inPlace, {
        figures: planFigures(routes, servedTripIds.length, response.validation.violations.length),
        servedTripIds,
      });
      await args.check?.({ tx, comparison, version: await loadPlanVersion(tx, isoDate) });

      // Stops cascade; trips keep their row but lose routeId (onDelete: SetNull).
      await tx.route.deleteMany({ where: { serviceDate } });

      const routeIdByVehicle = new Map<string, string>();
      for (const { stops, ...route } of routes) {
        const created = await tx.route.create({
          data: {
            ...route,
            serviceDate,
            status: "PROPOSED",
            optimizationRunId: runId,
            // Traffic calibration compares the stored times with real ones, source by source.
            matrixSource: response.meta.matrixSource,
            stops: { createMany: { data: stops } },
          },
          select: { id: true },
        });
        routeIdByVehicle.set(route.vehicleId, created.id);
      }

      for (const { tripId, vehicleId, data } of updates) {
        await tx.trip.update({
          where: { id: tripId },
          data: { ...data, routeId: vehicleId ? (routeIdByVehicle.get(vehicleId) ?? null) : null },
        });
      }

      // Trips of the day left out of the request (incomplete data) cannot stay "planned".
      await tx.trip.updateMany({
        where: { serviceDate, status: "ASSIGNED", id: { notIn: tripIds } },
        data: { status: "PLANNED", plannedPickupMinute: null, plannedDropoffMinute: null, shared: false },
      });

      const summary = summarizeRun(request, response);
      await tx.optimizationRun.update({
        where: { id: runId },
        data: {
          status: "SUCCESS",
          finishedAt: args.finishedAt ?? new Date(),
          error: null,
          // kpis: exactly the optimizer KPIs (PlanResponse.kpis).
          ...summary,
          // Solver status, violation list, warnings and unassigned reasons (see run-details.ts), the
          // comparison with the routes replaced and their stop sequences.
          details: runDetailsJson(response, {
            kind: args.kind,
            comparison,
            previous: inPlace ? snapshotOf(inPlace.runId, inPlace.routes, inPlace.figures) : undefined,
            lockChange: args.lockChange,
          }),
        },
      });

      // OSRM put into service: the traffic factors were set on straight-line times until now, the
      // calibration starts over (lib/domain/traffic-observed.ts only counts routes of one source anyway).
      if (response.meta.matrixSource === "osrm") {
        const earlier = await tx.optimizationRun.count({ where: { matrixSource: "osrm", status: "SUCCESS", id: { not: runId } } });
        if (earlier === 0) await tx.appSettings.updateMany({ where: { id: 1 }, data: { trafficChangedAt: new Date() } });
      }

      const served = servedTripIds.length;
      return { routes: routes.length, served, unassigned: updates.length - served, comparison };
    },
    { maxWait: 15_000, timeout: 60_000 },
  );
}
