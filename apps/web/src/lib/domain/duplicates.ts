/**
 * Coherence checks that warn without blocking: two trips of a patient the
 * same day (same leg, or during another care session), two recurrences of a
 * patient that overlap, a patient typed twice. And what forbids restoring a
 * cancelled trip. Pure module (dates "YYYY-MM-DD", times in minutes): shared
 * by the server actions, the pages and the tests.
 */
import type { TripDirection, TripStatus } from "@prisma/client";
import { addDays, formatMinute } from "@/lib/time";
import { hasSessionDates, intervalOf, rhythmOccursOn } from "./recurrence-rhythm";

// ---------------------------------------------------------------- trips of a day

export type DayTrip = {
  id: string;
  patientId: string;
  recurrenceId: string | null;
  facilityId: string | null;
  direction: TripDirection;
  status: TripStatus;
  appointmentMinute: number | null;
  readyMinute: number | null;
};

const GONE: readonly TripStatus[] = ["CANCELLED", "NO_SHOW"];

/** Session of a care on the day: from the appointment of its outbound leg to the end of session of its return leg. */
type Session = { start: number; end: number };

function sessionsOf(trips: readonly DayTrip[], exceptId: string): Session[] {
  const sessions: Session[] = [];
  for (const outbound of trips) {
    if (outbound.id === exceptId || outbound.direction !== "OUTBOUND" || outbound.appointmentMinute === null) continue;
    const back = trips.find(
      (t) =>
        t.id !== exceptId &&
        t.direction === "RETURN" &&
        t.readyMinute !== null &&
        (outbound.recurrenceId !== null ? t.recurrenceId === outbound.recurrenceId : t.facilityId === outbound.facilityId),
    );
    if (back && back.readyMinute !== null && back.readyMinute > outbound.appointmentMinute) {
      sessions.push({ start: outbound.appointmentMinute, end: back.readyMinute });
    }
  }
  return sessions;
}

export type TripConflict = { kind: "same_leg"; otherId: string; minute: number | null } | { kind: "during_session"; start: number; end: number };

/**
 * Two trips of a patient on the same leg with key times this close are one
 * transport typed twice (the wait allowed at a place of care, 45 min).
 */
export const SAME_LEG_MINUTES = 45;

function keyMinuteOf(t: DayTrip): number | null {
  return t.direction === "OUTBOUND" ? t.appointmentMinute : t.readyMinute;
}

/** Same leg, and the same care (same recurrence or facility) or key times within SAME_LEG_MINUTES. */
function sameLeg(trip: DayTrip, other: DayTrip): boolean {
  if (other.direction !== trip.direction) return false;
  if (trip.recurrenceId !== null && other.recurrenceId === trip.recurrenceId) return true;
  if (trip.facilityId !== null && other.facilityId === trip.facilityId) return true;
  const a = keyMinuteOf(trip);
  const b = keyMinuteOf(other);
  return a === null || b === null || Math.abs(a - b) <= SAME_LEG_MINUTES;
}

/**
 * What another trip of the same patient that day says about `trip`: a trip on
 * the same leg for the same care, or at nearly the same time (likely a
 * duplicate: two vehicles sent for one patient), or a key time falling inside
 * another care session. Two cares of the day (dialysis in the morning, a
 * consultation elsewhere in the afternoon) are not flagged. Cancelled and
 * absent trips are ignored.
 */
export function tripConflicts(trip: DayTrip, dayTrips: readonly DayTrip[]): TripConflict[] {
  if (GONE.includes(trip.status)) return [];
  const others = dayTrips.filter((t) => t.id !== trip.id && t.patientId === trip.patientId && !GONE.includes(t.status));
  const conflicts: TripConflict[] = others
    .filter((t) => sameLeg(trip, t))
    .map((t) => ({ kind: "same_leg", otherId: t.id, minute: keyMinuteOf(t) }));
  const key = keyMinuteOf(trip);
  if (key !== null) {
    const own = (t: DayTrip) =>
      trip.recurrenceId !== null ? t.recurrenceId === trip.recurrenceId : trip.facilityId !== null && t.facilityId === trip.facilityId;
    for (const session of sessionsOf(others.filter((t) => !own(t)), trip.id)) {
      if (key > session.start && key < session.end) conflicts.push({ kind: "during_session", ...session });
    }
  }
  return conflicts;
}

/** "Déjà un aller ce jour (RDV 07:30)" / "Pendant une autre séance (07:30 → 11:30)". */
export function conflictLabel(conflict: TripConflict, direction: TripDirection): string {
  if (conflict.kind === "during_session") {
    return `Pendant une autre séance du patient (${formatMinute(conflict.start)} → ${formatMinute(conflict.end)})`;
  }
  const leg = direction === "OUTBOUND" ? "un aller" : "un retour";
  const time = conflict.minute === null ? "" : ` (${direction === "OUTBOUND" ? "RDV" : "fin de séance"} ${formatMinute(conflict.minute)})`;
  return `Le patient a déjà ${leg} ce jour${time}`;
}

// ---------------------------------------------------------------- recurrences

export type OverlapRecurrence = {
  id: string;
  active: boolean;
  weekdays: number[];
  /** Every N weeks (lib/domain/recurrence-rhythm.ts); absent: every week. */
  intervalWeeks?: number;
  /** Explicit session dates; absent or empty: the weekly rhythm. */
  sessionDates?: string[];
  appointmentMinute: number;
  sessionMinutes: number;
  startDate: string;
  endDate: string | null;
};

/** Weeks of the common period looked at for two rhythms that are not plain weekly ones (a year). */
const OVERLAP_LOOKAHEAD_DAYS = 371;

