"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatAddress } from "@/lib/domain/rules";
import { planTripsFromRecurrences } from "@/lib/domain/trip-generation";
import { addDays, formatShortDate, fromIsoDate, todayIso, toIsoDate } from "@/lib/time";
import { idSchema } from "./_lib/form-parse";
import { formString, messageState, type ActionResult, type FormState } from "./_lib/form-state";
import { parsePatientForm, parsePrescriptionForm, parseRecurrenceForm, readRecurrenceForm } from "./_lib/schemas";
import { EXPIRY_WARNING_DAYS, isRenewalOf } from "./_lib/status";
import {
  CANCEL,
  describeSync,
  EMPTY_SYNC,
  isEmptySync,
  prescriptionTarget,
  recurrenceTarget,
  renewalTarget,
  withSyncNotice,
  type RecurrenceSchedule,
  type SyncSummary,
} from "./_lib/trip-sync";
import { SYNC_TX_OPTIONS, syncOpenTrips } from "./_lib/trip-sync-db";

const NOT_FOUND = "Fiche introuvable : elle a peut-être été supprimée. Rechargez la page.";

/** Patient pages are rendered per request; this refreshes the router cache of every /patients page. */
function revalidatePatients() {
  revalidatePath("/(regulator)/patients", "layout");
}

/** Trips feed the courses, planning, shared-arrival and driver pages: refresh them all when trips changed. */
function revalidateTrips(summary: SyncSummary) {
  if (!isEmptySync(summary)) revalidatePath("/", "layout");
}

function withSync(message: string, summary: SyncSummary): string {
  const sync = describeSync(summary);
  return sync ? `${message} ${sync}` : message;
}

const activeFlag = z.enum(["true", "false"]).transform((v) => v === "true");

const REACTIVATED_HINT =
  "Ses récurrences génèrent à nouveau des courses (« Générer la semaine » dans Courses). Les courses annulées à la désactivation se rétablissent une à une dans Courses.";

// ---------------------------------------------------------------- patient

export async function createPatient(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireUser("REGULATOR");
  const parsed = parsePatientForm(formData);
  if (!parsed.success) return parsed.state;

  const patient = await db.patient.create({ data: parsed.data, select: { id: true } });
  revalidatePatients();
  redirect(`/patients/${patient.id}`);
}

/**
 * Saves the patient. Its open trips to come follow: a new home address is
 * copied to them, and unticking « actif » cancels them.
 */
export async function updatePatient(patientId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  await requireUser("REGULATOR");
  const id = idSchema.safeParse(patientId);
  const parsed = parsePatientForm(formData);
  if (!parsed.success) return parsed.state;
  if (!id.success) return messageState(NOT_FOUND, null);

  const existing = await db.patient.findUnique({
    where: { id: id.data },
    select: { id: true, active: true, address: true, postalCode: true, city: true, lat: true, lng: true },
  });
  if (!existing) return messageState(NOT_FOUND, null);

  const data = parsed.data;
  const today = todayIso();
  const home = { address: formatAddress(data), lat: data.lat, lng: data.lng };
  const deactivated = existing.active && !data.active;
  const moved = home.address !== formatAddress(existing) || data.lat !== existing.lat || data.lng !== existing.lng;

  const summary = await db.$transaction(async (tx) => {
    await tx.patient.update({ where: { id: existing.id }, data });
    if (!deactivated && !moved) return EMPTY_SYNC;
    return syncOpenTrips(tx, { patientId: existing.id }, () => (deactivated ? CANCEL : { kind: "update", home }), today);
  }, SYNC_TX_OPTIONS);

  revalidatePatients();
  revalidateTrips(summary);
  redirect(withSyncNotice(`/patients/${existing.id}`, summary));
}

