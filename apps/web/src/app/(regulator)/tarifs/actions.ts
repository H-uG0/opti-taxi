"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { idSchema, invalidState, messageState, readForm, type FormState } from "@/lib/forms";
import { tariffSchema } from "./schema";

const GRID_GONE = "Cette grille n'existe plus : rechargez la page.";

export async function createTariff(_state: FormState, formData: FormData): Promise<FormState> {
  await requireUser("REGULATOR");
  const values = readForm(formData);
  const parsed = tariffSchema.safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);

  await db.tariffGrid.create({ data: parsed.data });
  revalidatePath("/tarifs");
  redirect("/tarifs");
}

export async function updateTariff(gridId: string, _state: FormState, formData: FormData): Promise<FormState> {
  await requireUser("REGULATOR");
  const id = idSchema.safeParse(gridId);
  if (!id.success) return messageState(GRID_GONE);
  const current = await db.tariffGrid.findUnique({ where: { id: id.data }, select: { id: true } });
  if (!current) return messageState(GRID_GONE);

  const values = readForm(formData);
  const parsed = tariffSchema.safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);

  await db.tariffGrid.update({ where: { id: current.id }, data: parsed.data });
  revalidatePath("/tarifs");
  revalidatePath(`/tarifs/${current.id}`);
  redirect("/tarifs");
}

/** Grids are not referenced by other rows (revenues are snapshots), so they may be deleted. */
export async function deleteTariff(gridId: string): Promise<FormState> {
  await requireUser("REGULATOR");
  const id = idSchema.safeParse(gridId);
  if (!id.success) return messageState(GRID_GONE);
  const deleted = await db.tariffGrid.deleteMany({ where: { id: id.data } });
  if (deleted.count === 0) return messageState(GRID_GONE);
  revalidatePath("/tarifs");
  redirect("/tarifs");
}
