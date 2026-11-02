"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/domain/settings";
import { invalidState, readForm, successState, type FormState } from "@/lib/forms";
import { settingsSchema } from "./schema";

export async function saveSettings(_state: FormState, formData: FormData): Promise<FormState> {
  await requireUser("REGULATOR");
  const values = readForm(formData);
  const parsed = settingsSchema.safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);

  // Creates the singleton row with its defaults if it does not exist yet.
  await getSettings(db);
  await db.appSettings.update({ where: { id: 1 }, data: parsed.data });
  revalidatePath("/parametres");
  return successState("Paramètres enregistrés : ils s'appliqueront au prochain calcul des tournées.");
}
