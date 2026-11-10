"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { audit, auditRead } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { SIMILARITY_LABELS, similarPatients } from "@/lib/domain/duplicates";
import { formatAddress } from "@/lib/domain/rules";
import { evaluate } from "@/lib/optimizer/client";
import {
  NOTHING_REFRESHED,
  refreshNotice,
  refreshRoutes,
  withRefreshNotice,
  type RefreshOutcome,
} from "@/lib/planning/refresh-routes";
import { GENERATION_INCLUDE, prescriptionOn } from "@/lib/domain/trip-generation";
import { completeTrips, currentHorizon, reviveOneOffTrips, type Completion } from "@/lib/trips/completion";
import { formatShortDate, fromIsoDate, todayIso, toIsoDate } from "@/lib/time";
import { activationEvent, alreadyInStateMessage, renewalEvents } from "./_lib/audit-events";
import { idSchema } from "./_lib/form-parse";
import { errorState, formString, messageState, type ActionResult, type FormState } from "@/lib/forms";
import type { PatientFormState } from "./_lib/patient-form-state";
import { parsePatientForm, parsePrescriptionForm, parseRecurrenceForm, readPatientForm, readRecurrenceForm } from "./_lib/schemas";
import { isRenewalOf } from "./_lib/status";
import { RENEWAL_MAX_GAP_DAYS } from "@/lib/domain/renewal";
import {
  CANCEL,
  describeSync,
  EMPTY_SYNC,
  isEmptySync,
  prescriptionTarget,
  recurrenceTarget,
  renewalTarget,
  withCompletion,
  withSyncNotice,
  type PrescriptionRules,
  type RecurrenceSchedule,
  type SyncSummary,
  type SyncTrip,
} from "./_lib/trip-sync";
import { SYNC_TX_OPTIONS, syncOpenTrips } from "./_lib/trip-sync-db";
import { formatPersonName } from "@/lib/names";

const NOT_FOUND = "Fiche introuvable : elle a peut-être été supprimée. Rechargez la page.";

/** Patient pages are rendered per request; this refreshes the router cache of every /patients page. */
function revalidatePatients() {
  revalidatePath("/(regulator)/patients", "layout");
}

/** Trips feed the courses, planning, shared-arrival and driver pages: refresh them all when trips changed. */
function revalidateTrips(summary: SyncSummary) {
  if (!isEmptySync(summary)) revalidatePath("/", "layout");
}

/**
 * Recomputes the times and totals of the routes that trips have just left,
 * once the sync transaction has committed (see lib/planning/refresh-routes.ts).
 */
function refreshLeftRoutes(routeIds: ReadonlySet<string>): Promise<RefreshOutcome> {
  return refreshRoutes({ prisma: db, evaluate }, routeIds);
}

function withSync(message: string, summary: SyncSummary, refresh: RefreshOutcome = NOTHING_REFRESHED): string {
  return [message, describeSync(summary), refreshNotice(refresh)].filter(Boolean).join(" ");
}

/**
 * Redirect target after a form save: the sync summary (?courses=…) and the
 * recomputation of the routes trips left (?tournees=…, see withRefreshNotice),
 * so the page can tell both.
 */
function afterSave(path: string, summary: SyncSummary, refresh: RefreshOutcome): string {
  return withRefreshNotice(withSyncNotice(path, summary), refresh);
}

const activeFlag = z.enum(["true", "false"]).transform((v) => v === "true");

/** Note of the trips a referential change cancels (origin SYSTEM: they come back once the cause is gone). */
const CAUSES = {
  patientDeactivated: "patient désactivé",
  prescriptionChanged: "prescription modifiée",
  recurrenceChanged: "récurrence modifiée",
  recurrenceDeactivated: "récurrence désactivée",
} as const;

/**
 * Completes the trips of the horizon (tomorrow to D+N) for the recurrences
 * matching `where`, in the caller's transaction: trips created, and those the
 * application had cancelled brought back (lib/trips/completion.ts).
 */
async function completeHorizon(
  tx: Prisma.TransactionClient,
  user: Awaited<ReturnType<typeof requireUser>>,
  where: Prisma.RecurrenceWhereInput,
): Promise<Completion> {
  return completeTrips(tx, user, await currentHorizon(tx, todayIso()), where);
}

