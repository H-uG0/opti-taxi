/**
 * Cancellation of a trip: why (reason), who (a person in « Annuler la course »,
 * or the referential sync), when, and whether it came late. A cancellation by
 * the sync is brought back automatically once its cause is gone
 * (trip-generation.ts, trip-revival.ts); a person's never is.
 *
 * Pure module (no server-only import): shared by the server actions, the
 * trips screen, the patient page, the history script and the tests.
 */
import type { CancellationOrigin, CancellationReason, TripDirection } from "@prisma/client";
import { addDays, fromIsoDate, isoDateOf, minuteOfDay } from "@/lib/time";

export const CANCELLATION_REASON_LABELS: Record<CancellationReason, string> = {
  PATIENT: "Demande du patient",
  FACILITY: "Séance annulée ou déplacée par l'établissement",
  HOSPITALIZATION: "Hospitalisation",
  OWN_MEANS: "Patient venu par ses propres moyens",
  DECEASED: "Décès",
  PARTNER: "Confiée à un confrère",
  REFERENTIAL_SYNC: "Synchronisation du référentiel",
  REGULATION: "Décision de la régulation",
  OTHER: "Autre motif",
};

/** Reasons a person can choose in « Annuler la course » (the sync's own is set by the application only). */
export const USER_CANCELLATION_REASONS = [
  "PATIENT",
  "FACILITY",
  "HOSPITALIZATION",
  "OWN_MEANS",
  "DECEASED",
  "PARTNER",
  "REGULATION",
  "OTHER",
] as const satisfies readonly CancellationReason[];

export type UserCancellationReason = (typeof USER_CANCELLATION_REASONS)[number];

export const CANCELLATION_NOTE_MAX = 200;

/** Default of the setting lateCancellationHours (schema default). */
export const DEFAULT_LATE_CANCELLATION_HOURS = 2;

/** Lateness threshold bounds (hours before the pickup), setting lateCancellationHours. */
export const LATE_CANCELLATION_HOURS = { min: 0, max: 72 } as const;

const DAY_MS = 86_400_000;

/**
 * Minutes from `now` to `minute` (minutes since midnight, Europe/Paris) on
 * `isoDate`; negative once passed. A summer-time change in between shifts it
 * by an hour at most, which a threshold in hours tolerates.
 */
export function minutesUntil(isoDate: string, minute: number, now: Date): number {
  const days = Math.round((fromIsoDate(isoDate).getTime() - fromIsoDate(isoDateOf(now)).getTime()) / DAY_MS);
  return days * 1440 + minute - minuteOfDay(now);
}

export type PickupTiming = {
  serviceDate: string;
  direction: TripDirection;
  plannedPickupMinute: number | null;
  appointmentMinute: number | null;
  readyMinute: number | null;
};

/**
 * The pickup the cancellation is measured against: the planned one when the
 * trip is in a route, otherwise the appointment (outbound, a later bound of
 * the pickup) or the end of session (return). Null without any time.
 */
export function pickupReferenceMinute(trip: Omit<PickupTiming, "serviceDate">): number | null {
  if (trip.plannedPickupMinute !== null) return trip.plannedPickupMinute;
  return trip.direction === "OUTBOUND" ? trip.appointmentMinute : trip.readyMinute;
}

/** Cancelled less than `hours` before the pickup (or after it): a late cancellation. */
export function isLateCancellation(trip: PickupTiming, now: Date, hours: number): boolean {
  const pickup = pickupReferenceMinute(trip);
  if (pickup === null) return false;
  return minutesUntil(trip.serviceDate, pickup, now) < hours * 60;
}

/** Fields a cancellation writes on the trip (with status CANCELLED and the planning cleared). */
export type CancellationFields = {
  cancellationReason: CancellationReason;
  cancellationOrigin: CancellationOrigin;
  cancellationNote: string | null;
  cancelledAt: Date;
  cancelledById: string;
  lateCancellation: boolean;
};

/** « Annuler la course » by a person. */
export function userCancellation(input: {
  reason: UserCancellationReason;
  note: string | null;
  actorId: string;
  now: Date;
  late: boolean;
}): CancellationFields {
  return {
    cancellationReason: input.reason,
    cancellationOrigin: "USER",
    cancellationNote: input.note,
    cancelledAt: input.now,
    cancelledById: input.actorId,
    lateCancellation: input.late,
  };
}

/**
 * A cancellation by the referential sync, on behalf of `actorId` (the
 * regulator whose change caused it). `cause` says which change ("Patient
 * désactivé"…); it is never late: the patient did not cancel.
 */
export function systemCancellation(actorId: string, now: Date, cause: string | null): CancellationFields {
  return {
    cancellationReason: "REFERENTIAL_SYNC",
    cancellationOrigin: "SYSTEM",
    cancellationNote: cause,
    cancelledAt: now,
    cancelledById: actorId,
    lateCancellation: false,
  };
}

/** A restored (or revived) trip forgets its cancellation. */
export const NO_CANCELLATION = {
  cancellationReason: null,
  cancellationOrigin: null,
  cancellationNote: null,
  cancelledAt: null,
  cancelledById: null,
  lateCancellation: false,
} as const;

/** Only a cancellation by the sync may be undone without a person: never one a person chose. */
export function isSystemCancellation(trip: { status: string; cancellationOrigin: CancellationOrigin | null }): boolean {
  return trip.status === "CANCELLED" && trip.cancellationOrigin === "SYSTEM";
}

/** "Hospitalisation · tardive", "Synchronisation du référentiel (Patient désactivé)", "Motif non renseigné". */
export function cancellationLabel(trip: {
  cancellationReason: CancellationReason | null;
  cancellationNote: string | null;
  lateCancellation: boolean;
}): string {
  if (!trip.cancellationReason) return "Motif non renseigné";
  const reason = CANCELLATION_REASON_LABELS[trip.cancellationReason];
  const note = trip.cancellationNote?.trim();
  const base = note ? `${reason} (${note})` : reason;
  return trip.lateCancellation ? `${base} · tardive` : base;
}

/** Period the patient page counts absences and cancellations over. */
export const PATIENT_HISTORY_DAYS = 90;

/** First service day of that period, from today. */
export function patientHistoryStart(todayIso: string): string {
  return addDays(todayIso, -PATIENT_HISTORY_DAYS);
}

export type PatientCancellationStats = { noShows: number; lateCancellations: number; cancellations: number };

/** Cancellations that say nothing about the patient: handed over to a partner company, decided by the regulation. */
const NOT_THE_PATIENTS: readonly (CancellationReason | null)[] = ["PARTNER", "REGULATION", "REFERENTIAL_SYNC"];

/**
 * What the patient page counts: « patient absent » (NO_SHOW), and the
 * cancellations a person recorded for the patient's sake, late ones apart.
 * The sync's, a partner company's trip and the regulation's own decisions
 * say nothing about the patient.
 */
export function patientCancellationStats(
  trips: readonly {
    status: string;
    cancellationOrigin: CancellationOrigin | null;
    cancellationReason: CancellationReason | null;
    lateCancellation: boolean;
  }[],
): PatientCancellationStats {
  const stats: PatientCancellationStats = { noShows: 0, lateCancellations: 0, cancellations: 0 };
  for (const trip of trips) {
    if (trip.status === "NO_SHOW") stats.noShows += 1;
    if (trip.status !== "CANCELLED" || trip.cancellationOrigin === "SYSTEM" || NOT_THE_PATIENTS.includes(trip.cancellationReason)) {
      continue;
    }
    stats.cancellations += 1;
    if (trip.lateCancellation) stats.lateCancellations += 1;
  }
  return stats;
}
