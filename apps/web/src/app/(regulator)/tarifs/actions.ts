"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit, changedFields } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { idSchema, invalidState, messageState, readForm, type FormState } from "@/lib/forms";
import { TARIFF_AUDIT_FIELDS, tariffSchema } from "./schema";

const GRID_GONE = "Cette grille n'existe plus : rechargez la page.";

export async function createTariff(_state: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const values = readForm(formData);
  const parsed = tariffSchema.safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);

  await db.$transaction(async (tx) => {
    const grid = await tx.tariffGrid.create({ data: parsed.data, select: { id: true } });
    await audit(tx, user, {
      action: "tariff.create",
      entity: "TariffGrid",
      entityId: grid.id,
      details: changedFields({}, parsed.data, TARIFF_AUDIT_FIELDS),
    });
  });
  revalidatePath("/tarifs");
  redirect("/tarifs");
}

export async function updateTariff(gridId: string, _state: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const id = idSchema.safeParse(gridId);
  if (!id.success) return messageState(GRID_GONE);
  const current = await db.tariffGrid.findUnique({ where: { id: id.data } });
  if (!current) return messageState(GRID_GONE);

  const values = readForm(formData);
  const parsed = tariffSchema.safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);

  await db.$transaction(async (tx) => {
    await tx.tariffGrid.update({ where: { id: current.id }, data: parsed.data });
    // Old and new value of each amount or date changed: estimated revenues depend on them.
    await audit(tx, user, {
      action: "tariff.update",
      entity: "TariffGrid",
      entityId: current.id,
      details: changedFields(current, parsed.data, TARIFF_AUDIT_FIELDS),
    });
  });
  revalidatePath("/tarifs");
  revalidatePath(`/tarifs/${current.id}`);
  redirect("/tarifs");
}

/**
 * Grids are not referenced by other rows (revenues are snapshots), so they may
 * be deleted; the audit event keeps what the deleted grid said.
 */
export async function deleteTariff(gridId: string): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const id = idSchema.safeParse(gridId);
  if (!id.success) return messageState(GRID_GONE);
  const deleted = await db.$transaction(async (tx) => {
    const grid = await tx.tariffGrid.findUnique({ where: { id: id.data } });
    // deleteMany: a grid deleted meanwhile from another tab is "gone", not an error.
    if (!grid || (await tx.tariffGrid.deleteMany({ where: { id: grid.id } })).count === 0) return false;
    await audit(tx, user, {
      action: "tariff.delete",
      entity: "TariffGrid",
      entityId: grid.id,
      details: changedFields(grid, {}, TARIFF_AUDIT_FIELDS),
    });
    return true;
  });
  if (!deleted) return messageState(GRID_GONE);
  revalidatePath("/tarifs");
  redirect("/tarifs");
}