/** Deactivation keeps the history (no hard delete) and cancels the patient's open trips to come. */
export async function setPatientActive(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireUser("REGULATOR");
  const input = z
    .object({ patientId: idSchema, active: activeFlag })
    .safeParse({ patientId: formString(formData, "patientId"), active: formString(formData, "active") });
  if (!input.success) return { ok: false, message: "Demande invalide." };
  const { patientId, active } = input.data;
  const today = todayIso();

  const summary = await db.$transaction(async (tx) => {
    const { count } = await tx.patient.updateMany({ where: { id: patientId }, data: { active } });
    if (count === 0) return null;
    return active ? EMPTY_SYNC : syncOpenTrips(tx, { patientId }, () => CANCEL, today);
  }, SYNC_TX_OPTIONS);
  if (!summary) return { ok: false, message: NOT_FOUND };

  revalidatePatients();
  revalidatePath("/(regulator)/etablissements", "layout");
  revalidateTrips(summary);
  return { ok: true, message: active ? `Patient réactivé. ${REACTIVATED_HINT}` : withSync("Patient désactivé.", summary) };
}

// ---------------------------------------------------------------- prescriptions

export async function createPrescription(patientId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  await requireUser("REGULATOR");
  const id = idSchema.safeParse(patientId);
  const parsed = parsePrescriptionForm(formData);
  if (!parsed.success) return parsed.state;
  if (!id.success) return messageState(NOT_FOUND, null);

  const patient = await db.patient.findUnique({ where: { id: id.data }, select: { id: true } });
  if (!patient) return messageState(NOT_FOUND, null);

  const { validFrom, validTo, ...rest } = parsed.data;
  await db.prescription.create({
    data: { ...rest, patientId: patient.id, validFrom: fromIsoDate(validFrom), validTo: fromIsoDate(validTo) },
  });
  revalidatePatients();
  redirect(`/patients/${patient.id}#prescriptions`);
}

/**
 * Saves the prescription. Trips copy its rules when they are created and the
 * optimizer reads those copies: its open trips to come take the new mode
 * (allowed vehicles) and sharing scope, and those outside the new validity
 * are cancelled — in the same transaction.
 */
export async function updatePrescription(
  patientId: string,
  prescriptionId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireUser("REGULATOR");
  const ids = z.object({ patientId: idSchema, prescriptionId: idSchema }).safeParse({ patientId, prescriptionId });
  const parsed = parsePrescriptionForm(formData);
  if (!parsed.success) return parsed.state;
  if (!ids.success) return messageState(NOT_FOUND, null);

  // The prescription must belong to this patient.
  const existing = await db.prescription.findFirst({
    where: { id: ids.data.prescriptionId, patientId: ids.data.patientId },
    select: { id: true, patientId: true, mode: true, sharing: true, validFrom: true, validTo: true },
  });
  if (!existing) return messageState(NOT_FOUND, null);

  const { validFrom, validTo, ...rest } = parsed.data;
  const today = todayIso();
  const rulesChanged =
    rest.mode !== existing.mode ||
    rest.sharing !== existing.sharing ||
    validFrom !== toIsoDate(existing.validFrom) ||
    validTo !== toIsoDate(existing.validTo);
  const rules = { id: existing.id, mode: rest.mode, sharing: rest.sharing, validFrom, validTo };

  const summary = await db.$transaction(async (tx) => {
    await tx.prescription.update({
      where: { id: existing.id },
      data: { ...rest, validFrom: fromIsoDate(validFrom), validTo: fromIsoDate(validTo) },
    });
    if (!rulesChanged) return EMPTY_SYNC;
    return syncOpenTrips(tx, { prescriptionId: existing.id }, (trip) => prescriptionTarget(trip, rules), today);
  }, SYNC_TX_OPTIONS);

  revalidatePatients();
  revalidateTrips(summary);
  redirect(withSyncNotice(`/patients/${existing.patientId}#prescriptions`, summary));
}

/**
 * Deleting a prescription would cascade to its recurrences and detach its
 * trips: it is refused while anything still uses it.
 */
