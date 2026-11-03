/**
 * Loads the rows the dashboard indicators are computed from, for a whole
 * date range in four queries (routes with their stop count, routes with a
 * recorded stop status, served trips with their drop-off timestamp,
 * optimization runs). The computation itself is in @/lib/kpis.
 *
 * Shared by /tableau-de-bord (app/(regulator)/tableau-de-bord/load-kpis.ts,
 * with the app's client) and the history script (prisma/history.ts, with its
 * own): the client is passed in, nothing here is server-only. The row
 * mapping (toKpiData) is pure and unit-tested.
 */
import type { PrismaClient } from "@prisma/client";
import { SERVED_TRIP_STATUSES, type KpiData, type KpiRoute, type KpiTrip } from "@/lib/kpis";
import { fromIsoDate, toIsoDate } from "@/lib/time";

/** The models the loader reads. */
export type KpiClient = Pick<PrismaClient, "route" | "routeStop" | "trip" | "optimizationRun">;

/** Rows as the four queries return them. */
export type KpiQueryRows = {
  routes: (Omit<KpiRoute, "serviceDate" | "stopCount" | "hasRecordedStatus"> & {
    id: string;
    serviceDate: Date;
    _count: { stops: number };
  })[];
  /** Routes on which the crew recorded at least one status. */
  recorded: { routeId: string }[];
  trips: (Omit<KpiTrip, "serviceDate" | "dropoffCompletedAt"> & {
    serviceDate: Date;
    /** Completed DROPOFF stops of the trip. */
    stops: { completedAt: Date | null }[];
  })[];
  runs: { serviceDate: Date; startedAt: Date }[];
};

export async function loadKpiRows(prisma: KpiClient, from: string, to: string): Promise<KpiData> {
  const serviceDate = { gte: fromIsoDate(from), lte: fromIsoDate(to) };

  const [routes, recorded, trips, runs] = await Promise.all([
    prisma.route.findMany({
      where: { serviceDate },
      select: {
        id: true,
        serviceDate: true,
        vehicleId: true,
        distanceKm: true,
        emptyKm: true,
        revenue: true,
        cost: true,
        margin: true,
        validatedAt: true,
        _count: { select: { stops: true } },
      },
    }),
    // Routes on which the crew recorded at least one status (pickup, drop-off or absence).
    prisma.routeStop.groupBy({
      by: ["routeId"],
      where: { completedAt: { not: null }, route: { serviceDate } },
    }),
    prisma.trip.findMany({
      where: { serviceDate, routeId: { not: null }, status: { in: [...SERVED_TRIP_STATUSES] } },
      select: {
        serviceDate: true,
        status: true,
        routeId: true,
        direction: true,
        shared: true,
        appointmentMinute: true,
        plannedDropoffMinute: true,
        stops: { where: { kind: "DROPOFF", completedAt: { not: null } }, select: { completedAt: true } },
      },
    }),
    prisma.optimizationRun.findMany({
      where: { serviceDate },
      select: { serviceDate: true, startedAt: true },
    }),
  ]);

  return toKpiData({ routes, recorded, trips, runs });
}

/** Maps the query rows to the input of @/lib/kpis (service dates as "YYYY-MM-DD"). */
export function toKpiData({ routes, recorded, trips, runs }: KpiQueryRows): KpiData {
  const recordedRouteIds = new Set(recorded.map((row) => row.routeId));

  return {
    routes: routes.map(({ id, _count, serviceDate: date, ...route }) => ({
      ...route,
      serviceDate: toIsoDate(date),
      stopCount: _count.stops,
      hasRecordedStatus: recordedRouteIds.has(id),
    })),
    trips: trips.map(({ stops, serviceDate: date, ...trip }) => ({
      ...trip,
      serviceDate: toIsoDate(date),
      // One drop-off stop per trip; keep the latest timestamp if there were several.
      dropoffCompletedAt: stops.reduce<Date | null>(
        (latest, stop) => (stop.completedAt && (!latest || stop.completedAt > latest) ? stop.completedAt : latest),
        null,
      ),
    })),
    runs: runs.map((run) => ({ serviceDate: toIsoDate(run.serviceDate), startedAt: run.startedAt })),
  };
}
