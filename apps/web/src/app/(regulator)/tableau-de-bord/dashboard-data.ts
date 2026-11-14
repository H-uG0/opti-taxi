/**
 * The dashboard of a query, loaded and computed: shared by the page and the
 * CSV export (export/route.ts), so both read the same days. The rows are
 * narrowed to the depot and the vehicle type of the address (kpis-scope.ts),
 * then computed day by day (@/lib/kpis).
 */
import "server-only";
import {
  computeKpisByDay,
  computeKpisForDates,
  resolveKpiRange,
  summarizePeriod,
  type DayKpis,
  type KpiOptions,
  type KpiRange,
  type PeriodKpis,
} from "@/lib/kpis";
import { routeLines, type RouteLine } from "@/lib/kpis-breakdown";
import type { KpiData } from "@/lib/kpis-rows";
import { isScoped, scopeKpiData, type KpiScope } from "@/lib/kpis-scope";
import { effectiveTargets, type EffectiveTargets } from "@/lib/kpis-targets";
import { MOVING_AVERAGE_LEAD_IN_DAYS } from "@/lib/kpis-trend";
import { addDays, todayIso, tomorrowIso } from "@/lib/time";
import { loadDashboardRefs, loadKpiData, loadKpiOptions, type DashboardRefs } from "./load-kpis";
import type { DashboardQuery } from "./query";

export type Dashboard = {
  today: string;
  tomorrow: string;
  range: KpiRange;
  options: KpiOptions;
  refs: DashboardRefs;
  /** The depot and type of the address, null when unknown (an id that is no depot is ignored). */
  scope: KpiScope;
  scoped: boolean;
  /** The rows of the range, narrowed to the scope. */
  data: KpiData;
  days: DayKpis[];
  period: PeriodKpis;
  targets: EffectiveTargets;
};

export async function loadDashboard(query: DashboardQuery): Promise<Dashboard> {
  const today = todayIso();
  const tomorrow = tomorrowIso();
  const range = resolveKpiRange({ from: query.from, to: query.to, granularity: query.step }, tomorrow);
  const [options, refs, raw] = await Promise.all([loadKpiOptions(query.tolerance), loadDashboardRefs(), loadKpiData(range)]);
  const scope: KpiScope = {
    depotId: query.depotId !== null && refs.depots.some((d) => d.id === query.depotId) ? query.depotId : null,
    vehicleType: query.vehicleType,
  };
  const data = scopeKpiData(raw, scope, refs.vehicleMeta);
  const days = computeKpisByDay(range.from, range.to, data, today, options);
  return {
    today,
    tomorrow,
    range,
    options,
    refs,
    scope,
    scoped: isScoped(scope),
    data,
    days,
    period: summarizePeriod(days),
    targets: effectiveTargets(refs.targets, scope.depotId),
  };
}

/**
 * Days outside the range, computed like those of the range: the comparison
 * days of the headline and the days before it for the moving average.
 */
export async function loadExtraDays(dashboard: Dashboard, dates: readonly string[]): Promise<DayKpis[]> {
  const wanted = [...new Set(dates)].filter((date) => date < dashboard.range.from || date > dashboard.range.to).sort();
  if (wanted.length === 0) return [];
  const data = scopeKpiData(await loadKpiData({ dates: wanted }), dashboard.scope, dashboard.refs.vehicleMeta);
  return computeKpisForDates(wanted, data, dashboard.today, dashboard.options);
}

/** The calendar days before the range that the moving average of its first days reads. */
export function leadInDates(range: { from: string }): string[] {
  return Array.from({ length: MOVING_AVERAGE_LEAD_IN_DAYS }, (_, i) => addDays(range.from, -(i + 1)));
}

/** One line per route of the range (breakdowns, unit economics), the vehicles' cost per km for the km part. */
export function dashboardLines(dashboard: Dashboard): RouteLine[] {
  const costPerKm = new Map(dashboard.refs.vehicles.map((v) => [v.id, v.costPerKm]));
  return routeLines(dashboard.data, dashboard.today, dashboard.options, (id) => costPerKm.get(id));
}
