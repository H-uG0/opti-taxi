/**
 * Ids of the rows the history script creates. Trips, one-off prescriptions,
 * optimization runs, audit events, absences, vehicles off the road and
 * rebuilt fill-ups get an id with the HISTORY_ID_PREFIX (routes are found
 * through their run, stops go with their route): a re-run deletes only these
 * rows (and keeps a one-off prescription that a trip created in the app uses,
 * ownership.ts). Ids stay under the 64 characters the forms accept.
 */
import type { TripDirection } from "@prisma/client";
import { isSimulatedId, SIMULATED_ID_PREFIX } from "@/lib/simulated";

export const HISTORY_ID_PREFIX = SIMULATED_ID_PREFIX;

/** "2026-10-12" -> "20261012". */
export function compactDate(isoDate: string): string {
  return isoDate.replaceAll("-", "");
}

/** "hist-20261012-<recurrence id>-out": one trip per recurrence, date and direction (the unique key of Trip). */
export function historyTripId(isoDate: string, recurrenceId: string, direction: TripDirection): string {
  return `${HISTORY_ID_PREFIX}${compactDate(isoDate)}-${recurrenceId}-${direction === "OUTBOUND" ? "out" : "ret"}`;
}

/** "hist-20261012-run2": second optimization of the 12 October planning. */
export function historyRunId(isoDate: string, round: number): string {
  return `${HISTORY_ID_PREFIX}${compactDate(isoDate)}-run${round}`;
}

/** "hist-20261012-ev0042": 42nd audit event written by the simulation of 12 October (numbered as written). */
export function historyAuditEventId(isoDate: string, sequence: number): string {
  return `${HISTORY_ID_PREFIX}${compactDate(isoDate)}-ev${String(sequence).padStart(4, "0")}`;
}

export function isHistoryId(id: string | null | undefined): boolean {
  return isSimulatedId(id);
}

/** "hist-20261012-": prefix of every row the simulation of 12 October owns, whatever its table. */
export function historyDatePrefix(isoDate: string): string {
  return `${HISTORY_ID_PREFIX}${compactDate(isoDate)}-`;
}

/** "hist-20261012-oneoff07-out": a leg of the 7th one-off care of the day (no recurrence). */
export function historyOneOffTripId(isoDate: string, episode: number, direction: TripDirection): string {
  return `${historyDatePrefix(isoDate)}oneoff${String(episode).padStart(2, "0")}-${direction === "OUTBOUND" ? "out" : "ret"}`;
}

/** "hist-20261012-rx07": its one-off prescription. */
export function historyPrescriptionId(isoDate: string, episode: number): string {
  return `${historyDatePrefix(isoDate)}rx${String(episode).padStart(2, "0")}`;
}

/** "hist-20261012-abs03": an absence that starts on the date (a sick day, a training day, a week of leave). */
export function historyAbsenceId(isoDate: string, index: number): string {
  return `${historyDatePrefix(isoDate)}abs${String(index).padStart(2, "0")}`;
}

/** "hist-20261012-una01": a vehicle off the road on the date. */
export function historyUnavailabilityId(isoDate: string, index: number): string {
  return `${historyDatePrefix(isoDate)}una${String(index).padStart(2, "0")}`;
}

/** "hist-fuel-<vehicle id>-3": the 3rd fill-up of a vehicle rebuilt from the simulated km (prisma/history/fuel.ts). */
export function historyFuelLogId(vehicleId: string, index: number): string {
  return `${HISTORY_ID_PREFIX}fuel-${vehicleId}-${index}`;
}
