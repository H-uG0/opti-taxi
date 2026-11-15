/**
 * What a crew signals or asks from its roadmap (DAY-05), and what the regulator sees of it:
 * - « Patient prêt à HH:MM » (the session ends earlier or later than planned): the return's end of session
 *   (Trip.readyMinute) changes at once, the regulator is told (« À traiter ») and re-places the return if needed;
 * - a cancellation or a return trip asked for: nothing changes until the regulator accepts it;
 * - the next session of the series, typed at the drop-off: passed on to the regulator.
 * Never a free text (health data): a reason from a list, a time, a date.
 *
 * Pure module (labels, bounds, texts, the return trip's data), shared by the driver's route, the regulator's
 * actions and screens, and the tests.
 */
import type { CancellationReason, FieldRequestKind, FieldRequestStatus, Prisma, Trip, TripDirection, TripStatus } from "@prisma/client";
import { addDays, formatMinute, formatShortDate } from "@/lib/time";

/** Reasons a crew may give for a cancellation (« Autre » leaves the details to a call). */
export const FIELD_CANCEL_REASONS = ["HOSPITALIZATION", "OWN_MEANS", "FACILITY", "PATIENT", "OTHER"] as const satisfies readonly CancellationReason[];
export type FieldCancelReason = (typeof FIELD_CANCEL_REASONS)[number];

export const FIELD_CANCEL_REASON_LABELS: Record<FieldCancelReason, string> = {
  HOSPITALIZATION: "Patient hospitalisé",
  OWN_MEANS: "Rentre par ses propres moyens",
  FACILITY: "Séance annulée ou reportée",
  PATIENT: "À la demande du patient",
  OTHER: "Autre (appeler la régulation)",
};

export const FIELD_REQUEST_KIND_LABELS: Record<FieldRequestKind, string> = {
  READY_TIME: "Fin de séance signalée",
  CANCEL: "Demande d'annulation",
  RETURN: "Demande de retour",
  NEXT_SESSION: "Prochaine séance",
};

export const FIELD_REQUEST_STATUS_LABELS: Record<FieldRequestStatus, string> = {
  PENDING: "en attente de la régulation",
  ACCEPTED: "acceptée par la régulation",
  REFUSED: "refusée par la régulation",
  NOTED: "prise en compte par la régulation",
};

/** Trips still to do: a request about them can still change something. */
export const OPEN_TRIP_STATUSES: readonly TripStatus[] = ["PLANNED", "ASSIGNED"];

/** Last minute a session can end on its day. */
const LAST_MINUTE = 24 * 60 - 1;
/** The next session is at most this many days ahead (a series runs on prescriptions of a few months at most). */
export const NEXT_SESSION_MAX_DAYS = 120;

/**
 * Why an end of session cannot be recorded (null: it can): within the day, never before the appointment the patient
 * was driven to.
 */
export function readyMinuteIssue(readyMinute: number, appointmentMinute: number | null): string | null {
  if (!Number.isInteger(readyMinute) || readyMinute < 0 || readyMinute > LAST_MINUTE) return "Heure invalide.";
  if (appointmentMinute !== null && readyMinute < appointmentMinute) {
    return `La séance ne peut pas finir avant le rendez-vous (${formatMinute(appointmentMinute)}).`;
  }
  return null;
}

/** Why a next session date cannot be passed on (null: it can): after the day of service, within NEXT_SESSION_MAX_DAYS. */
export function nextSessionIssue(nextDate: string, serviceDate: string): string | null {
  if (nextDate <= serviceDate) return "La prochaine séance doit être après aujourd'hui.";
  if (nextDate > addDays(serviceDate, NEXT_SESSION_MAX_DAYS)) return `La prochaine séance doit être dans les ${NEXT_SESSION_MAX_DAYS} jours.`;
  return null;
}

/** One request as the screens show it. */
export type FieldRequestView = {
  id: string;
  kind: FieldRequestKind;
  status: FieldRequestStatus;
  tripId: string;
  readyMinute: number | null;
  previousReadyMinute: number | null;
  cancellationReason: CancellationReason | null;
  /** YYYY-MM-DD. */
  nextSessionDate: string | null;
  /** ISO instant. */
  createdAt: string;
  /** First name and name of the crew member (employee), null when unknown. */
  createdBy: string | null;
};

