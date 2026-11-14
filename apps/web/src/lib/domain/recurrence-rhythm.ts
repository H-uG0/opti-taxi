/**
 * When a recurrence plans a care session, and at what time: its rhythm.
 *
 * - Weekly rhythm: the ticked weekdays, every `intervalWeeks` weeks counted
 *   from the week (Monday to Sunday) of its start date — « une semaine sur
 *   deux » is 2: the week of the start date, then every other week.
 * - Explicit dates (chemotherapy cycles, a series of sessions on given days):
 *   when `sessionDates` is not empty, the recurrence occurs on those dates only
 *   (its weekdays are theirs, its period runs from the first to the last).
 * - Times: the recurrence's appointment and session length, unless the
 *   weekday has its own (`daySchedules`, each value optional).
 *
 * Pure module (no server-only import): the generation, the sync of the trips,
 * the forms, the pages and the seed share it.
 */
import { addDays, formatDuration, formatMinute, formatShortDate, isIsoDate, isoWeekday, startOfIsoWeek, WEEKDAY_SHORT } from "@/lib/time";

/** Longest interval a weekly rhythm may have, in weeks. */
export const MAX_INTERVAL_WEEKS = 8;
/** Most explicit dates one recurrence may hold. */
export const MAX_SESSION_DATES = 120;

/** Own time and/or session length of one weekday (ISO, 1 = Monday); null: the recurrence's. */
export type DaySchedule = { weekday: number; appointmentMinute: number | null; sessionMinutes: number | null };

export type Rhythm = {
  weekdays: readonly number[];
  /** Every N weeks from the week of startDate; absent: every week. */
  intervalWeeks?: number;
  /** Explicit session dates ("YYYY-MM-DD"); absent or empty: the weekly rhythm. */
  sessionDates?: readonly string[];
  startDate: string;
  endDate: string | null;
};

export type SessionTimes = { appointmentMinute: number; sessionMinutes: number };

/** Whole weeks between the weeks of two dates (Monday to Sunday), `to` after `from`. */
export function weeksBetween(fromIso: string, toIso: string): number {
  const ms = Date.parse(`${startOfIsoWeek(toIso)}T00:00:00Z`) - Date.parse(`${startOfIsoWeek(fromIso)}T00:00:00Z`);
  return Math.round(ms / (7 * 86_400_000));
}

/** The interval, kept in [1, MAX_INTERVAL_WEEKS] whatever was stored. */
export function intervalOf(rhythm: Pick<Rhythm, "intervalWeeks">): number {
  const n = rhythm.intervalWeeks ?? 1;
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_INTERVAL_WEEKS) : 1;
}

/** Has the rhythm explicit dates (and nothing else)? */
export function hasSessionDates(rhythm: Pick<Rhythm, "sessionDates">): boolean {
  return (rhythm.sessionDates?.length ?? 0) > 0;
}

/** Does the rhythm plan a session on this date (period, weekdays and interval, or explicit dates)? */
export function rhythmOccursOn(rhythm: Rhythm, isoDate: string): boolean {
  if (isoDate < rhythm.startDate) return false;
  if (rhythm.endDate !== null && isoDate > rhythm.endDate) return false;
  if (hasSessionDates(rhythm)) return rhythm.sessionDates!.includes(isoDate);
  if (!rhythm.weekdays.includes(isoWeekday(isoDate))) return false;
  const interval = intervalOf(rhythm);
  return interval === 1 || weeksBetween(rhythm.startDate, isoDate) % interval === 0;
}

/** The next `count` session dates from `fromIso` (included), within a year. */
export function nextSessionDates(rhythm: Rhythm, fromIso: string, count: number): string[] {
  const dates: string[] = [];
  const start = fromIso > rhythm.startDate ? fromIso : rhythm.startDate;
  if (hasSessionDates(rhythm)) return [...rhythm.sessionDates!].filter((d) => d >= start).sort().slice(0, count);
  for (let date = start, i = 0; dates.length < count && i < 366; date = addDays(date, 1), i++) {
    if (rhythm.endDate !== null && date > rhythm.endDate) break;
    if (rhythmOccursOn(rhythm, date)) dates.push(date);
  }
  return dates;
}

/** Reads the stored day schedules (a JSON column): malformed entries are dropped, one entry per weekday. */
export function parseDaySchedules(raw: unknown): DaySchedule[] {
  if (!Array.isArray(raw)) return [];
  const byDay = new Map<number, DaySchedule>();
  const minute = (value: unknown, max: number): number | null =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : null;
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const weekday = entry.weekday;
    if (typeof weekday !== "number" || !Number.isInteger(weekday) || weekday < 1 || weekday > 7) continue;
    const appointmentMinute = minute(entry.appointmentMinute, 1439);
    const sessionMinutes = minute(entry.sessionMinutes, 1440);
    if (appointmentMinute === null && sessionMinutes === null) continue;
    byDay.set(weekday, { weekday, appointmentMinute, sessionMinutes });
  }
  return [...byDay.values()].sort((a, b) => a.weekday - b.weekday);
}

