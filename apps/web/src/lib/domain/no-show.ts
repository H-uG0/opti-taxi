/**
 * Outbound leg closed as "patient absent" and its return leg of the same day.
 *
 * The patient probably never reached the facility: the return trip should be
 * checked (call the patient, or cancel it) before a crew drives there. Used
 * by the driver roadmap (/chauffeur), the planning (/planning) and the trips
 * list (/courses). Pure module: no server-only import, unit-tested.
 */
import type { TripDirection, TripStatus } from "@prisma/client";

/** The fields that pair the outbound and return legs of a patient's care on one day. */
export type LegKey = { patientId: string; recurrenceId: string | null; facilityId: string | null };

/**
 * Whether two legs of the same day belong to the same care episode: same
 * patient, and same recurrence when both come from one (a recurrence makes
 * both legs), otherwise same facility.
 */
export function isSameEpisode(a: LegKey, b: LegKey): boolean {
  if (a.patientId !== b.patientId) return false;
  if (a.recurrenceId !== null && b.recurrenceId !== null) return a.recurrenceId === b.recurrenceId;
  return a.facilityId !== null && a.facilityId === b.facilityId;
}

/**
 * Return trips whose outbound leg of the same day was closed as "patient
 * absent" (on any vehicle): the patient probably never reached the facility,
 * so the crew calls the regulator before going there to collect them.
 */
export function returnTripsAfterOutboundNoShow(
  returnTrips: readonly (LegKey & { id: string })[],
  outboundNoShows: readonly LegKey[],
): Set<string> {
  return new Set(
    returnTrips.filter((trip) => outboundNoShows.some((outbound) => isSameEpisode(outbound, trip))).map((trip) => trip.id),
  );
}

/** Return trips still to do: not started, not cancelled, not already closed as absent. */
const OPEN_RETURN_STATUSES: readonly TripStatus[] = ["PLANNED", "ASSIGNED"];

/** A trip of one service day, as the regulator screens load it. */
export type DayLeg = LegKey & { id: string; direction: TripDirection; status: TripStatus };

/**
 * Regulator view of the rule: among the trips of ONE service day, the return
 * trips still to do whose outbound leg was closed as "patient absent". A
 * return already cancelled, absent, picked up or dropped off needs no check.
 */
export function returnsToCheckAfterNoShow(trips: readonly DayLeg[]): Set<string> {
  const outboundNoShows = trips.filter((trip) => trip.direction === "OUTBOUND" && trip.status === "NO_SHOW");
  if (outboundNoShows.length === 0) return new Set();
  const openReturns = trips.filter((trip) => trip.direction === "RETURN" && OPEN_RETURN_STATUSES.includes(trip.status));
  return returnTripsAfterOutboundNoShow(openReturns, outboundNoShows);
}

/** Short flag shown on the return trip (badge, list entry). */
export const OUTBOUND_NO_SHOW_LABEL = "Aller\u00a0: patient absent — vérifier le retour";

/** Short flag of one entry in a list that already gives the advice once. */
export const OUTBOUND_NO_SHOW_SHORT_LABEL = "Aller\u00a0: patient absent";

/**
 * What the regulator should do about it. Always shown after a flag that
 * already says the patient was absent, so it does not repeat it.
 */
export const OUTBOUND_NO_SHOW_ADVICE =
  "Appelez le patient pour savoir s'il a rejoint l'établissement par ses propres moyens\u202f; sinon, annulez le retour.";