/**
 * For each recurring trip, the prescription the generation would give it on
 * its date (prescriptionOn: its recurrence's own, a renewal or the PMT
 * renewed), read in the transaction after the change. A trip its prescription
 * no longer covers moves to it, instead of being cancelled and then brought
 * back, unplaced, by the completion of the horizon.
 */
async function generationFallback(
  tx: Prisma.TransactionClient,
  where: Prisma.RecurrenceWhereInput,
): Promise<(trip: SyncTrip) => PrescriptionRules | null> {
  const recurrences = await tx.recurrence.findMany({ where, include: GENERATION_INCLUDE });
  const byId = new Map(recurrences.map((r) => [r.id, r]));
  return (trip) => {
    const rec = trip.recurrenceId ? byId.get(trip.recurrenceId) : undefined;
    const p = rec ? prescriptionOn(rec, trip.serviceDate) : null;
    return p ? { id: p.id, mode: p.mode, sharing: p.sharing } : null;
  };
}

/**
 * Trips of today that the referential sync cancelled and that a reactivation
 * leaves cancelled: the completion never writes a day already begun, so they
 * do not come back by themselves (their recurrence must be active).
 */
async function todayStillCancelled(tx: Prisma.TransactionClient, where: Prisma.TripWhereInput): Promise<number> {
  return tx.trip.count({
    where: {
      AND: [
        where,
        { serviceDate: fromIsoDate(todayIso()), status: "CANCELLED", cancellationOrigin: "SYSTEM" },
        { OR: [{ recurrenceId: null }, { recurrence: { active: true } }] },
      ],
    },
  });
}

/** " 2 courses d'aujourd'hui restent annulées…" after a reactivation (empty when there is none). */
function todayCancelledNote(count: number): string {
  if (count === 0) return "";
  return count === 1
    ? " 1 course d'aujourd'hui reste annulée (celles du jour ne reviennent pas d'elles-mêmes) : rétablissez-la dans Courses si le transport a lieu."
    : ` ${count} courses d'aujourd'hui restent annulées (celles du jour ne reviennent pas d'elles-mêmes) : rétablissez-les dans Courses si les transports ont lieu.`;
}

/** " 3 séances sans prescription valide : voir Prescriptions." when the horizon has sessions no prescription covers. */
function skippedNote(completion: Completion): string {
  const sessions = completion.skipped.reduce((sum, r) => sum + r.dates.length, 0);
  if (sessions === 0) return "";
  return sessions === 1
    ? " 1 séance à venir n'a pas de prescription valide : aucune course ce jour-là (voir Prescriptions)."
    : ` ${sessions} séances à venir n'ont pas de prescription valide : aucune course ces jours-là (voir Prescriptions).`;
}

// ---------------------------------------------------------------- patient

// Every change below is traced (lib/audit.ts) in the transaction that writes it.

/**
 * Creates the patient. Before the first save, existing records that may be
 * the same person (same name without accents, same phone or same address)
 * are shown; « Créer quand même » (confirmSimilar) saves anyway.
 */
export async function createPatient(_prev: PatientFormState, formData: FormData): Promise<PatientFormState> {
  const user = await requireUser("REGULATOR");
  const parsed = parsePatientForm(formData);
  if (!parsed.success) return parsed.state;

  if (formString(formData, "confirmSimilar") !== "1") {
    // Few fields of every record, compared in memory: accents and phone formats are not comparable in SQL here.
    const existing = await db.patient.findMany({
      select: { id: true, firstName: true, lastName: true, phone: true, address: true, postalCode: true, city: true, active: true },
    });
    const similar = similarPatients(parsed.data, existing);
    if (similar.length > 0) {
      // Names and towns of other patients are shown: a read of their records.
      await auditRead(user, { action: "patient_list.view", entity: "Patient", entityId: null });
      return {
        ...messageState(
          similar.length === 1
            ? "Une fiche proche existe déjà : vérifiez qu'il ne s'agit pas du même patient."
            : `${similar.length} fiches proches existent déjà : vérifiez qu'il ne s'agit pas du même patient.`,
          readPatientForm(formData).values,
        ),
        similar: similar.slice(0, 10).map(({ patient, reasons }) => ({
          id: patient.id,
          name: formatPersonName(patient),
          city: patient.city,
          active: patient.active,
          reasons: reasons.map((reason) => SIMILARITY_LABELS[reason]),
        })),
      };
    }
  }

  const patient = await db.$transaction(async (tx) => {
    const created = await tx.patient.create({ data: parsed.data, select: { id: true } });
    await audit(tx, user, { action: "patient.create", entity: "Patient", entityId: created.id });
    return created;
  });
  revalidatePatients();
  redirect(`/patients/${patient.id}`);
}

