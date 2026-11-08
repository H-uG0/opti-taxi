"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorState, messageState, readForm, successState, valueOf, type FormState } from "@/lib/forms";
import { loadDayCrewContext } from "@/lib/optimizer/build-request";
import { replanBlocker } from "@/lib/planning/run-optimization";
import { resolveDayCrews } from "@/lib/staff/day-crews";
import { fromIsoDate, isIsoDate } from "@/lib/time";
import { crewFormErrors, readCrewForm } from "./schema";

function refreshPages() {
  revalidatePath("/equipages");
  revalidatePath("/planning");
}

const REPLAN_NOTICE = " Des tournées sont déjà calculées pour ce jour : relancez l'optimisation depuis le planning pour les appliquer.";

/**
 * Saves the crews of a date (intent "save": every active vehicle, as shown,
 * becomes a fixed crew) or forgets them (intent "reset": back to the default
 * crews and automatic replacements). Refused once the day is validated,
 * started or past, like a re-optimisation: its routes keep their crews.
 */
export async function saveDayCrews(_state: FormState, formData: FormData): Promise<FormState> {
  await requireUser("REGULATOR");
  const values = readForm(formData);
  const date = valueOf(values, "date");
  if (!isIsoDate(date)) return messageState("Date invalide : rechargez la page.");
  const blocker = await replanBlocker(date);
  if (blocker) return messageState(`Équipages non modifiables : ${blocker}`, values);
  const serviceDate = fromIsoDate(date);
  const routes = await db.route.count({ where: { serviceDate } });

  if (valueOf(values, "intent") === "reset") {
    const { count } = await db.dayCrew.deleteMany({ where: { serviceDate } });
    refreshPages();
    if (count === 0) return successState("Les équipages de ce jour étaient déjà ceux proposés automatiquement.");
    return successState(`Équipages remis aux propositions automatiques.${routes > 0 ? REPLAN_NOTICE : ""}`);
  }

  const context = await loadDayCrewContext(db, date);
  const vehicles = context.input.vehicles.filter((v) => v.active);
  const { saved, errors: formErrors } = readCrewForm(values, vehicles);
  if (Object.keys(formErrors).length > 0) return errorState(formErrors, values);
  for (const crew of saved) {
    for (const id of [crew.driverId, crew.crewMateId]) {
      if (id !== null && !context.people.has(id)) return messageState("Une personne choisie n'existe plus : rechargez la page.", values);
    }
  }

  // The same rules as the screen and the optimizer, on the submitted crews.
  const plan = resolveDayCrews({ ...context.input, saved });
  const errors = crewFormErrors(plan);
  if (Object.keys(errors).length > 0) {
    return errorState(errors, values, "Équipages non enregistrés : corrigez les postes signalés.");
  }

  await db.$transaction([
    db.dayCrew.deleteMany({ where: { serviceDate } }),
    db.dayCrew.createMany({ data: saved.map((crew) => ({ serviceDate, ...crew })) }),
  ]);
  refreshPages();
  return successState(`Équipages enregistrés.${routes > 0 ? REPLAN_NOTICE : ""}`);
}
