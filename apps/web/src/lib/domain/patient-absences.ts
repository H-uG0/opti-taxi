/**
 * Dated absences of a patient (hospitalisation, holidays, another absence):
 * no trip is generated on their days, and the trips already created are
 * cancelled by the application — origin SYSTEM, so the completion of the
 * horizon brings them back once the absence is shortened or removed.
 *
 * Health data: the planning screens (Courses, planning) name a hospitalisation
 * and nothing else (« Absence du patient »), with the dates only; the free
 * text of the absence stays on the patient record, never on a trip nor in the
 * audit trail — the rule of the staff absences (lib/staff/day-crews.ts).
 *
 * Pure module (no server-only import).
 */
import type { CancellationReason, PatientAbsenceKind } from "@prisma/client";
import { addDays, formatShortDate, toIsoDate } from "@/lib/time";

export const PATIENT_ABSENCE_KINDS = ["HOSPITALIZATION", "HOLIDAY", "OTHER"] as const satisfies readonly PatientAbsenceKind[];

/** Reasons on the patient record. */
export const PATIENT_ABSENCE_KIND_LABELS: Record<PatientAbsenceKind, string> = {
  HOSPITALIZATION: "Hospitalisation",
  HOLIDAY: "Vacances",
  OTHER: "Autre absence",
};

/** Longest absence entered at once (as the staff's). */
export const MAX_PATIENT_ABSENCE_DAYS = 366;
export const PATIENT_ABSENCE_NOTE_MAX = 200;
/** Absences ended this many days ago or less stay on the record (to correct a mistake). */
export const RECENT_ABSENCE_DAYS = 30;

export type DatedPeriod = { startDate: string; endDate: string };

/** The reason a planning screen shows: « Hospitalisation », else « Absence ». */
export function planningAbsenceLabel(kind: PatientAbsenceKind): string {
  return kind === "HOSPITALIZATION" ? "Hospitalisation" : "Absence";
}

/** The cancellation reason of the trips an absence cancels. */
export function absenceCancellationReason(kind: PatientAbsenceKind): CancellationReason {
  return kind === "HOSPITALIZATION" ? "HOSPITALIZATION" : "PATIENT_ABSENCE";
}

/** "le 16/11/2026", "du 16/11/2026 au 20/11/2026". */
export function periodText(period: DatedPeriod): string {
  return period.startDate === period.endDate
    ? `le ${formatShortDate(period.startDate)}`
    : `du ${formatShortDate(period.startDate)} au ${formatShortDate(period.endDate)}`;
}

/** Note of the trips an absence cancels: its dates only (« Hospitalisation (du … au …) » in Courses). */
export function absenceCancellationNote(period: DatedPeriod): string {
  return periodText(period);
}

/** "Hospitalisation du 16/11/2026 au 20/11/2026", "Vacances le 24/12/2026": for the patient record. */
export function absenceText(absence: DatedPeriod & { kind: PatientAbsenceKind }): string {
  return `${PATIENT_ABSENCE_KIND_LABELS[absence.kind]} ${periodText(absence)}`;
}

/** Does one of the periods (stored as @db.Date) cover this date? */
export function coveredOn(periods: readonly { startDate: Date; endDate: Date }[] | undefined, isoDate: string): boolean {
  return (periods ?? []).some((p) => toIsoDate(p.startDate) <= isoDate && isoDate <= toIsoDate(p.endDate));
}

/** The days of the period from `todayIso` on, whose open trips an absence (or a closure) cancels; null when over. */
export function periodFrom(period: DatedPeriod, todayIso: string): DatedPeriod | null {
  if (period.endDate < todayIso) return null;
  return { startDate: period.startDate > todayIso ? period.startDate : todayIso, endDate: period.endDate };
}

/** Absences of the record: those not ended more than RECENT_ABSENCE_DAYS ago. */
export function recordAbsenceFrom(todayIso: string): string {
  return addDays(todayIso, -RECENT_ABSENCE_DAYS);
}

/** "Hospitalisé jusqu'au 20/11" style badge of the record header: the absence covering today, if any. */
export function currentAbsence<T extends DatedPeriod>(absences: readonly T[], todayIso: string): T | null {
  return absences.find((a) => a.startDate <= todayIso && todayIso <= a.endDate) ?? null;
}
