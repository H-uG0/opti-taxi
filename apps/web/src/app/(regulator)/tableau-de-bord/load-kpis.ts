/**
 * Loads what the dashboard computes from: the rows of @/lib/kpis-load (shared
 * with the history script), the fleet of each date (@/lib/kpis-fleet-load),
 * the regulators' planning actions (audit trail, KPI-06), the settings the
 * indicators are measured against, the vehicles, depots and objectives
 * (KPI-02, KPI-09), the fill-ups and deadlines of the fleet (KPI-10), the
 * year to date of the shared transport (one aggregate query) and the
 * initials of the patients listed for a wait over the limit. The
 * computation itself is in @/lib/kpis and its parts.
 */
import "server-only";
import { Prisma, type EnergyType, type VehicleType } from "@prisma/client";
import { db } from "@/lib/db";
import { DEFAULT_KPI_OPTIONS, listDates, type KpiData, type KpiOptions } from "@/lib/kpis";
import type { EnergyDeadline } from "@/lib/kpis-energy";
import { loadKpiFleet } from "@/lib/kpis-fleet-load";
import { loadKpiRows, loadPlanningActivity, type KpiDates } from "@/lib/kpis-load";
import type { KpiScope, VehicleMeta } from "@/lib/kpis-scope";
import { yearToDateMonths, type SharingMonth } from "@/lib/kpis-sharing";
import type { TargetRow } from "@/lib/kpis-targets";
import type { FuelEntry } from "@/lib/fleet/consumption";
import { addDays, fromIsoDate, toIsoDate } from "@/lib/time";
import { patientInitials } from "./format";

export async function loadKpiData(dates: KpiDates): Promise<KpiData> {
  const list = "dates" in dates ? [...dates.dates] : listDates(dates.from, dates.to);
  if (list.length === 0) return { routes: [], trips: [], runs: [], fleet: [], plans: [], activity: [] };
  const [rows, fleet, activity] = await Promise.all([loadKpiRows(db, dates), loadKpiFleet(db, list), loadPlanningActivity(db, dates)]);
  return { ...rows, fleet, activity };
}

export type DashboardVehicle = {
  id: string;
  label: string;
  type: VehicleType;
  depotId: string;
  energy: EnergyType | null;
  costPerKm: number;
  active: boolean;
};

/** Vehicles, depots and objectives: the labels of the breakdowns, the scope, the dashed lines. */
export type DashboardRefs = {
  vehicles: DashboardVehicle[];
  depots: { id: string; name: string; active: boolean }[];
  vehicleMeta: Map<string, VehicleMeta>;
  targets: TargetRow[];
};

export async function loadDashboardRefs(): Promise<DashboardRefs> {
  const [vehicles, depots, targets] = await Promise.all([
    db.vehicle.findMany({
      select: { id: true, label: true, type: true, depotId: true, energy: true, costPerKm: true, active: true },
      orderBy: { label: "asc" },
    }),
    db.depot.findMany({ select: { id: true, name: true, active: true }, orderBy: { name: "asc" } }),
    db.kpiTarget.findMany({ select: { indicator: true, depotId: true, reference: true, objective: true } }),
  ]);
  return { vehicles, depots, vehicleMeta: new Map(vehicles.map((v) => [v.id, { depotId: v.depotId, type: v.type }])), targets };
}

/** Names and depot of the people of the routes (the « Personnel » breakdown): staff records, no patient. */
export async function loadPeople(ids: readonly string[]): Promise<{ id: string; firstName: string; lastName: string; depotId: string | null }[]> {
  if (ids.length === 0) return [];
  return db.driver.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, firstName: true, lastName: true, depotId: true },
  });
}

/** Days searched before the period for the last full tank that starts a vehicle's measured interval. */
const FUEL_LOOKBACK_DAYS = 120;

/**
 * Fill-ups (from FUEL_LOOKBACK_DAYS before the period to its end) and open
 * deadlines of the vehicles, the km of their routes from the earliest fill-up
 * read (the planned km of each measured interval) and the first and last
 * dates that have routes at all.
 */