/**
 * Saves the patient. Its open trips to come follow a new home address. The
 * form never changes « actif »: deactivating is the fiche's « Désactiver »
 * button (setPatientActive), which says first what it cancels.
 */
export async function updatePatient(patientId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const id = idSchema.safeParse(patientId);
  const parsed = parsePatientForm(formData);
  if (!parsed.success) return parsed.state;
  if (!id.success) return messageState(NOT_FOUND, null);

  const existing = await db.patient.findUnique({
    where: { id: id.data },
    select: { id: true, address: true, postalCode: true, city: true, lat: true, lng: true },
  });
  if (!existing) return messageState(NOT_FOUND, null);

  const data = parsed.data;
  const today = todayIso();
  const home = { address: formatAddress(data), lat: data.lat, lng: data.lng };
  const moved = home.address !== formatAddress(existing) || data.lat !== existing.lat || data.lng !== existing.lng;

  const leftRoutes = new Set<string>();
  const summary = await db.$transaction(async (tx) => {
    await tx.patient.update({ where: { id: existing.id }, data });
    await audit(tx, user, { action: "patient.update", entity: "Patient", entityId: existing.id });
    return moved
      ? await syncOpenTrips(tx, { patientId: existing.id }, () => ({ kind: "update", home }), today, leftRoutes, user)
      : EMPTY_SYNC;
  }, SYNC_TX_OPTIONS);
  const refresh = await refreshLeftRoutes(leftRoutes);

  revalidatePatients();
  revalidateTrips(summary);
  redirect(afterSave(`/patients/${existing.id}`, summary, refresh));
}

/** Deactivation keeps the history (no hard delete) and cancels the patient's open trips to come. */
export async function setPatientActive(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireUser("REGULATOR");
  const input = z
    .object({ patientId: idSchema, active: activeFlag })
    .safeParse({ patientId: formString(formData, "patientId"), active: formString(formData, "active") });
  if (!input.success) return { ok: false, message: "Demande invalide." };
  const { patientId, active } = input.data;
  const today = todayIso();

  const leftRoutes = new Set<string>();
  const outcome = await db.$transaction(async (tx) => {
    // Guarded on the opposite state: a stale page or a double click that
    // repeats a state already set writes nothing and traces nothing.
    const { count } = await tx.patient.updateMany({ where: { id: patientId, active: !active }, data: { active } });
    if (count === 0) return null;
    await audit(tx, user, activationEvent("patient", patientId, active));
    if (!active) {
      const sync = await syncOpenTrips(tx, { patientId }, () => CANCEL, today, leftRoutes, user, {
        cause: CAUSES.patientDeactivated,
      });
      return { sync, todayCancelled: 0 };
    }
    // The trips of the horizon come back: new ones, and those the deactivation cancelled (from tomorrow on).
    const completion = await completeHorizon(tx, user, { patientId });
    const revivedOneOff = await reviveOneOffTrips(tx, user, { patientId });
    return {
      sync: withCompletion(EMPTY_SYNC, { created: completion.created, revived: completion.revived + revivedOneOff }),
      todayCancelled: await todayStillCancelled(tx, { patientId }),
    };
  }, SYNC_TX_OPTIONS);
  if (!outcome) {
    const current = await db.patient.findUnique({ where: { id: patientId }, select: { id: true } });
    if (!current) return { ok: false, message: NOT_FOUND };
    revalidatePatients(); // the page was stale: show the current state
    return { ok: true, message: alreadyInStateMessage("patient", active) };
  }
  const summary = outcome.sync;
  const refresh = await refreshLeftRoutes(leftRoutes);

  revalidatePatients();
  revalidatePath("/(regulator)/etablissements", "layout");
  revalidateTrips(summary);
  return {
    ok: true,
    message: active
      ? `${withSync("Patient réactivé.", summary)}${todayCancelledNote(outcome.todayCancelled)}`
      : withSync("Patient désactivé.", summary, refresh),
  };
}

