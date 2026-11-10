"use server";

import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorState, idSchema, invalidState, isUniqueViolation, messageState, readForm, successState, type FormState } from "@/lib/forms";
import { loadStaffImpact, staffImpactNotice } from "@/lib/staff/impact";
import { fromIsoDate, todayIso } from "@/lib/time";
import { absenceSchema, incompatibilitySchema, orderedPair } from "./staff-schema";

const DRIVER_GONE = "Ce chauffeur n'existe plus\u00a0: rechargez la page.";

function refreshPages(driverId: string) {
  revalidatePath(`/chauffeurs/${driverId}`);
  revalidatePath("/equipages");
  revalidatePath("/planning");
}

export async function addAbsence(driverId: string, _state: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const id = idSchema.safeParse(driverId);
  if (!id.success) return messageState(DRIVER_GONE);
  const values = readForm(formData);
  const parsed = absenceSchema.safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);
  const driver = await db.driver.findUnique({ where: { id: id.data }, select: { id: true } });
  if (!driver) return messageState(DRIVER_GONE);

  const { kind, startDate, endDate, note } = parsed.data;
  await db.$transaction(async (tx) => {
    const absence = await tx.staffAbsence.create({
      data: { driverId: driver.id, kind, startDate: fromIsoDate(startDate), endDate: fromIsoDate(endDate), note },
      select: { id: true },
    });
    // Ids only: the reason (sick leave…) stays on the absence itself.
    await audit(tx, user, {
      action: "staff_absence.create",
      entity: "StaffAbsence",
      entityId: absence.id,
      details: { driverId: driver.id },
    });
  });
  refreshPages(driver.id);
  // Days already planned with the person, and crews fixed with them (a replacement is proposed there).
  const impact = await loadStaffImpact(db, [driver.id], startDate, endDate);
  return successState(`Absence enregistrée.${staffImpactNotice(impact, "person")}`);
}

export async function deleteAbsence(driverId: string, absenceId: string): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const ids = idSchema.safeParse(absenceId);
  const driver = idSchema.safeParse(driverId);
  if (!ids.success || !driver.success) return messageState("Demande invalide.");
  const count = await db.$transaction(async (tx) => {
    const removed = await tx.staffAbsence.deleteMany({ where: { id: ids.data, driverId: driver.data } });
    if (removed.count > 0) {
      await audit(tx, user, {
        action: "staff_absence.delete",
        entity: "StaffAbsence",
        entityId: ids.data,
        details: { driverId: driver.data },
      });
    }
    return removed.count;
  });
  refreshPages(driverId);
  return count > 0 ? successState("Absence supprimée.") : successState("Cette absence était déjà supprimée.");
}

export async function addIncompatibility(driverId: string, _state: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const id = idSchema.safeParse(driverId);
  if (!id.success) return messageState(DRIVER_GONE);
  const values = readForm(formData);
  const parsed = incompatibilitySchema.safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);
  if (parsed.data.otherId === id.data) return errorState({ otherId: "Choisissez une autre personne." }, values);

  const people = await db.driver.findMany({ where: { id: { in: [id.data, parsed.data.otherId] } }, select: { id: true } });
  if (people.length < 2) return messageState("Personne introuvable\u00a0: rechargez la page.", values);
  const pair = orderedPair(id.data, parsed.data.otherId);
  try {
    await db.$transaction(async (tx) => {
      const created = await tx.crewIncompatibility.create({
        data: { ...pair, note: parsed.data.note },
        select: { id: true },
      });
      await audit(tx, user, {
        action: "crew_incompatibility.create",
        entity: "CrewIncompatibility",
        entityId: created.id,
        details: pair,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error, "driverAId")) return errorState({ otherId: "Cette paire est déjà enregistrée." }, values);
    throw error;
  }
  refreshPages(id.data);
  revalidatePath(`/chauffeurs/${parsed.data.otherId}`);
  // Only the days and fixed crews where the two work together.
  const impact = await loadStaffImpact(db, [id.data, parsed.data.otherId], todayIso(), null, true);
  return successState(`Paire enregistrée\u00a0: ces deux personnes ne seront plus proposées ensemble.${staffImpactNotice(impact, "pair")}`);
}

export async function deleteIncompatibility(driverId: string, incompatibilityId: string): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const ids = idSchema.safeParse(incompatibilityId);
  const driver = idSchema.safeParse(driverId);
  if (!ids.success || !driver.success) return messageState("Demande invalide.");
  const count = await db.$transaction(async (tx) => {
    const removed = await tx.crewIncompatibility.deleteMany({
      where: { id: ids.data, OR: [{ driverAId: driver.data }, { driverBId: driver.data }] },
    });
    if (removed.count > 0) {
      await audit(tx, user, {
        action: "crew_incompatibility.delete",
        entity: "CrewIncompatibility",
        entityId: ids.data,
        details: { driverId: driver.data },
      });
    }
    return removed.count;
  });
  refreshPages(driverId);
  return count > 0 ? successState("Paire supprimée.") : successState("Cette paire était déjà supprimée.");
}
