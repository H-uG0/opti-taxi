"use server";

import type { PatientAbsenceKind, Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  absenceCancellationNote,
  absenceCancellationReason,
  periodFrom,
  periodText,
  type DatedPeriod,
} from "@/lib/domain/patient-absences";
import { errorState, idSchema, invalidState, messageState, readForm, successState, type FormState } from "@/lib/forms";
import { evaluate } from "@/lib/optimizer/client";
import { refreshNotice, refreshRoutes } from "@/lib/planning/refresh-routes";
import { fromIsoDate, todayIso, toIsoDate } from "@/lib/time";
import { completeTrips, currentHorizon, reviveOneOffTrips } from "@/lib/trips/completion";
import { patientAbsenceSchema } from "./_lib/absence-schema";
import { CANCEL, describeSync, EMPTY_SYNC, isEmptySync, withCompletion, type SyncSummary } from "./_lib/trip-sync";
import { SYNC_TX_OPTIONS, syncOpenTrips } from "./_lib/trip-sync-db";

/**
 * Dated absences of a patient (« Absences » on the record). Each change is
 * followed, in its transaction, by the patient's trips: the open trips of the
 * absent days (from today on) are cancelled by the application with the
 * absence's reason (hospitalisation, else « absence du patient ») and its
 * dates as note; the days no longer covered get their trips back (those the
 * application cancelled, from tomorrow on, and the sessions not generated
 * yet), as after any change of the referential (lib/trips/completion.ts).
 * Traced with ids only: the reason and the note stay on the absence.
 */

const PATIENT_GONE = "Fiche introuvable : elle a peut-être été supprimée. Rechargez la page.";
const ABSENCE_GONE = "Cette absence n'existe plus : rechargez la page.";

type Actor = Awaited<ReturnType<typeof requireUser>>;

function refreshPages(patientId: string, summary: SyncSummary) {
  revalidatePath(`/patients/${patientId}`);
  if (!isEmptySync(summary)) revalidatePath("/", "layout");
}

/** Cancels the open trips of `period` (from today on) for the absence, then completes the horizon. */
async function followAbsences(
  tx: Prisma.TransactionClient,
  user: Actor,
  patientId: string,
  absence: (DatedPeriod & { kind: PatientAbsenceKind }) | null,
  leftRoutes: Set<string>,
): Promise<SyncSummary> {
  const today = todayIso();
  let summary = EMPTY_SYNC;
  const days = absence ? periodFrom(absence, today) : null;
  if (absence && days) {
    const reason = absenceCancellationReason(absence.kind);
    const note = absenceCancellationNote(absence);
    const window = { gte: fromIsoDate(days.startDate), lte: fromIsoDate(days.endDate) };
    summary = await syncOpenTrips(tx, { patientId, serviceDate: window }, () => CANCEL, today, leftRoutes, user, {
      cause: note,
      reason,
    });
    // Trips of these days the application already cancelled for an absence (its dates or reason changed): the new ones.
    await tx.trip.updateMany({
      where: {
        patientId,
        status: "CANCELLED",
        cancellationOrigin: "SYSTEM",
        cancellationReason: { in: ["HOSPITALIZATION", "PATIENT_ABSENCE"] },
        serviceDate: window,
      },
      data: { cancellationReason: reason, cancellationNote: note },
    });
  }
  // Days no longer covered: their trips come back (from tomorrow on), and the sessions not generated yet are created.
  const completion = await completeTrips(tx, user, await currentHorizon(tx, today), { patientId });
  const revivedOneOff = await reviveOneOffTrips(tx, user, { patientId });
  return withCompletion(summary, { created: completion.created, revived: completion.revived + revivedOneOff });
}

/** Another absence of the patient over these days, if any: two absences never overlap (one reason per day). */
async function overlapping(patientId: string, period: DatedPeriod, exceptId: string | null) {
  return db.patientAbsence.findFirst({
    where: {
      patientId,
      ...(exceptId ? { id: { not: exceptId } } : {}),
      startDate: { lte: fromIsoDate(period.endDate) },
      endDate: { gte: fromIsoDate(period.startDate) },
    },
    select: { startDate: true, endDate: true },
  });
}

function overlapMessage(other: { startDate: Date; endDate: Date }): string {
  return `Le patient a déjà une absence ${periodText({ startDate: toIsoDate(other.startDate), endDate: toIsoDate(other.endDate) })} : modifiez-la plutôt.`;
}

