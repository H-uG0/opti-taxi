"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit, changedFields } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { frenchPublicHolidays } from "@/lib/domain/holidays";
import { getSettings } from "@/lib/domain/settings";
import { errorState, idSchema, invalidState, messageState, readForm, successState, type FormState } from "@/lib/forms";
import { fromIsoDate, isIsoDate, toIsoDate } from "@/lib/time";
import { AREA_AUDIT_FIELDS, areaSchema, billingSettingsSchema, certificationSchema, holidaySchema } from "./schema";

const GONE = "Cet élément n'existe plus : rechargez la page.";

/** Billing rules feed the tariffs page, the planning (grid of each vehicle) and every optimization. */
function refresh() {
  revalidatePath("/tarifs", "layout");
  revalidatePath("/planning");
}

export async function saveBillingSettings(_state: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const values = readForm(formData);
  const parsed = billingSettingsSchema.safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);
  const previous = await getSettings(db);
  const changes = changedFields(previous, parsed.data);
  await db.$transaction(async (tx) => {
    await tx.appSettings.update({ where: { id: 1 }, data: parsed.data });
    if (Object.keys(changes).length > 0) {
      await audit(tx, user, { action: "billing.update", entity: "AppSettings", entityId: "1", details: changes });
    }
  });
  refresh();
  return successState(Object.keys(changes).length > 0 ? "Règles de facturation enregistrées." : "Règles de facturation inchangées.");
}

export async function addCertification(_state: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const values = readForm(formData);
  const parsed = certificationSchema.safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);
  await db.$transaction(async (tx) => {
    const period = await tx.companyCertification.create({ data: parsed.data, select: { id: true } });
    await audit(tx, user, {
      action: "certification.create",
      entity: "CompanyCertification",
      entityId: period.id,
      details: changedFields({}, parsed.data, ["validFrom", "validTo"]),
    });
  });
  refresh();
  return successState("Période de certification ajoutée.");
}

export async function deleteCertification(periodId: string): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const id = idSchema.safeParse(periodId);
  if (!id.success) return messageState(GONE);
  const deleted = await db.$transaction(async (tx) => {
    const period = await tx.companyCertification.findUnique({ where: { id: id.data } });
    if (!period || (await tx.companyCertification.deleteMany({ where: { id: period.id } })).count === 0) return false;
    await audit(tx, user, {
      action: "certification.delete",
      entity: "CompanyCertification",
      entityId: period.id,
      details: changedFields(period, {}, ["validFrom", "validTo"]),
    });
    return true;
  });
  if (!deleted) return messageState(GONE);
  refresh();
  return successState("Période supprimée.");
}

export async function addHoliday(_state: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const values = readForm(formData);
  const parsed = holidaySchema.safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);
  const added = await db.$transaction(async (tx) => {
    const { count } = await tx.publicHoliday.createMany({ data: [parsed.data], skipDuplicates: true });
    if (count > 0) {
      await audit(tx, user, {
        action: "holiday.create",
        entity: "PublicHoliday",
        entityId: toIsoDate(parsed.data.date),
        details: { label: parsed.data.label },
      });
    }
    return count > 0;
  });
  if (!added) return errorState({ date: "Ce jour est déjà dans la liste." }, values);
  refresh();
  return successState("Jour férié ajouté.");
}

export async function addLegalHolidays(year: number): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  if (!Number.isInteger(year) || year < 2020 || year > 2100) return messageState("Année invalide.");
  const days = frenchPublicHolidays(year);
  const added = await db.$transaction(async (tx) => {
    const { count } = await tx.publicHoliday.createMany({
      data: days.map((d) => ({ date: fromIsoDate(d.date), label: d.label })),
      skipDuplicates: true,
    });
    if (count > 0) {
      await audit(tx, user, { action: "holiday.create_legal", entity: "PublicHoliday", entityId: String(year), details: { added: count } });
    }
    return count;
  });
  refresh();
  return successState(added > 0 ? `${added} jour${added > 1 ? "s" : ""} férié${added > 1 ? "s" : ""} ajouté${added > 1 ? "s" : ""}.` : "Tous les jours fériés légaux de cette année sont déjà là.");
}

export async function deleteHoliday(isoDate: string): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  if (!isIsoDate(isoDate)) return messageState(GONE);
  const deleted = await db.$transaction(async (tx) => {
    const { count } = await tx.publicHoliday.deleteMany({ where: { date: fromIsoDate(isoDate) } });
    if (count > 0) await audit(tx, user, { action: "holiday.delete", entity: "PublicHoliday", entityId: isoDate });
    return count > 0;
  });
  if (!deleted) return messageState(GONE);
  refresh();
  return successState("Jour férié retiré.");
}

export async function createArea(_state: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const values = readForm(formData);
  const parsed = areaSchema.safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);
  await db.$transaction(async (tx) => {
    const area = await tx.tariffArea.create({ data: parsed.data, select: { id: true } });
    await audit(tx, user, {
      action: "tariff_area.create",
      entity: "TariffArea",
      entityId: area.id,
      details: changedFields({}, parsed.data, AREA_AUDIT_FIELDS),
    });
  });
  refresh();
  redirect("/tarifs/regles");
}

export async function updateArea(areaId: string, _state: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const id = idSchema.safeParse(areaId);
  if (!id.success) return messageState(GONE);
  const current = await db.tariffArea.findUnique({ where: { id: id.data } });
  if (!current) return messageState(GONE);
  const values = readForm(formData);
  const parsed = areaSchema.safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);
  await db.$transaction(async (tx) => {
    await tx.tariffArea.update({ where: { id: current.id }, data: parsed.data });
    await audit(tx, user, {
      action: "tariff_area.update",
      entity: "TariffArea",
      entityId: current.id,
      details: changedFields(current, parsed.data, AREA_AUDIT_FIELDS),
    });
  });
  refresh();
  redirect("/tarifs/regles");
}

export async function deleteArea(areaId: string): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const id = idSchema.safeParse(areaId);
  if (!id.success) return messageState(GONE);
  const deleted = await db.$transaction(async (tx) => {
    const area = await tx.tariffArea.findUnique({ where: { id: id.data } });
    if (!area || (await tx.tariffArea.deleteMany({ where: { id: area.id } })).count === 0) return false;
    await audit(tx, user, {
      action: "tariff_area.delete",
      entity: "TariffArea",
      entityId: area.id,
      details: changedFields(area, {}, AREA_AUDIT_FIELDS),
    });
    return true;
  });
  if (!deleted) return messageState(GONE);
  refresh();
  redirect("/tarifs/regles");
}
