/**
 * Who recorded a patient's answer to shared transport, or a stop status
 * (picked up, dropped off, absent), and when: sentences shown on /courses,
 * built with the shared wording of @/lib/record-trace.
 * Pure: no server-only import so vitest can cover it.
 */
import type { SharingStatus, StopKind, TripDirection, TripStatus } from "@prisma/client";
import { isSameEpisode, type LegKey } from "@/lib/domain/no-show";
import { recordTrace, sharingAnswerWords, type RecordTrace } from "@/lib/record-trace";

export { formatDayTime, recordTrace, UNKNOWN_AUTHOR, type RecordTrace } from "@/lib/record-trace";

/**
 * Trace of the patient's current answer to shared transport (accepted or
 * refused), null otherwise (see sharingAnswerWords).
 */
export function sharingAnswerTrace(trip: {
  sharingStatus: SharingStatus;
  sharingRespondedAt: Date | null;
  sharingRespondedBy: { name: string } | null;
}): RecordTrace | null {
  const what = sharingAnswerWords(trip.sharingStatus);
  if (!trip.sharingRespondedAt || !what) return null;
  return recordTrace(what, trip.sharingRespondedAt, trip.sharingRespondedBy?.name);
}

export type CompletedStop = {
  kind: StopKind;
  completedAt: Date | null;
  completedBy: { name: string } | null;
};

/**
 * Traces of the statuses the crew recorded on the trip's stops, pickup first:
 * those behind the trip status shown (picked up, dropped off, absent). The
 * last one is the current status. An absence is recorded on the pickup stop.
 */
export function stopStatusTraces(status: TripStatus, stops: readonly CompletedStop[]): RecordTrace[] {
  const traceOf = (kind: StopKind, what: string): RecordTrace[] => {
    const stop = stops.find((s) => s.kind === kind && s.completedAt);
    return stop?.completedAt ? [recordTrace(what, stop.completedAt, stop.completedBy?.name)] : [];
  };
  switch (status) {
    case "PICKED_UP":
      return traceOf("PICKUP", "Prise en charge enregistrée");
    case "DROPPED_OFF":
      return [...traceOf("PICKUP", "Prise en charge enregistrée"), ...traceOf("DROPOFF", "Dépose enregistrée")];
    case "NO_SHOW":
      return traceOf("PICKUP", "Absence enregistrée");
    default:
      return [];
  }
}

/** A trip of the day as the page loads it, enough to find the outbound leg of a return. */
export type DayTripWithStops = LegKey & { direction: TripDirection; status: TripStatus; stops: readonly CompletedStop[] };

/**
 * Who recorded, and when, the absence on the outbound leg that flags a return
 * trip « Aller : patient absent »: the outbound legs of the same day and care
 * episode closed as absent (lib/domain/no-show), first traced one. Shown on
 * the return trip itself, so that the author is known even when the outbound
 * trip is filtered out of the list. Null when no absence is traced.
 */
export function outboundNoShowTrace(returnTrip: LegKey, dayTrips: readonly DayTripWithStops[]): RecordTrace | null {
  for (const trip of dayTrips) {
    if (trip.direction !== "OUTBOUND" || trip.status !== "NO_SHOW" || !isSameEpisode(trip, returnTrip)) continue;
    const pickup = trip.stops.find((s) => s.kind === "PICKUP" && s.completedAt);
    if (pickup?.completedAt) return recordTrace("Absence à l'aller enregistrée", pickup.completedAt, pickup.completedBy?.name);
  }
  return null;
}
