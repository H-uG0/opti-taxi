/**
 * Dashboard indicators of the simulated period, computed by @/lib/kpis from
 * the same rows as /tableau-de-bord. The page's loader
 * (app/(regulator)/tableau-de-bord/load-kpis.ts) is server-only, so its four
 * queries are repeated here with the script's own client: keep them in step.
 */
import type { PrismaClient } from "@prisma/client";
import { SERVED_TRIP_STATUSES, type KpiData, type PeriodKpis } from "@/lib/kpis";
import { formatShortDate, fromIsoDate, toIsoDate } from "@/lib/time";

export async function loadKpiRows(prisma: PrismaClient, from: string, to: string): Promise<KpiData> {
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
    prisma.routeStop.groupBy({ by: ["routeId"], where: { completedAt: { not: null }, route: { serviceDate } } }),
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
    prisma.optimizationRun.findMany({ where: { serviceDate }, select: { serviceDate: true, startedAt: true } }),
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
      dropoffCompletedAt: stops.reduce<Date | null>(
        (latest, stop) => (stop.completedAt && (!latest || stop.completedAt > latest) ? stop.completedAt : latest),
        null,
      ),
    })),
    runs: runs.map((run) => ({ serviceDate: toIsoDate(run.serviceDate), startedAt: run.startedAt })),
  };
}

const decimal = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat("fr-FR", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
const euros = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const whole = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });

function orDash(value: number | null, format: (value: number) => string): string {
  return value === null ? "—" : format(value);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

/** French summary of the period, one indicator per line (the five indicators of the dashboard, then money). */
export function periodSummaryLines(period: PeriodKpis): string[] {
  const rows: [string, string][] = [
    [
      "Période",
      `du ${formatShortDate(period.from)} au ${formatShortDate(period.to)} ` +
        `(${plural(period.plannedDays, "jour planifié", "jours planifiés")}, ${plural(period.validatedDays, "validé")})`,
    ],
    ["Courses par véhicule et par jour (plan)", orDash(period.tripsPerVehiclePlanned, (v) => decimal.format(v))],
    ["Courses réalisées par véhicule et par jour", orDash(period.tripsPerVehicleRealized, (v) => decimal.format(v))],
    ["Part des km à vide", `${orDash(period.emptyKmShare, (v) => percent.format(v))} (${whole.format(period.emptyKm)} km sur ${whole.format(period.distanceKm)})`],
    ["Taux de transport partagé", `${orDash(period.sharedRate, (v) => percent.format(v))} (${period.sharedTrips} courses sur ${period.servedTrips})`],
    [
      "Arrivées en retard au rendez-vous",
      `${orDash(period.lateRate, (v) => percent.format(v))} (${period.lateArrivals} sur ${period.measuredOutbound} allers mesurés` +
        `${period.maxDelayMinutes === null ? "" : `, retard maximal ${whole.format(period.maxDelayMinutes)} min`})`,
    ],
    ["Retards dans le plan (devrait être 0)", `${period.plannedLateArrivals} sur ${period.plannedOutbound} allers`],
    [
      "Temps de planification moyen",
      `${orDash(period.averagePlanningMinutes, (v) => `${whole.format(v)} min`)} (${plural(period.optimizationRuns, "optimisation")})`,
    ],
    ["CA estimé / coût / marge", `${euros.format(period.revenue)} / ${euros.format(period.cost)} / ${euros.format(period.margin)}`],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`);
}
