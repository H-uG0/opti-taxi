/**
 * Loads the rows the dashboard indicators are computed from, for a date range
 * or a list of dates, in five queries: routes (with their stop count and
 * vehicle), stops (planned times and the crews' timestamps), every trip of the
 * dates (not only the served ones: the demand counts them all), optimization
 * runs and frozen validated plans. The computation itself is in @/lib/kpis.
 *
 * Shared by /tableau-de-bord (app/(regulator)/tableau-de-bord/load-kpis.ts,
 * with the app's client), the validation that freezes a plan
 * (lib/kpis-plan-store.ts, with the transaction's) and the history script
 * (prisma/history.ts, with its own): the client is passed in, nothing here is
 * server-only. The row mapping (toKpiData) is pure and unit-tested.
 *
 * Health data: ids, statuses, minutes, instants and amounts only; never a
 * name, an address or a note.
 */
import type { Prisma, PrismaClient, TripDirection, VehicleType } from "@prisma/client";
import { decodeFrozenPlan } from "@/lib/kpis-plan";
import { PLANNING_ACTIONS } from "@/lib/kpis-planning-time";
import type { KpiActivity, KpiData, KpiRoute, KpiStopRow, KpiTrip } from "@/lib/kpis-rows";
import { isExceptionalAmbulanceTrip } from "@/lib/planning/exceptional-ambulance";
import { isSimulatedId } from "@/lib/simulated";
import { fromIsoDate, toIsoDate } from "@/lib/time";

/** The models the loader reads. */
export type KpiClient = Pick<PrismaClient, "route" | "routeStop" | "trip" | "optimizationRun" | "validatedPlan">;

/** A range of dates (both included) or a list of dates (comparison days). */
export type KpiDates = { from: string; to: string } | { dates: readonly string[] };

export function serviceDateFilter(dates: KpiDates): Prisma.DateTimeFilter {
  return "dates" in dates ? { in: dates.dates.map(fromIsoDate) } : { gte: fromIsoDate(dates.from), lte: fromIsoDate(dates.to) };
}

const tripSelect = {
  id: true,
  serviceDate: true,
  status: true,
  routeId: true,
  direction: true,
  shared: true,
  appointmentMinute: true,
  readyMinute: true,
  plannedPickupMinute: true,
  plannedDropoffMinute: true,
  patientId: true,
  recurrenceId: true,
  facilityId: true,
  payer: true,
  allowedVehicleTypes: true,
  sharingAllowed: true,
  sharingStatus: true,
  sharingProposedAt: true,
  sharingRespondedAt: true,
  directKm: true,
  detourKm: true,
  estimatedRevenue: true,
  cancellationReason: true,
  cancelledAt: true,
  exceptionalAmbulanceAt: true,
  lockedVehicleId: true,
} as const satisfies Prisma.TripSelect;

/** Rows as the queries return them. */
export type KpiQueryRows = {
  routes: (Omit<
    KpiRoute,
    | "id"
    | "serviceDate"
    | "stopCount"
    | "hasRecordedStatus"
    | "vehicleType"
    | "depotId"
    | "activeMinutes"
    | "paidMinutes"
    | "onboardMinutes"
    | "facilityWaitMinutes"
  > & {
    id: string;
    serviceDate: Date;
    _count: { stops: number };
    vehicle?: { type: VehicleType; depotId: string } | null;
    startMinute?: number;
    endMinute?: number;
    breakStartMinute?: number | null;
    breakEndMinute?: number | null;
  })[];
  stops: KpiStopRow[];
  trips: Prisma.TripGetPayload<{ select: typeof tripSelect }>[];
  runs: { id: string; serviceDate: Date; startedAt: Date; requestedById?: string | null }[];
  plans?: { serviceDate: Date; validatedAt: Date; figures: Prisma.JsonValue }[];
};

const routeSelect = {
  id: true,
  serviceDate: true,
  vehicleId: true,
  driverId: true,
  crewMateId: true,
  startMinute: true,
  endMinute: true,
  breakStartMinute: true,
  breakEndMinute: true,
  distanceKm: true,
  emptyKm: true,
  revenue: true,
  cost: true,
  margin: true,
  validatedAt: true,
  matrixSource: true,
  _count: { select: { stops: true } },
  vehicle: { select: { type: true, depotId: true } },
} as const satisfies Prisma.RouteSelect;

const stopSelect = {
  routeId: true,
  tripId: true,
  kind: true,
  sequence: true,
  arrivalMinute: true,
  startMinute: true,
  departureMinute: true,
  loadAfter: true,
  completedAt: true,
} as const satisfies Prisma.RouteStopSelect;