async function answer(message: string, summary: SyncSummary, leftRoutes: Set<string>): Promise<FormState> {
  const refresh = await refreshRoutes({ prisma: db, evaluate }, leftRoutes);
  return successState([message, describeSync(summary), refreshNotice(refresh)].filter(Boolean).join(" "));
}

export async function addPatientAbsence(patientId: string, _state: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const id = idSchema.safeParse(patientId);
  if (!id.success) return messageState(PATIENT_GONE);
  const values = readForm(formData);
  const parsed = patientAbsenceSchema.safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);
  const patient = await db.patient.findUnique({ where: { id: id.data }, select: { id: true } });
  if (!patient) return messageState(PATIENT_GONE);
  const other = await overlapping(patient.id, parsed.data, null);
  if (other) return errorState({ startDate: overlapMessage(other) }, values);

  const { kind, startDate, endDate, note } = parsed.data;
  const leftRoutes = new Set<string>();
  const summary = await db.$transaction(async (tx) => {
    const absence = await tx.patientAbsence.create({
      data: { patientId: patient.id, kind, startDate: fromIsoDate(startDate), endDate: fromIsoDate(endDate), note },
      select: { id: true },
    });
    // Ids only: the reason (hospitalisation…) and the note stay on the absence.
    await audit(tx, user, {
      action: "patient_absence.create",
      entity: "PatientAbsence",
      entityId: absence.id,
      details: { patientId: patient.id },
    });
    return followAbsences(tx, user, patient.id, parsed.data, leftRoutes);
  }, SYNC_TX_OPTIONS);
  refreshPages(patient.id, summary);
  return answer("Absence enregistrée.", summary, leftRoutes);
}

export async function updatePatientAbsence(
  patientId: string,
  absenceId: string,
  _state: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const patient = idSchema.safeParse(patientId);
  const absence = idSchema.safeParse(absenceId);
  if (!patient.success || !absence.success) return messageState(ABSENCE_GONE);
  const values = readForm(formData);
  const parsed = patientAbsenceSchema.safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);
  const existing = await db.patientAbsence.findFirst({
    where: { id: absence.data, patientId: patient.data },
    select: { id: true, patientId: true },
  });
  if (!existing) return messageState(ABSENCE_GONE);
  const other = await overlapping(existing.patientId, parsed.data, existing.id);
  if (other) return errorState({ startDate: overlapMessage(other) }, values);

  const { kind, startDate, endDate, note } = parsed.data;
  const leftRoutes = new Set<string>();
  const summary = await db.$transaction(async (tx) => {
    const { count } = await tx.patientAbsence.updateMany({
      where: { id: existing.id, patientId: existing.patientId },
      data: { kind, startDate: fromIsoDate(startDate), endDate: fromIsoDate(endDate), note },
    });
    if (count === 0) return null;
    await audit(tx, user, {
      action: "patient_absence.update",
      entity: "PatientAbsence",
      entityId: existing.id,
      details: { patientId: existing.patientId },
    });
    return followAbsences(tx, user, existing.patientId, parsed.data, leftRoutes);
  }, SYNC_TX_OPTIONS);
  if (!summary) return messageState(ABSENCE_GONE);
  refreshPages(existing.patientId, summary);
  return answer("Absence modifiée.", summary, leftRoutes);
}

export async function deletePatientAbsence(patientId: string, absenceId: string): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const patient = idSchema.safeParse(patientId);
  const absence = idSchema.safeParse(absenceId);
  if (!patient.success || !absence.success) return messageState("Demande invalide.");
  const [pid, aid] = [patient.data, absence.data];
  const leftRoutes = new Set<string>();
  const summary = await db.$transaction(async (tx) => {
    const removed = await tx.patientAbsence.deleteMany({ where: { id: aid, patientId: pid } });
    if (removed.count === 0) return null;
    await audit(tx, user, { action: "patient_absence.delete", entity: "PatientAbsence", entityId: aid, details: { patientId: pid } });
    return followAbsences(tx, user, pid, null, leftRoutes);
  }, SYNC_TX_OPTIONS);
  if (!summary) {
    revalidatePath(`/patients/${pid}`);
    return successState("Cette absence était déjà supprimée.");
  }
  refreshPages(pid, summary);
  return answer("Absence supprimée.", summary, leftRoutes);
}
