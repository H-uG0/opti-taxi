/**
 * Horizon of the trips generated from the recurrences: from tomorrow (a day
 * already begun is never completed) to D+N, N = setting tripHorizonDays.
 * Pure module: shared by the server side (completion.ts), the pages and the tests.
 */
import { addDays } from "@/lib/time";

/** Default of the setting tripHorizonDays (schema default). */
export const DEFAULT_TRIP_HORIZON_DAYS = 14;

/** Bounds of the setting, in days. */
export const TRIP_HORIZON_DAYS = { min: 1, max: 60 } as const;

export type DateRange = { from: string; to: string };

/** Tomorrow to D+days, for "today". */
export function horizonOf(todayIso: string, days: number): DateRange {
  return { from: addDays(todayIso, 1), to: addDays(todayIso, Math.max(1, days)) };
}

export function inHorizon(isoDate: string, horizon: DateRange): boolean {
  return horizon.from <= isoDate && isoDate <= horizon.to;
}

/** The part of [from, to] that the generation may write: never before tomorrow. Null when nothing is left. */
export function writableRange(range: DateRange, tomorrowIso: string): DateRange | null {
  const from = range.from > tomorrowIso ? range.from : tomorrowIso;
  return from <= range.to ? { from, to: range.to } : null;
}