export async function loadKpiRows(prisma: KpiClient, dates: KpiDates): Promise<KpiData> {
  const serviceDate = serviceDateFilter(dates);
  const [routes, stops, trips, runs, plans] = await Promise.all([
    prisma.route.findMany({ where: { serviceDate }, select: routeSelect }),
    prisma.routeStop.findMany({ where: { route: { serviceDate } }, select: stopSelect }),
    prisma.trip.findMany({ where: { serviceDate }, select: tripSelect }),
    prisma.optimizationRun.findMany({ where: { serviceDate }, select: { id: true, serviceDate: true, startedAt: true, requestedById: true } }),
    prisma.validatedPlan.findMany({ where: { serviceDate }, select: { serviceDate: true, validatedAt: true, figures: true } }),
  ]);
  return toKpiData({ routes, stops, trips, runs, plans });
}

/**
 * The routes of one vehicle or one person (driver or crew mate) and the trips
 * placed on them, for the statistics of a record (/vehicules/[id],
 * /chauffeurs/[id]): the same rows as the dashboard, without the trips left
 * aside, the runs nor the frozen plans (a record shows what its routes did).
 */
export async function loadRouteKpiRows(
  prisma: Pick<PrismaClient, "route" | "routeStop" | "trip">,
  dates: KpiDates,
  owner: { vehicleId: string } | { personId: string },
): Promise<KpiData> {
  const serviceDate = serviceDateFilter(dates);
  const routeWhere: Prisma.RouteWhereInput =
    "vehicleId" in owner
      ? { serviceDate, vehicleId: owner.vehicleId }
      : { serviceDate, OR: [{ driverId: owner.personId }, { crewMateId: owner.personId }] };
  const [routes, stops, trips] = await Promise.all([
    prisma.route.findMany({ where: routeWhere, select: routeSelect }),
    prisma.routeStop.findMany({ where: { route: routeWhere }, select: stopSelect }),
    prisma.trip.findMany({ where: { serviceDate, route: routeWhere }, select: tripSelect }),
  ]);
  return toKpiData({ routes, stops, trips, runs: [] });
}

/**
 * The regulators' planning actions on the dates (audit trail, one query on
 * its service-date index): the planning time of each date (KPI-06,
 * kpis-planning-time.ts). Actions and instants only, never the details.
 */
export async function loadPlanningActivity(prisma: Pick<PrismaClient, "auditEvent">, dates: KpiDates): Promise<KpiActivity[]> {
  const rows = await prisma.auditEvent.findMany({
    where: { serviceDate: serviceDateFilter(dates), role: "REGULATOR", action: { in: [...PLANNING_ACTIONS] } },
    select: { serviceDate: true, at: true, action: true, userId: true },
  });
  return rows.flatMap((row) => (row.serviceDate ? [{ serviceDate: toIsoDate(row.serviceDate), at: row.at, action: row.action, userId: row.userId }] : []));
}

/** Stop rows of one route as routeTimings reads them. */
export type TimedStop = Pick<KpiStopRow, "tripId" | "kind" | "startMinute" | "departureMinute"> & {
  sequence: number;
  arrivalMinute: number;
  loadAfter: number;
};

/**
 * Planned time of a route (KPI-10): its minutes (end - start, the break taken
 * out), those the optimizer charges at the hourly cost (end - start, the
 * break included: services/optimizer plan.py), the minutes with a patient on board (from leaving a stop with a load
 * to the start of the next stop, waits with a patient included) and the
 * minutes the vehicle waits at a place of care before a stop there starts
 * (drop-off of an outbound trip, pickup of a return: the end of a session).
 * Pure.
 */
export function routeTimings(
  route: { startMinute?: number; endMinute?: number; breakStartMinute?: number | null; breakEndMinute?: number | null },
  stops: readonly TimedStop[],
  directionOf: (tripId: string) => TripDirection | undefined,
): { activeMinutes?: number; paidMinutes?: number; onboardMinutes: number; facilityWaitMinutes: number } {
  const sorted = [...stops].sort((a, b) => a.sequence - b.sequence);
  let onboardMinutes = 0;
  let facilityWaitMinutes = 0;
  sorted.forEach((stop, index) => {
    const next = sorted[index + 1];
    if (next && stop.loadAfter > 0) onboardMinutes += Math.max(0, next.startMinute - stop.departureMinute);
    const direction = directionOf(stop.tripId);
    const atFacility = (stop.kind === "DROPOFF" && direction === "OUTBOUND") || (stop.kind === "PICKUP" && direction === "RETURN");
    if (atFacility) facilityWaitMinutes += Math.max(0, stop.startMinute - stop.arrivalMinute);
  });
  if (route.startMinute === undefined || route.endMinute === undefined) return { onboardMinutes, facilityWaitMinutes };
  const pause =
    route.breakStartMinute !== null && route.breakStartMinute !== undefined && route.breakEndMinute !== null && route.breakEndMinute !== undefined
      ? Math.max(0, route.breakEndMinute - route.breakStartMinute)
      : 0;
  const paidMinutes = Math.max(0, route.endMinute - route.startMinute);
  return { activeMinutes: Math.max(0, paidMinutes - pause), paidMinutes, onboardMinutes, facilityWaitMinutes };
}