export async function loadFleetEnergyInputs(
  range: { from: string; to: string },
  vehicleIds: readonly string[],
): Promise<{
  fills: Map<string, FuelEntry[]>;
  deadlines: Map<string, EnergyDeadline[]>;
  routeKm: Map<string, Map<string, number>>;
  plannedSince: string | null;
  plannedUntil: string | null;
}> {
  const ids = [...vehicleIds];
  const [fills, deadlines, first] = await Promise.all([
    db.fuelLog.findMany({
      where: { vehicleId: { in: ids }, date: { gte: fromIsoDate(addDays(range.from, -FUEL_LOOKBACK_DAYS)), lte: fromIsoDate(range.to) } },
      select: { vehicleId: true, date: true, odometerKm: true, quantity: true, cost: true, fullTank: true },
    }),
    db.maintenanceDeadline.findMany({
      where: { vehicleId: { in: ids }, doneDate: null },
      select: { vehicleId: true, kind: true, label: true, dueDate: true, dueKm: true, doneDate: true },
    }),
    db.route.findFirst({ orderBy: { serviceDate: "asc" }, select: { serviceDate: true } }),
  ]);
  const last = await db.route.findFirst({
    where: { serviceDate: { lte: fromIsoDate(range.to) }, stops: { some: {} } },
    orderBy: { serviceDate: "desc" },
    select: { serviceDate: true },
  });
  const earliest = fills.reduce<Date | null>((min, f) => (min === null || f.date < min ? f.date : min), null);
  const routes = earliest
    ? await db.route.findMany({
        where: { vehicleId: { in: ids }, serviceDate: { gte: earliest, lte: fromIsoDate(range.to) }, stops: { some: {} } },
        select: { vehicleId: true, serviceDate: true, distanceKm: true },
      })
    : [];
  const byVehicle = <T extends { vehicleId: string }>(rows: T[]) => {
    const map = new Map<string, T[]>();
    for (const row of rows) map.set(row.vehicleId, [...(map.get(row.vehicleId) ?? []), row]);
    return map;
  };
  const routeKm = new Map<string, Map<string, number>>();
  for (const route of routes) {
    const dates = routeKm.get(route.vehicleId) ?? new Map<string, number>();
    const date = toIsoDate(route.serviceDate);
    dates.set(date, (dates.get(date) ?? 0) + route.distanceKm);
    routeKm.set(route.vehicleId, dates);
  }
  return {
    fills: byVehicle(fills.map((f) => ({ ...f, date: toIsoDate(f.date) }))),
    deadlines: byVehicle(
      deadlines.map((d) => ({ ...d, dueDate: d.dueDate ? toIsoDate(d.dueDate) : null, doneDate: d.doneDate ? toIsoDate(d.doneDate) : null })),
    ),
    routeKm,
    plannedSince: first ? toIsoDate(first.serviceDate) : null,
    plannedUntil: last ? toIsoDate(last.serviceDate) : null,
  };
}

/** The business rules of the settings, and the lateness tolerance chosen on the page. */
export async function loadKpiOptions(lateToleranceMin: number): Promise<KpiOptions> {
  const settings = await db.appSettings.findUnique({
    where: { id: 1 },
    select: { maxTotalWaitMin: true, maxRideExtraMin: true, maxDetourKmPerExtraPatient: true },
  });
  return {
    ...DEFAULT_KPI_OPTIONS,
    lateToleranceMin,
    maxTotalWaitMin: settings?.maxTotalWaitMin ?? DEFAULT_KPI_OPTIONS.maxTotalWaitMin,
    maxRideExtraMin: settings?.maxRideExtraMin ?? DEFAULT_KPI_OPTIONS.maxRideExtraMin,
    maxDetourKm: settings?.maxDetourKmPerExtraPatient ?? DEFAULT_KPI_OPTIONS.maxDetourKm,
  };
}

type MonthRow = { month: string; type: string; tap: number; tapShared: number; eligible: number; eligibleShared: number };

/**
 * Shared transport of the year of `to`, from 1 January to `to`, by month and
 * vehicle type (served CPAM trips in a taxi or a VSL, the plan's sharing):
 * one aggregate query, so the year does not load trip by trip. The bounds are
 * cast from their ISO strings (a Date would bind as timestamptz and shift with
 * the session's time zone).
 */
export async function loadSharingYear(to: string, scope: KpiScope): Promise<{ months: SharingMonth[]; total: SharingMonth }> {
  const from = `${to.slice(0, 4)}-01-01`;
  const depot = scope.depotId === null ? Prisma.empty : Prisma.sql`AND v."depotId" = ${scope.depotId}`;
  const type = scope.vehicleType === null ? Prisma.empty : Prisma.sql`AND v.type::text = ${scope.vehicleType}`;
  const rows = await db.$queryRaw<MonthRow[]>`
    SELECT to_char(t."serviceDate", 'YYYY-MM') AS month,
           v.type::text AS type,
           count(*)::int AS tap,
           count(*) FILTER (WHERE t.shared)::int AS "tapShared",
           count(*) FILTER (WHERE t."sharingAllowed")::int AS eligible,
           count(*) FILTER (WHERE t."sharingAllowed" AND t.shared)::int AS "eligibleShared"
    FROM "Trip" t
    JOIN "Route" r ON r.id = t."routeId"
    JOIN "Vehicle" v ON v.id = r."vehicleId"
    WHERE t."serviceDate" BETWEEN ${from}::date AND ${to}::date
      AND t.status IN ('ASSIGNED', 'PICKED_UP', 'DROPPED_OFF')
      AND t.payer = 'CPAM'
      AND NOT ('AMBULANCE' = ALL (t."allowedVehicleTypes"))
      AND v.type IN ('TAXI', 'VSL')
      ${depot}
      ${type}
    GROUP BY 1, 2`;
  return yearToDateMonths(rows, to);
}

/** Initials of the patients by id (the listed wait cases only). */
export async function loadPatientInitials(patientIds: readonly string[]): Promise<Map<string, string>> {
  if (patientIds.length === 0) return new Map();
  const patients = await db.patient.findMany({
    where: { id: { in: [...new Set(patientIds)] } },
    select: { id: true, firstName: true, lastName: true },
  });
  return new Map(patients.map((p) => [p.id, patientInitials(p)]));
}