export async function deletePrescription(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireUser("REGULATOR");
  const input = z
    .object({ patientId: idSchema, prescriptionId: idSchema })
    .safeParse({ patientId: formString(formData, "patientId"), prescriptionId: formString(formData, "prescriptionId") });
  if (!input.success) return { ok: false, message: "Demande invalide." };
  const { patientId, prescriptionId } = input.data;

  // Single statement: deletes only if no recurrence and no trip reference it.
  const { count } = await db.prescription.deleteMany({
    where: { id: prescriptionId, patientId, recurrences: { none: {} }, trips: { none: {} } },
  });
  if (count === 1) {
    revalidatePatients();
    return { ok: true, message: "Prescription supprimée." };
  }

  const usage = await db.prescription.findFirst({
    where: { id: prescriptionId, patientId },
    select: { _count: { select: { recurrences: true, trips: true } } },
  });
  if (!usage) return { ok: false, message: NOT_FOUND };
  const { recurrences, trips } = usage._count;
  if (recurrences > 0) {
    return {
      ok: false,
      message: `Suppression impossible : ${recurrences === 1 ? "1 récurrence utilise" : `${recurrences} récurrences utilisent`} cette prescription. Rattachez-les à une autre prescription ou modifiez les dates de validité.`,
    };
  }
  return {
    ok: false,
    message: `Suppression impossible : ${trips === 1 ? "1 course est rattachée" : `${trips} courses sont rattachées`} à cette prescription (historique). Modifiez plutôt ses dates de validité.`,
  };
}

/**
 * Moves every recurrence of a prescription that ends soon (or has ended) to
 * its renewal. A recurrence has a single prescription and trips are only
 * generated inside its validity, so the trips still to come under the old
 * one (from tomorrow to its last day) are generated first; the open trips
 * inside the renewal's validity are attached to it.
 */
export async function attachRecurrencesToRenewal(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireUser("REGULATOR");
  const input = z
    .object({ patientId: idSchema, fromPrescriptionId: idSchema, toPrescriptionId: idSchema })
    .safeParse({
      patientId: formString(formData, "patientId"),
      fromPrescriptionId: formString(formData, "fromPrescriptionId"),
      toPrescriptionId: formString(formData, "toPrescriptionId"),
    });
  if (!input.success) return { ok: false, message: "Demande invalide." };
  const { patientId, fromPrescriptionId, toPrescriptionId } = input.data;

  const select = { id: true, mode: true, sharing: true, validFrom: true, validTo: true } as const;
  // Both prescriptions must belong to this patient.
  const [from, to] = await Promise.all([
    db.prescription.findFirst({ where: { id: fromPrescriptionId, patientId }, select }),
    db.prescription.findFirst({ where: { id: toPrescriptionId, patientId }, select }),
  ]);
  if (!from || !to) return { ok: false, message: NOT_FOUND };
  if (!isRenewalOf(from, to)) {
    return {
      ok: false,
      message:
        "Cette prescription ne prend pas la suite de l'autre (même mode, au plus tard le lendemain de sa fin) : modifiez les récurrences une à une.",
    };
  }

  const today = todayIso();
  const fromEnd = toIsoDate(from.validTo);
  if (fromEnd > addDays(today, EXPIRY_WARNING_DAYS)) {
    return {
      ok: false,
      message: `La prescription actuelle court jusqu'au ${formatShortDate(fromEnd)} : le rattachement au renouvellement se fait dans ses ${EXPIRY_WARNING_DAYS} derniers jours.`,
    };
  }
  const firstOldDay = addDays(today, 1);
  const renewal = {
    id: to.id,
    mode: to.mode,
    sharing: to.sharing,
    validFrom: toIsoDate(to.validFrom),
    validTo: toIsoDate(to.validTo),
  };

  const result = await db.$transaction(async (tx) => {
    const recurrences = await tx.recurrence.findMany({
      where: { patientId, prescriptionId: from.id },
      include: { patient: true, facility: true, prescription: true },
    });
    if (recurrences.length === 0) return null;
    const ids = recurrences.map((r) => r.id);
    const planned = firstOldDay <= fromEnd ? planTripsFromRecurrences(recurrences, firstOldDay, fromEnd) : [];
    const created = planned.length > 0 ? (await tx.trip.createMany({ data: planned, skipDuplicates: true })).count : 0;
    await tx.recurrence.updateMany({ where: { id: { in: ids } }, data: { prescriptionId: to.id } });
    const summary = await syncOpenTrips(tx, { recurrenceId: { in: ids } }, (trip) => renewalTarget(trip, renewal), today);
    return { count: recurrences.length, created, summary };
  }, SYNC_TX_OPTIONS);
  if (!result) return { ok: false, message: "Aucune récurrence n'est rattachée à cette prescription." };

  revalidatePatients();
  revalidatePath("/(regulator)/etablissements", "layout");
  revalidatePath("/", "layout");
  const moved =
    result.count === 1 ? "1 récurrence rattachée" : `${result.count} récurrences rattachées`;
  const generated =
    result.created > 0
      ? ` ${result.created === 1 ? "1 course générée" : `${result.created} courses générées`} jusqu'au ${formatShortDate(fromEnd)} sur l'ancienne prescription.`
      : "";
  return {
    ok: true,
    message: withSync(
      `${moved} à la prescription du ${formatShortDate(renewal.validFrom)} au ${formatShortDate(renewal.validTo)}.${generated}`,
      result.summary,
    ),
  };
}