function reasonLabel(reason: CancellationReason | null): string | null {
  return reason && (FIELD_CANCEL_REASONS as readonly string[]).includes(reason) ? FIELD_CANCEL_REASON_LABELS[reason as FieldCancelReason] : null;
}

/** What was signalled or asked, without the patient's name (the screen gives it beside): « Prêt à 11:20 (prévu 11:45) ». */
export function fieldRequestText(request: Pick<FieldRequestView, "kind" | "readyMinute" | "previousReadyMinute" | "cancellationReason" | "nextSessionDate">): string {
  switch (request.kind) {
    case "READY_TIME": {
      const was = request.previousReadyMinute !== null ? ` (prévu ${formatMinute(request.previousReadyMinute)})` : "";
      return `Patient prêt à ${formatMinute(request.readyMinute)}${was}`;
    }
    case "CANCEL": {
      const reason = reasonLabel(request.cancellationReason);
      return `Annulation demandée${reason ? `\u00a0: ${reason.toLowerCase()}` : ""}`;
    }
    case "RETURN":
      return `Retour demandé, patient prêt à ${formatMinute(request.readyMinute)}`;
    case "NEXT_SESSION":
      return `Prochaine séance le ${request.nextSessionDate ? formatShortDate(request.nextSessionDate) : "?"}`;
  }
}

/**
 * The crew's line about its own request, the request named so that everything agrees with it: « Patient prêt à 11:20 ·
 * demande envoyée à 10:05, en attente de la régulation ».
 */
export function fieldRequestCrewText(request: Pick<FieldRequestView, "kind" | "status" | "readyMinute" | "previousReadyMinute" | "cancellationReason" | "nextSessionDate">, sentAt: string): string {
  // An end of session is in force at once: the regulator only takes note of it.
  const state = request.kind === "READY_TIME" && request.status === "PENDING" ? "transmise à la régulation" : FIELD_REQUEST_STATUS_LABELS[request.status];
  return `${fieldRequestText(request)} · demande envoyée à ${sentAt}, ${state}`;
}

/** The leg this request concerns, as the screens name the trip (aller, retour). */
export function requestLeg(kind: FieldRequestKind): TripDirection | null {
  return kind === "READY_TIME" ? "RETURN" : kind === "RETURN" || kind === "NEXT_SESSION" ? "OUTBOUND" : null;
}

/** The outbound trip a return is created from, as read for « Demande de retour » accepted. */
export type OutboundForReturn = Pick<
  Trip,
  | "serviceDate"
  | "patientId"
  | "prescriptionId"
  | "facilityId"
  | "payer"
  | "allowedVehicleTypes"
  | "oneOffAddress"
  | "pickupAddress"
  | "pickupLat"
  | "pickupLng"
  | "dropoffAddress"
  | "dropoffLat"
  | "dropoffLng"
> & { returnSharingAllowed: boolean };

/**
 * The return trip of an accepted « Demande de retour »: the patient taken back from where the outbound left them
 * (care place) to where it picked them up, ready at `readyMinute`. A one-off trip (never a series' trip: the
 * recurrence makes its own legs), without a vehicle: the regulator places it (« Où placer », re-optimization).
 */
export function returnTripData(outbound: OutboundForReturn, readyMinute: number, note: string): Prisma.TripUncheckedCreateInput {
  return {
    serviceDate: outbound.serviceDate,
    direction: "RETURN",
    patientId: outbound.patientId,
    prescriptionId: outbound.prescriptionId,
    facilityId: outbound.facilityId,
    payer: outbound.payer,
    allowedVehicleTypes: outbound.allowedVehicleTypes,
    // The home side of a return is its drop-off: an address typed for the outbound only stays a one-off.
    oneOffAddress: outbound.oneOffAddress,
    pickupAddress: outbound.dropoffAddress,
    pickupLat: outbound.dropoffLat,
    pickupLng: outbound.dropoffLng,
    dropoffAddress: outbound.pickupAddress,
    dropoffLat: outbound.pickupLat,
    dropoffLng: outbound.pickupLng,
    appointmentMinute: null,
    readyMinute,
    sharingAllowed: outbound.returnSharingAllowed,
    sharingStatus: outbound.returnSharingAllowed ? "NOT_PROPOSED" : "NOT_ELIGIBLE",
    notes: note,
  };
}
