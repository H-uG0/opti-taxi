/**
 * Loads the rows the dashboard indicators are computed from, for a whole
 * date range in four queries (routes with their stop count, routes with a
 * recorded stop status, served trips with their drop-off timestamp,
 * optimization runs). The computation itself is in @/lib/kpis.
 */
import "server-only";
import { db } from "@/lib/db";
import { SERVED_TRIP_STATUSES, type KpiData } from "@/lib/kpis";
import { fromIsoDate, toIsoDate } from "@/lib/time";

export async function loadKpiData(from: string, to: string): Promise<KpiData> {
  const serviceDate = { gte: fromIsoDate(from), lte: fromIsoDate(to) };

  const [routes, recorded, trips, runs] = await Promise.all([
    db.route.findMany({
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
    db.routeStop.groupBy({
      by: ["routeId"],
      where: { completedAt: { not: null }, route: { serviceDate } },
    }),
    db.trip.findMany({
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
    db.optimizationRun.findMany({
      where: { serviceDate },
      select: { serviceDate: true, startedAt: true },
    }),
  ]);

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
