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
import type { Prisma, PrismaClient, VehicleType } from "@prisma/client";
import { decodeFrozenPlan } from "@/lib/kpis-plan";
import type { KpiData, KpiRoute, KpiStopRow, KpiTrip } from "@/lib/kpis-rows";
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
  routes: (Omit<KpiRoute, "id" | "serviceDate" | "stopCount" | "hasRecordedStatus" | "vehicleType" | "depotId"> & {
    id: string;
    serviceDate: Date;
    _count: { stops: number };
    vehicle?: { type: VehicleType; depotId: string } | null;
  })[];
  stops: KpiStopRow[];
  trips: Prisma.TripGetPayload<{ select: typeof tripSelect }>[];
  runs: { id: string; serviceDate: Date; startedAt: Date }[];
  plans?: { serviceDate: Date; validatedAt: Date; figures: Prisma.JsonValue }[];
};

export async function loadKpiRows(prisma: KpiClient, dates: KpiDates): Promise<KpiData> {
  const serviceDate = serviceDateFilter(dates);
  const [routes, stops, trips, runs, plans] = await Promise.all([
    prisma.route.findMany({
      where: { serviceDate },
      select: {
        id: true,
        serviceDate: true,
        vehicleId: true,
        driverId: true,
        distanceKm: true,
        emptyKm: true,
        revenue: true,
        cost: true,
        margin: true,
        validatedAt: true,
        matrixSource: true,
        _count: { select: { stops: true } },
        vehicle: { select: { type: true, depotId: true } },
      },
    }),
    prisma.routeStop.findMany({
      where: { route: { serviceDate } },
      select: { routeId: true, tripId: true, kind: true, startMinute: true, departureMinute: true, completedAt: true },
    }),
    prisma.trip.findMany({ where: { serviceDate }, select: tripSelect }),
    prisma.optimizationRun.findMany({ where: { serviceDate }, select: { id: true, serviceDate: true, startedAt: true } }),
    prisma.validatedPlan.findMany({ where: { serviceDate }, select: { serviceDate: true, validatedAt: true, figures: true } }),
  ]);
  return toKpiData({ routes, stops, trips, runs, plans });
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

  return {
    routes: routes.map(({ _count, serviceDate: date, vehicle, ...route }) => ({
      ...route,
      serviceDate: toIsoDate(date),
      vehicleType: vehicle?.type,
      depotId: vehicle?.depotId ?? null,
      stopCount: _count.stops,
      hasRecordedStatus: recordedRouteIds.has(route.id),
    })),
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
    runs: runs.map((run) => ({ serviceDate: toIsoDate(run.serviceDate), startedAt: run.startedAt, simulated: isSimulatedId(run.id) })),
    plans: plans.flatMap((plan) => {
      const decoded = decodeFrozenPlan({ serviceDate: toIsoDate(plan.serviceDate), validatedAt: plan.validatedAt, figures: plan.figures });
      return decoded ? [decoded] : [];
    }),
  };
}
