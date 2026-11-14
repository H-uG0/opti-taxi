/**
 * Trends of the dashboard (KPI-09): the days of the range by day, ISO week or
 * month, the moving average over the last working days, and the shortcuts of
 * the period. Pure.
 *
 * A week or a month is summarized like a period (summarizePeriod: rates from
 * the summed counters, the median planning time). A working day is a day
 * with routes (Sundays and days off have none). The moving average of a day
 * is the rate of its last MOVING_AVERAGE_DAYS working days, recomputed from
 * their summed counters, never an average of daily rates; the days before the
 * range are passed in so that it starts with the range.
 */
import { addDays, fromIsoDate, startOfIsoWeek } from "@/lib/time";
import { summarizePeriod, type DayKpis, type Granularity, type KpiSummary } from "./kpis";

/** Working days of the moving average. */
export const MOVING_AVERAGE_DAYS = 7;
/** Calendar days loaded before the range so that the moving average starts with it (7 working days and a margin). */
export const MOVING_AVERAGE_LEAD_IN_DAYS = 10;

/** First day of the step containing `date` (the date itself, the Monday of its ISO week, the 1st of its month). */
export function bucketStart(date: string, granularity: Granularity): string {
  if (granularity === "week") return startOfIsoWeek(date);
  if (granularity === "month") return `${date.slice(0, 7)}-01`;
  return date;
}

/** Last day of the step starting on `start`. */
export function bucketEnd(start: string, granularity: Granularity): string {
  if (granularity === "week") return addDays(start, 6);
  if (granularity === "month") return addDays(firstOfNextMonth(start), -1);
  return start;
}

function firstOfNextMonth(date: string): string {
  const d = fromIsoDate(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

/** The first day of the month `months` months after (or before) the month of `date`. */
export function addMonths(date: string, months: number): string {
  const d = fromIsoDate(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1)).toISOString().slice(0, 10);
}

/** A step of a trend: its days (those of the range only), summarized. */
export type TrendPoint = {
  /** First day of the step (its key, and the date of a day). */
  key: string;
  /** Days of the range in the step: a step cut by the range shows fewer. */
  from: string;
  to: string;
  /** The step is cut by the range (its first or last days are outside). */
  cut: boolean;
  days: readonly DayKpis[];
  /** The day itself, or the step summarized. */
  summary: KpiSummary;
  /** Planning time: the day's initial build, or the median of the step's days (minutes). */
  planningMinutes: number | null;
  /** Some day of the step has routes or optimizations. */
  planned: boolean;
  /** Moving average over the last working days (day steps only; null before enough days or on a day off). */
  average: { summary: KpiSummary; planningMinutes: number | null; days: number } | null;
};

/**
 * The steps of `days` (consecutive, oldest first). `before`: the days just
 * before the range (for the moving average of the first days), any order.
 */
export function trendPoints(days: readonly DayKpis[], granularity: Granularity, before: readonly DayKpis[] = []): TrendPoint[] {
  if (granularity === "day") {
    const history = [...before, ...days].filter((d) => d.date < (days[0]?.date ?? "")).sort((a, b) => a.date.localeCompare(b.date));
    const all = [...history, ...days];
    return days.map((day, index) => ({
      key: day.date,
      from: day.date,
      to: day.date,
      cut: false,
      days: [day],
      summary: day,
      planningMinutes: day.planningMinutes,
      planned: day.vehicles > 0 || day.optimizationRuns > 0,
      average: movingAverage(all, history.length + index),
    }));
  }
  const groups = new Map<string, DayKpis[]>();
  for (const day of days) {
    const key = bucketStart(day.date, granularity);
    const list = groups.get(key);
    if (list) list.push(day);
    else groups.set(key, [day]);
  }
  return [...groups].map(([key, list]) => {
    const summary = summarizePeriod(list);
    const from = list[0]?.date ?? key;
    const to = list[list.length - 1]?.date ?? key;
    return {
      key,
      from,
      to,
      cut: from !== key || to !== bucketEnd(key, granularity),
      days: list,
      summary,
      planningMinutes: summary.medianPlanningMinutes,
      planned: list.some((d) => d.vehicles > 0 || d.optimizationRuns > 0),
      average: null,
    };
  });
}

/**
 * Moving average of the day at `index` in `all` (oldest first): its last
 * MOVING_AVERAGE_DAYS working days up to it, summed. Null on a day without
 * routes or with fewer working days before it.
 */
export function movingAverage(all: readonly DayKpis[], index: number): TrendPoint["average"] {
  const day = all[index];
  if (!day || day.vehicles === 0) return null;
  const window: DayKpis[] = [];
  for (let i = index; i >= 0 && window.length < MOVING_AVERAGE_DAYS; i--) {
    const candidate = all[i];
    if (candidate && candidate.vehicles > 0) window.push(candidate);
  }
  if (window.length < MOVING_AVERAGE_DAYS) return null;
  const summary = summarizePeriod(window.reverse());
  return { summary, planningMinutes: summary.medianPlanningMinutes, days: window.length };
}

/** A shortcut of the period form. */
export type RangePreset = { id: string; label: string; from: string; to: string; granularity: Granularity | null };

/**
 * Shortcuts: the last 7, 14, 30 and 90 days through J+1, last week (Monday to
 * Sunday), the current month (from the 1st through J+1, at most its last
 * day) and the 12 months (the current one and the 11 before, by month).
 */
export function rangePresets(today: string, tomorrow: string): RangePreset[] {
  const lastDays = [7, 14, 30, 90].map(
    (days): RangePreset => ({ id: `${days}j`, label: `${days} jours`, from: addDays(tomorrow, -(days - 1)), to: tomorrow, granularity: null }),
  );
  const thisMonday = startOfIsoWeek(today);
  const monthStart = bucketStart(today, "month");
  const monthEnd = bucketEnd(monthStart, "month");
  return [
    ...lastDays,
    { id: "semaine", label: "Semaine dernière", from: addDays(thisMonday, -7), to: addDays(thisMonday, -1), granularity: "day" },
    { id: "mois", label: "Mois en cours", from: monthStart, to: tomorrow < monthEnd ? tomorrow : monthEnd, granularity: "day" },
    { id: "12mois", label: "12 mois", from: addMonths(today, -11), to: tomorrow, granularity: "month" },
  ];
}