// ---------------------------------------------------------------- prescriptions

export async function createPrescription(patientId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const id = idSchema.safeParse(patientId);
  const parsed = parsePrescriptionForm(formData);
  if (!parsed.success) return parsed.state;
  if (!id.success) return messageState(NOT_FOUND, null);

  const patient = await db.patient.findUnique({ where: { id: id.data }, select: { id: true } });
  if (!patient) return messageState(NOT_FOUND, null);

  const { validFrom, validTo, ...rest } = parsed.data;
  const summary = await db.$transaction(async (tx) => {
    const created = await tx.prescription.create({
      data: { ...rest, patientId: patient.id, validFrom: fromIsoDate(validFrom), validTo: fromIsoDate(validTo) },
      select: { id: true },
    });
    await audit(tx, user, { action: "prescription.create", entity: "Prescription", entityId: created.id });
    // A renewal covers the sessions its predecessor no longer did: their trips are created at once.
    return withCompletion(EMPTY_SYNC, await completeHorizon(tx, user, { patientId: patient.id }));
  }, SYNC_TX_OPTIONS);
  revalidatePatients();
  revalidateTrips(summary);
  redirect(withSyncNotice(`/patients/${patient.id}#prescriptions`, summary));
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
  const user = await requireUser("REGULATOR");
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

  const leftRoutes = new Set<string>();
  const summary = await db.$transaction(async (tx) => {
    await tx.prescription.update({
      where: { id: existing.id },
      data: { ...rest, validFrom: fromIsoDate(validFrom), validTo: fromIsoDate(validTo) },
    });
    await audit(tx, user, { action: "prescription.update", entity: "Prescription", entityId: existing.id });
    if (!rulesChanged) return EMPTY_SYNC;
    // A trip outside the new validity moves to the renewal (or the PMT renewed) that covers it, if any.
    const fallback = await generationFallback(tx, { patientId: existing.patientId });
    const synced = await syncOpenTrips(
      tx,
      { prescriptionId: existing.id },
      (trip) => prescriptionTarget(trip, rules, fallback(trip)),
      today,
      leftRoutes,
      user,
      { cause: CAUSES.prescriptionChanged },
    );
    // A validity lengthened (or corrected) brings back the sessions it covers again.
    const completion = await completeHorizon(tx, user, { patientId: existing.patientId });
    const revivedOneOff = await reviveOneOffTrips(tx, user, { prescriptionId: existing.id });
    return withCompletion(synced, { created: completion.created, revived: completion.revived + revivedOneOff });
  }, SYNC_TX_OPTIONS);
  const refresh = await refreshLeftRoutes(leftRoutes);

  revalidatePatients();
  revalidateTrips(summary);
  redirect(afterSave(`/patients/${existing.patientId}#prescriptions`, summary, refresh));
}

/**
 * Deleting a prescription would cascade to its recurrences and detach its
 * trips: it is refused while anything still uses it.
 */