type TripTimes = {
  pickupAt: Date | null;
  dropoffAt: Date | null;
  pickupService: number | null;
  pickupDeparture: number | null;
  dropoffStart: number | null;
};

function latest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return b > a ? b : a;
}

/** Maps the query rows to the input of @/lib/kpis (service dates as "YYYY-MM-DD"). */
export function toKpiData({ routes, stops, trips, runs, plans = [] }: KpiQueryRows): KpiData {
  const recordedRouteIds = new Set(stops.filter((s) => s.completedAt !== null).map((s) => s.routeId));
  const vehicleOfRoute = new Map(routes.map((r) => [r.id, { vehicleId: r.vehicleId, type: r.vehicle?.type }]));

  // The stops of each trip on its current route: the crews' timestamps and the planned times.
  const routeOfTrip = new Map(trips.map((t) => [t.id, t.routeId]));
  const times = new Map<string, TripTimes>();
  for (const stop of stops) {
    if (routeOfTrip.get(stop.tripId) !== stop.routeId) continue;
    const entry = times.get(stop.tripId) ?? { pickupAt: null, dropoffAt: null, pickupService: null, pickupDeparture: null, dropoffStart: null };
    if (stop.kind === "PICKUP") {
      entry.pickupAt = latest(entry.pickupAt, stop.completedAt);
      entry.pickupService = stop.departureMinute - stop.startMinute;
      entry.pickupDeparture = stop.departureMinute;
    } else {
      entry.dropoffAt = latest(entry.dropoffAt, stop.completedAt);
      entry.dropoffStart = stop.startMinute;
    }
    times.set(stop.tripId, entry);
  }

  const directionOf = new Map(trips.map((t) => [t.id, t.direction]));
  const stopsOfRoute = new Map<string, TimedStop[]>();
  for (const stop of stops) {
    if (stop.sequence === undefined || stop.arrivalMinute === undefined || stop.loadAfter === undefined) continue;
    const timed: TimedStop = { ...stop, sequence: stop.sequence, arrivalMinute: stop.arrivalMinute, loadAfter: stop.loadAfter };
    const list = stopsOfRoute.get(stop.routeId);
    if (list) list.push(timed);
    else stopsOfRoute.set(stop.routeId, [timed]);
  }

  return {
    routes: routes.map(({ _count, serviceDate: date, vehicle, startMinute, endMinute, breakStartMinute, breakEndMinute, ...route }) => {
      const timed = stopsOfRoute.get(route.id);
      const timings = timed ? routeTimings({ startMinute, endMinute, breakStartMinute, breakEndMinute }, timed, (id) => directionOf.get(id)) : null;
      return {
        ...route,
        serviceDate: toIsoDate(date),
        vehicleType: vehicle?.type,
        depotId: vehicle?.depotId ?? null,
        stopCount: _count.stops,
        hasRecordedStatus: recordedRouteIds.has(route.id),
        ...(timings ?? {}),
      };
    }),
    trips: trips.map(({ serviceDate: date, exceptionalAmbulanceAt, lockedVehicleId, ...trip }): KpiTrip => {
      const own = times.get(trip.id);
      const route = trip.routeId ? vehicleOfRoute.get(trip.routeId) : undefined;
      return {
        ...trip,
        serviceDate: toIsoDate(date),
        // The same rule as billing and the planning (isExceptionalAmbulanceTrip): served by the ambulance it is still locked on.
        exceptionalAmbulance: isExceptionalAmbulanceTrip(
          { exceptionalAmbulanceAt, lockedVehicleId: lockedVehicleId ?? null, allowedVehicleTypes: trip.allowedVehicleTypes },
          (id) => (route && id === route.vehicleId ? route.type : undefined),
        ),
        pickupCompletedAt: own?.pickupAt ?? null,
        dropoffCompletedAt: own?.dropoffAt ?? null,
        pickupServiceMinutes: own?.pickupService ?? null,
        plannedRideMinutes:
          own && own.pickupDeparture !== null && own.dropoffStart !== null ? own.dropoffStart - own.pickupDeparture : null,
      };
    }),
    // A run of the history simulation marks its day « simulé » (ids "hist-", lib/simulated.ts).
    runs: runs.map((run) => ({
      serviceDate: toIsoDate(run.serviceDate),
      startedAt: run.startedAt,
      simulated: isSimulatedId(run.id),
      ...(run.requestedById !== undefined ? { requestedById: run.requestedById } : {}),
    })),
    plans: plans.flatMap((plan) => {
      const decoded = decodeFrozenPlan({ serviceDate: toIsoDate(plan.serviceDate), validatedAt: plan.validatedAt, figures: plan.figures });
      return decoded ? [decoded] : [];
    }),
  };
}
