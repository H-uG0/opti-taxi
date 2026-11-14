/**
 * Reception hours of a care facility (« Horaires d'accueil »): per weekday an
 * opening and a closing time, and an earliest accepted arrival (patients let
 * in before the opening, or only after it). On a day, the facility receives
 * the patients from the earliest arrival (or else the opening) to the closing
 * time. A weekday without hours has no bound, unless the facility has no
 * hours at all: its earliest arrival then holds every day.
 *
 * The optimizer narrows the window of the trip's stop at the facility (an
 * outbound drop-off, a return pickup) to them, and its validator checks them
 * (contract README, « Heures d'accueil de l'établissement »). The web sends
 * them only when the trip's own time (appointment, end of session) is inside
 * them: a time outside is a data error shown to the regulator, never a trip
 * made impossible. Without hours entered, the request is the same as before.
 *
 * Pure module (no server-only import).
 */
import { formatMinute, isoWeekday, WEEKDAY_SHORT } from "@/lib/time";

export type OpeningHours = { weekday: number; openMinute: number; closeMinute: number };

/** The facility's hours of one day, in contract minutes; null fields: no bound. */
export type DayHours = { openMin: number | null; closeMin: number | null };

/** Reads the stored JSON (Facility.openingHours): malformed or empty entries are dropped, one per weekday. */
export function parseOpeningHours(raw: unknown): OpeningHours[] {
  if (!Array.isArray(raw)) return [];
  const byDay = new Map<number, OpeningHours>();
  const minute = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1440 ? value : null);
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const weekday = entry.weekday;
    const open = minute(entry.openMinute);
    const close = minute(entry.closeMinute);
    if (typeof weekday !== "number" || !Number.isInteger(weekday) || weekday < 1 || weekday > 7) continue;
    if (open === null || close === null || close <= open) continue;
    byDay.set(weekday, { weekday, openMinute: open, closeMinute: close });
  }
  return [...byDay.values()].sort((a, b) => a.weekday - b.weekday);
}

/**
 * The hours of `isoDate`: the earliest arrival (else the opening of that weekday), the closing; null: none at all.
 * A weekday without hours of a facility that has some is a day without bound (the form says so): the earliest
 * arrival holds only on the days with hours, or every day when no day has any.
 */
export function facilityHoursOn(
  facility: { openingHours: unknown; earliestArrivalMinute: number | null },
  isoDate: string,
): DayHours | null {
  const week = parseOpeningHours(facility.openingHours);
  const day = week.find((h) => h.weekday === isoWeekday(isoDate));
  if (!day && week.length > 0) return null;
  const openMin = facility.earliestArrivalMinute ?? day?.openMinute ?? null;
  const closeMin = day?.closeMinute ?? null;
  if (openMin === null && closeMin === null) return null;
  // An earliest arrival after the closing time is a data error: the closing alone holds.
  if (openMin !== null && closeMin !== null && openMin >= closeMin) return { openMin: null, closeMin };
  return { openMin, closeMin };
}

/** Is the trip's own time (appointment of an outbound trip, end of session of a return) inside the day's hours? */
export function insideHours(hours: DayHours, keyMinute: number | null): boolean {
  if (keyMinute === null) return false;
  if (hours.openMin !== null && keyMinute < hours.openMin) return false;
  return hours.closeMin === null || keyMinute <= hours.closeMin;
}

/** The trip fields of the contract (only the bounds that exist, and only when the trip's time is inside them). */
export function contractFacilityHours(hours: DayHours | null | undefined, keyMinute: number | null): { facilityOpenMin?: number; facilityCloseMin?: number } {
  if (!hours || !insideHours(hours, keyMinute)) return {};
  return {
    ...(hours.openMin !== null ? { facilityOpenMin: hours.openMin } : {}),
    ...(hours.closeMin !== null ? { facilityCloseMin: hours.closeMin } : {}),
  };
}

/** "Accueil de 07:00 à 19:00", "Accueil dès 06:45", "Accueil jusqu'à 19:00". */
export function dayHoursText(hours: DayHours): string {
  if (hours.openMin !== null && hours.closeMin !== null) return `Accueil de ${formatMinute(hours.openMin)} à ${formatMinute(hours.closeMin)}`;
  if (hours.openMin !== null) return `Accueil dès ${formatMinute(hours.openMin)}`;
  return `Accueil jusqu'à ${formatMinute(hours.closeMin)}`;
}

/** Why a trip's time is outside the hours: « RDV à 06:30, avant l'accueil (07:00) », or null. */
export function outsideHoursText(hours: DayHours | null, direction: "OUTBOUND" | "RETURN", keyMinute: number | null): string | null {
  if (!hours || keyMinute === null || insideHours(hours, keyMinute)) return null;
  const what = direction === "OUTBOUND" ? "RDV" : "Fin de séance";
  return hours.openMin !== null && keyMinute < hours.openMin
    ? `${what} à ${formatMinute(keyMinute)}, avant l'accueil (${formatMinute(hours.openMin)})`
    : `${what} à ${formatMinute(keyMinute)}, après la fermeture (${formatMinute(hours.closeMin)})`;
}

/**
 * The week's hours in a few words, consecutive days with the same hours grouped:
 * "Lun → Ven 07:00–19:00, Sam 08:00–12:00"; "" when none.
 */
export function describeOpeningHours(hours: readonly OpeningHours[]): string {
  const groups: { first: number; last: number; open: number; close: number }[] = [];
  for (const h of [...hours].sort((a, b) => a.weekday - b.weekday)) {
    const previous = groups.at(-1);
    if (previous && previous.last === h.weekday - 1 && previous.open === h.openMinute && previous.close === h.closeMinute) {
      previous.last = h.weekday;
    } else {
      groups.push({ first: h.weekday, last: h.weekday, open: h.openMinute, close: h.closeMinute });
    }
  }
  return groups
    .map((g) => {
      const days =
        g.first === g.last
          ? WEEKDAY_SHORT[g.first]
          : g.last === g.first + 1
            ? `${WEEKDAY_SHORT[g.first]} ${WEEKDAY_SHORT[g.last]}`
            : `${WEEKDAY_SHORT[g.first]} → ${WEEKDAY_SHORT[g.last]}`;
      return `${days} ${formatMinute(g.open)}–${formatMinute(g.close)}`;
    })
    .join(", ");
}