export async function deletePrescription(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireUser("REGULATOR");
  const input = z
    .object({ patientId: idSchema, prescriptionId: idSchema })
    .safeParse({ patientId: formString(formData, "patientId"), prescriptionId: formString(formData, "prescriptionId") });
  if (!input.success) return { ok: false, message: "Demande invalide." };
  const { patientId, prescriptionId } = input.data;

  const count = await db.$transaction(async (tx) => {
    // Single statement: deletes only if no recurrence and no trip reference it.
    const deleted = await tx.prescription.deleteMany({
      where: { id: prescriptionId, patientId, recurrences: { none: {} }, trips: { none: {} } },
    });
    if (deleted.count === 1) {
      await audit(tx, user, { action: "prescription.delete", entity: "Prescription", entityId: prescriptionId });
    }
    return deleted.count;
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
 * Moves every recurrence of a prescription to its renewal. The generation
 * already falls back on the renewal once the old prescription has ended
 * (lib/domain/trip-generation.ts, prescriptionOn), and on the old one for the
 * days the renewal does not cover yet: the move can be made at any time. Same
 * renewal rule as the work list (lib/domain/renewal.ts). The
 * open trips inside the renewal's validity are attached to it, and the trips
 * of the horizon completed.
 */
export async function attachRecurrencesToRenewal(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireUser("REGULATOR");
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
        `Cette prescription ne prend pas la suite de l'autre (même mode, commence après elle, finit plus tard et prend le relais au plus tard ${RENEWAL_MAX_GAP_DAYS} jours après sa fin) : modifiez les récurrences une à une.`,
    };
  }

  const today = todayIso();
  const renewal = {
    id: to.id,
    mode: to.mode,
    sharing: to.sharing,
    validFrom: toIsoDate(to.validFrom),
    validTo: toIsoDate(to.validTo),
  };

  const leftRoutes = new Set<string>();
  const result = await db.$transaction(async (tx) => {
    // Guarded on the old prescription: of two concurrent submits, only the first moves (and traces) them.
    const moved = await tx.recurrence.updateManyAndReturn({
      where: { patientId, prescriptionId: from.id },
      data: { prescriptionId: to.id },
      select: { id: true },
    });
    if (moved.length === 0) return null;
    const ids = moved.map((r) => r.id);
    await audit(tx, user, renewalEvents(ids));
    const synced = await syncOpenTrips(
      tx,
      { recurrenceId: { in: ids } },
      (trip) => renewalTarget(trip, renewal),
      today,
      leftRoutes,
      user,
    );
    const completion = await completeHorizon(tx, user, { id: { in: ids } });
    return { count: ids.length, summary: withCompletion(synced, completion) };
  }, SYNC_TX_OPTIONS);
  if (!result) return { ok: false, message: "Aucune récurrence n'est rattachée à cette prescription." };
  const refresh = await refreshLeftRoutes(leftRoutes);

  revalidatePatients();
  revalidatePath("/(regulator)/etablissements", "layout");
  revalidatePath("/", "layout");
  const moved =
    result.count === 1 ? "1 récurrence rattachée" : `${result.count} récurrences rattachées`;
  return {
    ok: true,
    message: withSync(
      `${moved} à la prescription du ${formatShortDate(renewal.validFrom)} au ${formatShortDate(renewal.validTo)}.`,
      result.summary,
      refresh,
    ),
  };
}

// ---------------------------------------------------------------- recurrences

async function checkRecurrenceReferences(
  patientId: string,
  facilityId: string,
  prescriptionId: string,
  allowedInactiveFacilityId: string | null,
): Promise<Record<string, string> | null> {
  const [facility, prescription] = await Promise.all([
    db.facility.findUnique({ where: { id: facilityId }, select: { id: true, active: true } }),
    db.prescription.findFirst({ where: { id: prescriptionId, patientId }, select: { id: true } }),
  ]);
  const errors: Record<string, string> = {};
  if (!facility) errors.facilityId = "Établissement introuvable";
  else if (!facility.active && facility.id !== allowedInactiveFacilityId) {
    errors.facilityId = "Cet établissement est désactivé";
  }
  if (!prescription) errors.prescriptionId = "Choisissez une prescription de ce patient";
  return Object.keys(errors).length > 0 ? errors : null;
}

export async function createRecurrence(patientId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const id = idSchema.safeParse(patientId);
  const parsed = parseRecurrenceForm(formData);
  if (!parsed.success) return parsed.state;
  if (!id.success) return messageState(NOT_FOUND, null);

  const patient = await db.patient.findUnique({ where: { id: id.data }, select: { id: true } });
  if (!patient) return messageState(NOT_FOUND, null);

  const { startDate, endDate, ...rest } = parsed.data;
  const refErrors = await checkRecurrenceReferences(patient.id, rest.facilityId, rest.prescriptionId, null);
  if (refErrors) {
    return errorState(refErrors, readRecurrenceForm(formData), "Vérifiez l'établissement et la prescription.");
  }

  const summary = await db.$transaction(async (tx) => {
    const created = await tx.recurrence.create({
      data: {
        ...rest,
        patientId: patient.id,
        startDate: fromIsoDate(startDate),
        endDate: endDate ? fromIsoDate(endDate) : null,
      },
      select: { id: true },
    });
    await audit(tx, user, { action: "recurrence.create", entity: "Recurrence", entityId: created.id });
    // Its trips of the horizon exist as soon as the recurrence does.
    return withCompletion(EMPTY_SYNC, await completeHorizon(tx, user, { id: created.id }));
  }, SYNC_TX_OPTIONS);
  revalidatePatients();
  revalidatePath("/(regulator)/etablissements", "layout");
  revalidateTrips(summary);
  redirect(withSyncNotice(`/patients/${patient.id}#recurrences`, summary));
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
  const user = await requireUser("REGULATOR");
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
    return errorState(refErrors, readRecurrenceForm(formData), "Vérifiez l'établissement et la prescription.");
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

  const leftRoutes = new Set<string>();
  const summary = await db.$transaction(async (tx) => {
    await tx.recurrence.update({
      where: { id: existing.id },
      data: { ...rest, startDate: fromIsoDate(startDate), endDate: endDate ? fromIsoDate(endDate) : null },
    });
    await audit(tx, user, { action: "recurrence.update", entity: "Recurrence", entityId: existing.id });
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
    const fallback = await generationFallback(tx, { id: existing.id });
    const synced = await syncOpenTrips(
      tx,
      { recurrenceId: existing.id },
      (trip) => recurrenceTarget(trip, before, target, fallback(trip)),
      today,
      leftRoutes,
      user,
      { cause: CAUSES.recurrenceChanged },
    );
    // A day added, a period lengthened or another prescription: the trips of the horizon follow.
    return withCompletion(synced, await completeHorizon(tx, user, { id: existing.id }));
  }, SYNC_TX_OPTIONS);
  const refresh = await refreshLeftRoutes(leftRoutes);

  revalidatePatients();
  revalidatePath("/(regulator)/etablissements", "layout");
  revalidateTrips(summary);
  redirect(afterSave(`/patients/${existing.patientId}#recurrences`, summary, refresh));
}

/**
 * Deactivating a recurrence cancels its open trips to come (as the
 * application's cancellations); reactivating it completes its trips of the
 * horizon and brings those back.
 */
export async function setRecurrenceActive(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireUser("REGULATOR");
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
  const leftRoutes = new Set<string>();
  const outcome = await db.$transaction(async (tx) => {
    // Guarded on the opposite state, as setPatientActive.
    const { count } = await tx.recurrence.updateMany({ where: { id: recurrence.id, active: !active }, data: { active } });
    if (count === 0) return null;
    await audit(tx, user, activationEvent("recurrence", recurrence.id, active));
    if (!active) {
      return {
        completion: null,
        todayCancelled: 0,
        sync: await syncOpenTrips(tx, { recurrenceId: recurrence.id }, () => CANCEL, today, leftRoutes, user, {
          cause: CAUSES.recurrenceDeactivated,
        }),
      };
    }
    // The trips of the horizon come back: new ones, and those the deactivation cancelled (from tomorrow on).
    const completion = await completeHorizon(tx, user, { id: recurrence.id });
    const todayCancelled = await todayStillCancelled(tx, { recurrenceId: recurrence.id, patient: { active: true } });
    return { completion, todayCancelled, sync: withCompletion(EMPTY_SYNC, completion) };
  }, SYNC_TX_OPTIONS);
  if (!outcome) {
    const current = await db.recurrence.findUnique({ where: { id: recurrence.id }, select: { id: true } });
    if (!current) return { ok: false, message: NOT_FOUND };
    revalidatePatients(); // the page was stale: show the current state
    return { ok: true, message: alreadyInStateMessage("recurrence", active) };
  }
  const summary = outcome.sync;
  const refresh = await refreshLeftRoutes(leftRoutes);

  revalidatePatients();
  revalidatePath("/(regulator)/etablissements", "layout");
  revalidateTrips(summary);
  return {
    ok: true,
    message: outcome.completion
      ? `${withSync("Récurrence réactivée.", summary)}${skippedNote(outcome.completion)}${todayCancelledNote(outcome.todayCancelled)}`
      : withSync("Récurrence désactivée.", summary, refresh),
  };
}