// ---------------------------------------------------------------- recurrences

async function checkRecurrenceReferences(
  patientId: string,
  facilityId: string,
  prescriptionId: string,
  allowedInactiveFacilityId: string | null,
): Promise<Record<string, string[]> | null> {
  const [facility, prescription] = await Promise.all([
    db.facility.findUnique({ where: { id: facilityId }, select: { id: true, active: true } }),
    db.prescription.findFirst({ where: { id: prescriptionId, patientId }, select: { id: true } }),
  ]);
  const errors: Record<string, string[]> = {};
  if (!facility) errors.facilityId = ["Établissement introuvable"];
  else if (!facility.active && facility.id !== allowedInactiveFacilityId) {
    errors.facilityId = ["Cet établissement est désactivé"];
  }
  if (!prescription) errors.prescriptionId = ["Choisissez une prescription de ce patient"];
  return Object.keys(errors).length > 0 ? errors : null;
}

export async function createRecurrence(patientId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  await requireUser("REGULATOR");
  const id = idSchema.safeParse(patientId);
  const parsed = parseRecurrenceForm(formData);
  if (!parsed.success) return parsed.state;
  if (!id.success) return messageState(NOT_FOUND, null);

  const patient = await db.patient.findUnique({ where: { id: id.data }, select: { id: true } });
  if (!patient) return messageState(NOT_FOUND, null);

  const { startDate, endDate, ...rest } = parsed.data;
  const refErrors = await checkRecurrenceReferences(patient.id, rest.facilityId, rest.prescriptionId, null);
  if (refErrors) {
    return messageState("Vérifiez l'établissement et la prescription.", readRecurrenceForm(formData), refErrors);
  }

  await db.recurrence.create({
    data: {
      ...rest,
      patientId: patient.id,
      startDate: fromIsoDate(startDate),
      endDate: endDate ? fromIsoDate(endDate) : null,
    },
  });
  revalidatePatients();
  revalidatePath("/(regulator)/etablissements", "layout");
  redirect(`/patients/${patient.id}#recurrences`);
}

function sameSchedule(a: RecurrenceSchedule, b: RecurrenceSchedule): boolean {
  const days = (r: RecurrenceSchedule) => [...r.weekdays].sort((x, y) => x - y).join(",");
  return (
    a.facilityId === b.facilityId &&
    a.prescriptionId === b.prescriptionId &&
    days(a) === days(b) &&
    a.appointmentMinute === b.appointmentMinute &&
    a.sessionMinutes === b.sessionMinutes &&
    a.legs === b.legs &&
    a.startDate === b.startDate &&
    a.endDate === b.endDate
  );
}

/**
 * Saves the recurrence. Its open trips to come follow (see recurrenceTarget):
 * new time, facility and prescription; trips that no longer fit its days,
 * legs or period are cancelled.
 */
