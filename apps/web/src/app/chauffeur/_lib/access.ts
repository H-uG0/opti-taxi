/**
 * Who may record a status on a stop, and when: the route's driver or crew
 * mate, on the service day only (Europe/Paris). Pure (no server-only import):
 * used by the status route handler (api/chauffeur/stops/[id]/status) and the
 * unit tests.
 */
import { toIsoDate } from "@/lib/time";

export type StopAccess = "ok" | "not-yours" | "wrong-day";

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
  "wrong-day": "Les statuts se saisissent uniquement le jour de la tournée.",
};
