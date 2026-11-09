import "server-only";
import { db } from "@/lib/db";
import { GENERATION_INCLUDE, recurrencesInRange } from "@/lib/domain/trip-generation";
import { fromIsoDate } from "@/lib/time";
import { recurrencesWithoutTrip, type MissingRecurrence } from "./missing";

/** Read only: the active recurrences of `isoDate` that have no trip that day (see missing.ts). */
export async function loadRecurrencesWithoutTrip(isoDate: string): Promise<MissingRecurrence[]> {
  const recurrences = await db.recurrence.findMany({ where: recurrencesInRange(isoDate, isoDate), include: GENERATION_INCLUDE });
  if (recurrences.length === 0) return [];
  const trips = await db.trip.findMany({
    where: { serviceDate: fromIsoDate(isoDate), recurrenceId: { in: recurrences.map((r) => r.id) } },
    select: { recurrenceId: true },
  });
  return recurrencesWithoutTrip(recurrences, new Set(trips.map((t) => t.recurrenceId ?? "")), isoDate);
}