/** A day both recurrences plan a session on: a common weekday for two weekly rhythms, else a common date. */
function shareADay(a: OverlapRecurrence, b: OverlapRecurrence): boolean {
  const plain = (r: OverlapRecurrence) => intervalOf(r) === 1 && !hasSessionDates(r);
  if (plain(a) && plain(b)) return a.weekdays.some((d) => b.weekdays.includes(d));
  const from = a.startDate > b.startDate ? a.startDate : b.startDate;
  const ends = [a.endDate, b.endDate, addDays(from, OVERLAP_LOOKAHEAD_DAYS)].filter((d): d is string => d !== null);
  const to = ends.sort()[0] ?? from;
  const [sparse, other] = hasSessionDates(a) ? [a, b] : [b, a];
  if (hasSessionDates(sparse)) return (sparse.sessionDates ?? []).some((d) => d >= from && d <= to && rhythmOccursOn(other, d));
  for (let day = from; day <= to; day = addDays(day, 1)) {
    if (rhythmOccursOn(a, day) && rhythmOccursOn(b, day)) return true;
  }
  return false;
}

/**
 * Active recurrences of one patient that overlap: a common session day
 * (weekday, or date for rhythms every N weeks or on explicit dates), periods
 * that meet, and sessions ([appointment, appointment + session]) that meet.
 * For each recurrence, the ids of those it overlaps.
 */
export function recurrenceOverlaps(recurrences: readonly OverlapRecurrence[]): Map<string, string[]> {
  const active = recurrences.filter((r) => r.active);
  const overlaps = new Map<string, string[]>();
  for (const a of active) {
    for (const b of active) {
      if (a.id === b.id) continue;
      const periods = (a.endDate === null || b.startDate <= a.endDate) && (b.endDate === null || a.startDate <= b.endDate);
      const commonDay = periods && shareADay(a, b);
      const sessions =
        a.appointmentMinute < b.appointmentMinute + b.sessionMinutes && b.appointmentMinute < a.appointmentMinute + a.sessionMinutes;
      if (commonDay && periods && sessions) overlaps.set(a.id, [...(overlaps.get(a.id) ?? []), b.id]);
    }
  }
  return overlaps;
}

// ---------------------------------------------------------------- patients

/** Lowercase, accents and punctuation removed, words sorted: "Hélène  Dupont-Martin" = "dupont martin helene". */
export function nameKey(firstName: string, lastName: string): string {
  return `${firstName} ${lastName}`
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .sort()
    .join(" ");
}

/** The last 9 digits of a French number ("06 12 34 56 78", "+33 6 12…"), null when too short. */
export function phoneKey(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 9 ? digits.slice(-9) : null;
}

/** Street address and postal code, accents, case and punctuation ignored. */
export function addressKey(place: { address: string; postalCode: string }): string {
  const street = place.address
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return `${street}|${place.postalCode.trim()}`;
}

export type PatientIdentity = { firstName: string; lastName: string; phone: string | null; address: string; postalCode: string };

export type SimilarityReason = "name" | "phone" | "address";

export const SIMILARITY_LABELS: Record<SimilarityReason, string> = {
  name: "même nom",
  phone: "même téléphone",
  address: "même adresse",
};

/** Existing patients that may be the one being typed: same name (accents aside), same phone, or same address. */
export function similarPatients<P extends PatientIdentity & { id: string }>(
  candidate: PatientIdentity,
  patients: readonly P[],
): { patient: P; reasons: SimilarityReason[] }[] {
  const name = nameKey(candidate.firstName, candidate.lastName);
  const phone = phoneKey(candidate.phone);
  const address = addressKey(candidate);
  return patients.flatMap((patient) => {
    const reasons: SimilarityReason[] = [];
    if (nameKey(patient.firstName, patient.lastName) === name) reasons.push("name");
    if (phone !== null && phoneKey(patient.phone) === phone) reasons.push("phone");
    if (addressKey(patient) === address) reasons.push("address");
    return reasons.length > 0 ? [{ patient, reasons }] : [];
  });
}

// ---------------------------------------------------------------- restoring a trip

export type RestoreCheck = {
  serviceDate: string;
  payer: "CPAM" | "PRIVATE";
  patientActive: boolean;
  /** Null for a one-off trip. */
  recurrenceActive: boolean | null;
  /** The validity of the trip's prescription, null when it has none. */
  prescription: { validFrom: string; validTo: string } | null;
};

/** Why a cancelled trip cannot be restored, or null. */
export function restoreBlocker(trip: RestoreCheck, todayIso: string): string | null {
  if (trip.serviceDate < todayIso) return "Date passée\u00a0: une course d'un jour passé ne se rétablit pas.";
  if (!trip.patientActive) {
    return "Le patient est désactivé\u00a0: réactivez-le d'abord\u202f; ses courses à partir de demain reviennent alors d'elles-mêmes, celles d'aujourd'hui se rétablissent ici.";
  }
  if (trip.recurrenceActive === false) {
    return "La récurrence de cette course est désactivée\u00a0: réactivez-la d'abord\u202f; ses courses à partir de demain reviennent alors d'elles-mêmes, celles d'aujourd'hui se rétablissent ici.";
  }
  if (trip.payer === "CPAM") {
    const p = trip.prescription;
    if (!p || trip.serviceDate < p.validFrom || trip.serviceDate > p.validTo) {
      return "Aucune prescription valide à cette date pour cette course CPAM\u00a0: saisissez ou corrigez la PMT du patient d'abord.";
    }
  }
  return null;
}
