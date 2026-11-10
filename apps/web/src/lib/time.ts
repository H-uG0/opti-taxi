/**
 * Time helpers. Planned times are integer minutes since local midnight
 * (Europe/Paris); service dates are "YYYY-MM-DD" strings in the app and
 * @db.Date (UTC midnight) in the database.
 */

export const TIME_ZONE = "Europe/Paris";

/**
 * 450 -> "07:30". Minutes past 24 h wrap into the next day ("25:10" -> "01:10 (+1)"),
 * negative minutes into the previous one (-30 -> "23:30 (-1)"). Fractions are rounded.
 */
export function formatMinute(minute: number | null | undefined): string {
  if (minute === null || minute === undefined || !Number.isFinite(minute)) return "—";
  const total = Math.round(minute);
  const day = Math.floor(total / 1440);
  const m = ((total % 1440) + 1440) % 1440;
  const hh = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  if (day === 0) return `${hh}:${mm}`;
  return `${hh}:${mm} (${day > 0 ? "+" : ""}${day})`;
}

/** "07:30" -> 450. Returns null for anything that is not HH:MM. */
export function parseMinute(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

/** Duration in minutes -> "1 h 05" / "45 min", with no-break spaces (never split over two lines). */
export function formatDuration(minutes: number): string {
  const sign = minutes < 0 ? "-" : "";
  const abs = Math.abs(Math.round(minutes));
  if (abs < 60) return `${sign}${abs}\u00a0min`;
  return `${sign}${Math.floor(abs / 60)}\u00a0h\u00a0${String(abs % 60).padStart(2, "0")}`;
}

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string | null | undefined): value is string {
  if (!value || !isoDatePattern.test(value)) return false;
  const date = fromIsoDate(value);
  // Month 00/13+ or day 32+ give an Invalid Date (toISOString would throw); 02-30 rolls over and fails the round trip.
  return !Number.isNaN(date.getTime()) && toIsoDate(date) === value;
}

/** "2026-11-03" -> Date at UTC midnight, the representation Prisma uses for @db.Date. */
export function fromIsoDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** Date from a @db.Date column (UTC midnight) -> "2026-11-03". */
export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Today's calendar date in Europe/Paris as "YYYY-MM-DD". */
export function todayIso(now: Date = new Date()): string {
  // Assembled from parts rather than relying on a locale's pattern (en-CA's has changed across ICU versions).
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
}

export function addDays(isoDate: string, days: number): string {
  const d = fromIsoDate(isoDate);
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDate(d);
}

/** J+1 in Europe/Paris. */
export function tomorrowIso(now: Date = new Date()): string {
  return addDays(todayIso(now), 1);
}

/** ISO weekday of a "YYYY-MM-DD" date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(isoDate: string): number {
  const day = fromIsoDate(isoDate).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Monday of the week containing isoDate. */
export function startOfIsoWeek(isoDate: string): string {
  return addDays(isoDate, 1 - isoWeekday(isoDate));
}

/** Real instant -> minutes since local midnight in Europe/Paris (for comparing with planned minutes). */
export function minuteOfDay(instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

/** Calendar date of a real instant in Europe/Paris as "YYYY-MM-DD". */
export function isoDateOf(instant: Date): string {
  return todayIso(instant);
}

/** "2026-11-03" -> "mardi 3 novembre 2026". */
export function formatLongDate(isoDate: string): string {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(fromIsoDate(isoDate));
}

/** "2026-11-03" -> "03/11/2026". */
export function formatShortDate(isoDate: string): string {
  return new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC" }).format(fromIsoDate(isoDate));
}

/** "2026-11-12" -> "12/11", or "12/11/2025" outside the current year (Europe/Paris): a day in a list or a tab title. */
export function formatDayDate(isoDate: string, now: Date = new Date()): string {
  const [year, month, day] = isoDate.split("-");
  return year === todayIso(now).slice(0, 4) ? `${day}/${month}` : `${day}/${month}/${year}`;
}

const instantParts = new Intl.DateTimeFormat("fr-FR", {
  timeZone: TIME_ZONE,
  year: "numeric",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * The one date-time format of the app: a real instant -> "02/11 à 18:40" in Europe/Paris,
 * "02/11/2025 à 18:40" outside the current year. `year: "always"` for a text that is stored
 * and read again later (a note): "02/11/2026 à 18:40". Assembled from parts, whatever the locale's pattern.
 */
export function formatDateTime(instant: Date | string, now: Date = new Date(), year: "auto" | "always" = "auto"): string {
  const parts = instantParts.formatToParts(typeof instant === "string" ? new Date(instant) : instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const shownYear = year === "always" || part("year") !== todayIso(now).slice(0, 4);
  const day = shownYear ? `${part("day")}/${part("month")}/${part("year")}` : `${part("day")}/${part("month")}`;
  return `${day} à ${part("hour")}:${part("minute")}`;
}

/** A real instant -> "08:12" when it falls on isoDate (Europe/Paris), else formatDateTime ("02/11 à 18:40"). */
export function formatTimeOn(instant: Date | string, isoDate: string, now: Date = new Date()): string {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  if (isoDateOf(date) !== isoDate) return formatDateTime(date, now);
  return formatMinute(minuteOfDay(date));
}

export const WEEKDAY_LABELS: Record<number, string> = {
  1: "Lundi",
  2: "Mardi",
  3: "Mercredi",
  4: "Jeudi",
  5: "Vendredi",
  6: "Samedi",
  7: "Dimanche",
};

export const WEEKDAY_SHORT: Record<number, string> = {
  1: "Lun",
  2: "Mar",
  3: "Mer",
  4: "Jeu",
  5: "Ven",
  6: "Sam",
  7: "Dim",
};
