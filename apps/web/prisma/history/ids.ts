/**
 * Ids of the rows the history script creates. Trips and optimization runs get
 * a deterministic id with the HISTORY_ID_PREFIX (routes are found through
 * their run): a re-run deletes exactly these rows and nothing else. Ids stay
 * under the 64 characters the forms accept.
 */
import type { TripDirection } from "@prisma/client";

export const HISTORY_ID_PREFIX = "hist-";

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

export function isHistoryId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(HISTORY_ID_PREFIX);
}
