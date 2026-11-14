/**
 * Loads what the dashboard computes from: the rows of @/lib/kpis-load (shared
 * with the history script), the fleet of each date (@/lib/kpis-fleet-load),
 * the settings the indicators are measured against, the year to date of the
 * shared transport (one aggregate query) and the initials of the patients
 * listed for a wait over the limit. The computation itself is in @/lib/kpis.
 */
import "server-only";
import { db } from "@/lib/db";
import { DEFAULT_KPI_OPTIONS, listDates, type KpiData, type KpiOptions } from "@/lib/kpis";
import { loadKpiFleet } from "@/lib/kpis-fleet-load";
import { loadKpiRows, type KpiDates } from "@/lib/kpis-load";
import { yearToDateMonths, type SharingMonth } from "@/lib/kpis-sharing";
import { patientInitials } from "./format";

export async function loadKpiData(dates: KpiDates): Promise<KpiData> {
  const list = "dates" in dates ? [...dates.dates] : listDates(dates.from, dates.to);
  if (list.length === 0) return { routes: [], trips: [], runs: [], fleet: [], plans: [] };
  const [rows, fleet] = await Promise.all([loadKpiRows(db, dates), loadKpiFleet(db, list)]);
  return { ...rows, fleet };
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
export async function loadSharingYear(to: string): Promise<{ months: SharingMonth[]; total: SharingMonth }> {
  const from = `${to.slice(0, 4)}-01-01`;
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