/** Appointment and session length on `isoDate`: the weekday's own when set, else the recurrence's. */
export function sessionTimesOn(
  rec: { appointmentMinute: number; sessionMinutes: number; daySchedules?: unknown },
  isoDate: string,
): SessionTimes {
  const own = parseDaySchedules(rec.daySchedules).find((d) => d.weekday === isoWeekday(isoDate));
  return {
    appointmentMinute: own?.appointmentMinute ?? rec.appointmentMinute,
    sessionMinutes: own?.sessionMinutes ?? rec.sessionMinutes,
  };
}

/** The weekdays of explicit dates, sorted (what `weekdays` stores for such a recurrence). */
export function weekdaysOfDates(dates: readonly string[]): number[] {
  return [...new Set(dates.map(isoWeekday))].sort((a, b) => a - b);
}

/** "Lun Mer Ven" (as formatWeekdays: patients/_lib/status.ts), "" when none. */
function shortDays(weekdays: readonly number[]): string {
  return [...weekdays]
    .sort((a, b) => a - b)
    .map((d) => WEEKDAY_SHORT[d] ?? "?")
    .join(" ");
}

/** « une semaine sur deux », « toutes les 3 semaines », "" for every week. */
export function intervalLabel(intervalWeeks: number): string {
  if (intervalWeeks <= 1) return "";
  return intervalWeeks === 2 ? "une semaine sur deux" : `toutes les ${intervalWeeks} semaines`;
}

/**
 * The days of a rhythm, in a few words: "Lun Mer Ven", "Lun, une semaine sur
 * deux", "6 dates (16/11/2026 → 21/12/2026)".
 */
export function describeRhythmDays(rhythm: Pick<Rhythm, "weekdays" | "intervalWeeks" | "sessionDates">): string {
  if (hasSessionDates(rhythm)) {
    const dates = [...rhythm.sessionDates!].sort();
    const first = dates[0] ?? "";
    const last = dates.at(-1) ?? first;
    return dates.length === 1
      ? `1 date (${formatShortDate(first)})`
      : `${dates.length} dates (${formatShortDate(first)} → ${formatShortDate(last)})`;
  }
  const days = shortDays(rhythm.weekdays);
  const every = intervalLabel(intervalOf(rhythm));
  return every ? `${days}, ${every}` : days;
}

/** "Mer 13:00", "Ven 3 h 00", "Mer 13:00 · 3 h 00": the weekdays with their own time or length. */
export function describeDaySchedules(schedules: readonly DaySchedule[]): string[] {
  return schedules.map((d) =>
    [
      WEEKDAY_SHORT[d.weekday] ?? "?",
      [d.appointmentMinute !== null ? formatMinute(d.appointmentMinute) : null, d.sessionMinutes !== null ? formatDuration(d.sessionMinutes) : null]
        .filter(Boolean)
        .join(" · "),
    ].join(" "),
  );
}

/** The dates typed in the form ("16/11/2026, 07/12/2026" or "2026-11-16", one or more per line), parsed. */
export function parseSessionDates(text: string): { dates: string[]; invalid: string[] } {
  const dates = new Set<string>();
  const invalid: string[] = [];
  for (const token of text.split(/[\s,;]+/).filter(Boolean)) {
    const french = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(token);
    const iso = french ? `${french[3]}-${french[2]!.padStart(2, "0")}-${french[1]!.padStart(2, "0")}` : token;
    if (isIsoDate(iso)) dates.add(iso);
    else invalid.push(token);
  }
  return { dates: [...dates].sort(), invalid };
}

/** Dates as the form shows them: "16/11/2026", one per line. */
export function formatSessionDates(dates: readonly string[]): string {
  return [...dates].sort().map(formatShortDate).join("\n");
}

/** « Ajouter une série » : `count` dates from `firstIso`, every `everyDays` days (a 21-day cycle: 21). */
export function seriesDates(firstIso: string, everyDays: number, count: number): string[] {
  if (!isIsoDate(firstIso) || !Number.isInteger(everyDays) || everyDays < 1 || !Number.isInteger(count) || count < 1) return [];
  return Array.from({ length: Math.min(count, MAX_SESSION_DATES) }, (_, i) => addDays(firstIso, i * everyDays));
}
