/**
 * Pure rules of the trips screen: key time, which row actions are possible,
 * badge tones. No server-only import (shared by server pages, client rows and tests).
 */
import type { SharingStatus, TripDirection, TripStatus } from "@prisma/client";
import type { BadgeTone } from "@/components/ui/badge";
import { isShareable } from "@/lib/domain/rules";

/** The time that drives a trip: appointment for an outbound leg, end of session for a return leg. */
export function keyMinute(trip: {
  direction: TripDirection;
  appointmentMinute: number | null;
  readyMinute: number | null;
}): number | null {
  return trip.direction === "OUTBOUND" ? trip.appointmentMinute : trip.readyMinute;
}

/** Short label of the key time column. */
export function keyMinuteLabel(direction: TripDirection): string {
  return direction === "OUTBOUND" ? "RDV" : "Fin de séance";
}

/** Long label of the time field in forms. */
export function timeFieldLabel(direction: TripDirection): string {
  return direction === "OUTBOUND" ? "Heure du rendez-vous" : "Heure de fin de séance";
}

export function timeFieldHint(direction: TripDirection): string {
  return direction === "OUTBOUND"
    ? "Arrivée au lieu de soins au plus tard à cette heure."
    : "Prise en charge au lieu de soins au plus tôt à cette heure.";
}

/** Statuses of a trip that has not started yet: it can still be cancelled or rescheduled. */
const OPEN_STATUSES: readonly TripStatus[] = ["PLANNED", "ASSIGNED"];

export function canCancel(status: TripStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

export function canRestore(status: TripStatus): boolean {
  return status === "CANCELLED";
}

export function canEditTime(status: TripStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

/**
 * What the regulator can record about shared transport on a trip: the patient's
 * answer. PROPOSED is not recorded by hand: it means "grouped by the optimizer"
 * and is set (timestamped) and withdrawn by each optimization run
 * (lib/optimizer/persist.ts), which would silently erase a manual proposal.
 */
export type SharingDecision = Extract<SharingStatus, "ACCEPTED" | "REFUSED">;

export const SHARING_DECISION_LABELS: Record<SharingDecision, string> = {
  ACCEPTED: "Partage accepté",
  REFUSED: "Partage refusé",
};

/**
 * Sharing decisions available on a trip. Never on a trip whose prescription does
 * not allow sharing (NOT_ELIGIBLE), nor on a cancelled trip. A recorded answer can
 * be corrected (the patient changes their mind), hence the opposite answer stays available.
 */
export function sharingDecisionsFor(trip: {
  sharingAllowed: boolean;
  sharingStatus: SharingStatus;
  status: TripStatus;
}): SharingDecision[] {
  if (!trip.sharingAllowed || trip.sharingStatus === "NOT_ELIGIBLE" || trip.status === "CANCELLED") return [];
  switch (trip.sharingStatus) {
    case "NOT_PROPOSED":
    case "PROPOSED":
      return ["ACCEPTED", "REFUSED"];
    case "ACCEPTED":
      return ["REFUSED"];
    case "REFUSED":
      return ["ACCEPTED"];
    default:
      return [];
  }
}

/**
 * Shared in the current plan although the patient refused (or the prescription
 * does not allow it): the plan contradicts the patient's word until the day is
 * re-optimized (the optimizer no longer groups such a trip, see isShareable).
 */
export function sharingConflict(trip: {
  shared: boolean;
  status: TripStatus;
  sharingAllowed: boolean;
  sharingStatus: SharingStatus;
}): boolean {
  return trip.shared && trip.status !== "CANCELLED" && trip.status !== "NO_SHOW" && !isShareable(trip);
}

/** Prescription dates are compared as "YYYY-MM-DD" strings (inclusive bounds). */
export function prescriptionValidOn(prescription: { validFrom: string; validTo: string }, isoDate: string): boolean {
  return prescription.validFrom <= isoDate && isoDate <= prescription.validTo;
}

export const TRIP_STATUS_TONES: Record<TripStatus, BadgeTone> = {
  PLANNED: "warning",
  ASSIGNED: "brand",
  PICKED_UP: "info",
  DROPPED_OFF: "success",
  CANCELLED: "neutral",
  NO_SHOW: "danger",
};

export const SHARING_STATUS_TONES: Record<SharingStatus, BadgeTone> = {
  NOT_ELIGIBLE: "neutral",
  NOT_PROPOSED: "neutral",
  PROPOSED: "info",
  ACCEPTED: "success",
  REFUSED: "danger",
};
