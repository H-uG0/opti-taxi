/**
 * Who may record a status on a stop, and when: the route's driver or crew
 * mate, on the service day only (Europe/Paris). Pure (no server-only import):
 * used by the status route handler (api/chauffeur/stops/[id]/status) and the
 * unit tests.
 */
import { addDays, minuteOfDay, todayIso, toIsoDate } from "@/lib/time";

export type StopAccess = "ok" | "not-yours" | "wrong-day";

/**
 * « Fin de tournée » (FLD-02): the day before stays open to the forgotten statuses until 03:00 (minute of the day,
 * Europe/Paris), for a route finished late in the evening or a phone charged again at home. The 3 h bound of a status
 * sent from the queue (observed-time.ts) does not apply there: the crew types the real time itself.
 */
export const LATE_ENTRY_UNTIL_MINUTE = 3 * 60;

/** The service days whose forgotten statuses the crew may still enter with their real time: yesterday until 03:00, today. */
export function lateEntryDates(now: Date): string[] {
  const today = todayIso(now);
  return minuteOfDay(now) < LATE_ENTRY_UNTIL_MINUTE ? [addDays(today, -1), today] : [today];
}

/** Who may enter a forgotten status, and on which days (lateEntryDates): « wrong-day » once the day is closed. */
export function lateEntryAccess(
  route: { driverId: string | null; crewMateId: string | null; serviceDate: Date },
  driverId: string,
  now: Date,
): StopAccess {
  if (!driverId || (route.driverId !== driverId && route.crewMateId !== driverId)) return "not-yours";
  return lateEntryDates(now).includes(toIsoDate(route.serviceDate)) ? "ok" : "wrong-day";
}

/**
 * `route.serviceDate` is the @db.Date column (UTC midnight); `today` is the
 * caller's reading of the clock, "YYYY-MM-DD" (todayIso). The crew check comes
 * first, so another driver learns nothing about the route's date.
 */
export function stopAccess(
  route: { driverId: string | null; crewMateId: string | null; serviceDate: Date },
  driverId: string,
  today: string,
): StopAccess {
  if (!driverId || (route.driverId !== driverId && route.crewMateId !== driverId)) return "not-yours";
  if (toIsoDate(route.serviceDate) !== today) return "wrong-day";
  return "ok";
}

/** Same answer for a missing stop and someone else's stop: no information leak. */
export const STOP_ACCESS_ERRORS: Record<Exclude<StopAccess, "ok">, string> = {
  "not-yours": "Cet arrêt ne fait pas partie de vos tournées.",
  "wrong-day": "Les statuts se saisissent le jour de la tournée («\u202fFin de tournée\u202f» jusqu'à 03:00 le lendemain)\u00a0: appelez la régulation.",
};
