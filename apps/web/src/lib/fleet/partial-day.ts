/**
 * Unavailability for part of a day (DAY-03): a vehicle out of service, or a person unavailable, from a
 * time of day (VehicleUnavailability / StaffAbsence startMinute on their first day), or back from a time
 * (endMinute on their last day). On such a day the vehicle works its shift cut at that time: the crews
 * of the day keep the person and the vehicle (lib/staff/day-crews.ts reads the whole-day rows only), and
 * the optimizer gets the shortened shift (build-request.ts decideVehicle). Pure module.
 */
import { formatMinute } from "@/lib/time";

/** A dated row with its optional times of day (null or absent: the whole day). */
export type DayBounded = { startDate: string; endDate: string; startMinute?: number | null; endMinute?: number | null };

/** Whether the row takes the whole of `isoDate` (its times, if any, fall on other days). */
export function coversWholeDay(row: DayBounded, isoDate: string): boolean {
  if (row.startDate > isoDate || row.endDate < isoDate) return false;
  const cutStart = row.startDate === isoDate && row.startMinute != null;
  const cutEnd = row.endDate === isoDate && row.endMinute != null;
  return !cutStart && !cutEnd;
}

/** The hours of `isoDate` a row leaves free: until its start, from its end (null: no bound that way). */
export type FreeHours = { from: number | null; until: number | null };

/**
 * The hours a row leaves free on `isoDate`, null when it does not touch the day or takes all of it. A row
 * starting and ending the same day (out from 11:00 to 15:00) leaves the morning only: one shift a day.
 */
export function freeHoursOn(row: DayBounded, isoDate: string): FreeHours | null {
  if (row.startDate > isoDate || row.endDate < isoDate || coversWholeDay(row, isoDate)) return null;
  if (row.startDate === isoDate && row.startMinute != null) return { from: null, until: row.startMinute };
  return { from: row.endMinute ?? null, until: null };
}

/** The hours several rows leave free on `isoDate` (the narrowest), null when none cuts the day. */
export function freeHoursOfAll(rows: readonly DayBounded[], isoDate: string): FreeHours | null {
  const cuts = rows.flatMap((row) => freeHoursOn(row, isoDate) ?? []);
  if (cuts.length === 0) return null;
  const froms = cuts.flatMap((cut) => (cut.from === null ? [] : [cut.from]));
  const untils = cuts.flatMap((cut) => (cut.until === null ? [] : [cut.until]));
  return { from: froms.length > 0 ? Math.max(...froms) : null, until: untils.length > 0 ? Math.min(...untils) : null };
}

/** « à partir de 11:20 », « jusqu'à 10:00 », « de 08:00 à 11:20 »: the hours taken, as the lists say them. */
export function takenHoursText(row: DayBounded, isoDate: string): string | null {
  const free = freeHoursOn(row, isoDate);
  if (!free) return null;
  if (free.until !== null) return `à partir de ${formatMinute(free.until)}`;
  return free.from !== null ? `jusqu'à ${formatMinute(free.from)}` : null;
}