export async function updateRecurrence(
  patientId: string,
  recurrenceId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireUser("REGULATOR");
  const ids = z.object({ patientId: idSchema, recurrenceId: idSchema }).safeParse({ patientId, recurrenceId });
  const parsed = parseRecurrenceForm(formData);
  if (!parsed.success) return parsed.state;
  if (!ids.success) return messageState(NOT_FOUND, null);

  const existing = await db.recurrence.findFirst({
    where: { id: ids.data.recurrenceId, patientId: ids.data.patientId },
    select: {
      id: true,
      patientId: true,
      facilityId: true,
      prescriptionId: true,
      weekdays: true,
      appointmentMinute: true,
      sessionMinutes: true,
      legs: true,
      startDate: true,
      endDate: true,
    },
  });
  if (!existing) return messageState(NOT_FOUND, null);

  const { startDate, endDate, ...rest } = parsed.data;
  // Keeping the current facility is allowed even if it was deactivated since.
  const refErrors = await checkRecurrenceReferences(
    existing.patientId,
    rest.facilityId,
    rest.prescriptionId,
    existing.facilityId,
  );
  if (refErrors) {
    return messageState("Vérifiez l'établissement et la prescription.", readRecurrenceForm(formData), refErrors);
  }

  const before: RecurrenceSchedule = {
    facilityId: existing.facilityId,
    prescriptionId: existing.prescriptionId,
    weekdays: existing.weekdays,
    appointmentMinute: existing.appointmentMinute,
    sessionMinutes: existing.sessionMinutes,
    legs: existing.legs,
    startDate: toIsoDate(existing.startDate),
    endDate: existing.endDate ? toIsoDate(existing.endDate) : null,
  };
  const after: RecurrenceSchedule = {
    facilityId: rest.facilityId,
    prescriptionId: rest.prescriptionId,
    weekdays: rest.weekdays,
    appointmentMinute: rest.appointmentMinute,
    sessionMinutes: rest.sessionMinutes,
    legs: rest.legs,
    startDate,
    endDate,
  };
  const today = todayIso();

  const summary = await db.$transaction(async (tx) => {
    await tx.recurrence.update({
      where: { id: existing.id },
      data: { ...rest, startDate: fromIsoDate(startDate), endDate: endDate ? fromIsoDate(endDate) : null },
    });
    if (sameSchedule(before, after)) return EMPTY_SYNC;

    const prescription = await tx.prescription.findUniqueOrThrow({
      where: { id: after.prescriptionId },
      select: { id: true, mode: true, sharing: true, validFrom: true, validTo: true },
    });
    const facility = await tx.facility.findUniqueOrThrow({
      where: { id: after.facilityId },
      select: { address: true, postalCode: true, city: true, lat: true, lng: true },
    });
    const target = {
      ...after,
      prescription: {
        id: prescription.id,
        mode: prescription.mode,
        sharing: prescription.sharing,
        validFrom: toIsoDate(prescription.validFrom),
        validTo: toIsoDate(prescription.validTo),
      },
      facility: { address: formatAddress(facility), lat: facility.lat, lng: facility.lng },
    };
    return syncOpenTrips(tx, { recurrenceId: existing.id }, (trip) => recurrenceTarget(trip, before, target), today);
  }, SYNC_TX_OPTIONS);

  revalidatePatients();
  revalidatePath("/(regulator)/etablissements", "layout");
  revalidateTrips(summary);
  redirect(withSyncNotice(`/patients/${existing.patientId}#recurrences`, summary));
}

/** Deactivating a recurrence cancels its open trips to come; reactivating it does not bring them back. */
export async function setRecurrenceActive(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireUser("REGULATOR");
  const input = z
    .object({ patientId: idSchema, recurrenceId: idSchema, active: activeFlag })
    .safeParse({
      patientId: formString(formData, "patientId"),
      recurrenceId: formString(formData, "recurrenceId"),
      active: formString(formData, "active"),
    });
  if (!input.success) return { ok: false, message: "Demande invalide." };
  const { patientId, recurrenceId, active } = input.data;

  const recurrence = await db.recurrence.findFirst({
    where: { id: recurrenceId, patientId },
    select: { id: true, facility: { select: { name: true, active: true } } },
  });
  if (!recurrence) return { ok: false, message: NOT_FOUND };
  if (active && !recurrence.facility.active) {
    return {
      ok: false,
      message: `Réactivation impossible : l'établissement « ${recurrence.facility.name} » est désactivé. Modifiez d'abord la récurrence.`,
    };
  }

  const today = todayIso();
  const summary = await db.$transaction(async (tx) => {
    await tx.recurrence.update({ where: { id: recurrence.id }, data: { active } });
    return active ? EMPTY_SYNC : syncOpenTrips(tx, { recurrenceId: recurrence.id }, () => CANCEL, today);
  }, SYNC_TX_OPTIONS);

  revalidatePatients();
  revalidatePath("/(regulator)/etablissements", "layout");
  revalidateTrips(summary);
  return {
    ok: true,
    message: active
      ? "Récurrence réactivée : relancez « Générer la semaine » dans Courses ; les courses annulées à la désactivation se rétablissent dans Courses."
      : withSync("Récurrence désactivée.", summary),
  };
}
