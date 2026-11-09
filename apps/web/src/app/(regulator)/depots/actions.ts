"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { idSchema, invalidState, messageState, readForm, successState, type FormState } from "@/lib/forms";
import { fromIsoDate, todayIso } from "@/lib/time";
import { toUpcomingRoutes } from "@/app/(regulator)/vehicules/_lib/upcoming-routes";
import { depotMoved, depotSchema, movedDepotNotice } from "./schema";

const DEPOT_GONE = "Ce dépôt n'existe plus : rechargez la page.";

/** Depot names and places show on the vehicle, driver, planning and driver roadmap pages. */
function revalidateDepots() {
  revalidatePath("/", "layout");
}

export async function createDepot(_state: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const values = readForm(formData);
  const parsed = depotSchema.safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);

  const depot = await db.$transaction(async (tx) => {
    const created = await tx.depot.create({ data: parsed.data, select: { id: true } });
    await audit(tx, user, { action: "depot.create", entity: "Depot", entityId: created.id });
    return created;
  });
  revalidateDepots();
  redirect(`/depots/${depot.id}`);
}

/**
 * Saves the depot. Moving it changes where its vehicles start and end their
 * next routes; the routes already computed keep the old place, so the
 * regulator is told which days to re-run.
 */
export async function updateDepot(depotId: string, _state: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const id = idSchema.safeParse(depotId);
  if (!id.success) return messageState(DEPOT_GONE);
  const current = await db.depot.findUnique({ where: { id: id.data }, select: { id: true, lat: true, lng: true } });
  if (!current) return messageState(DEPOT_GONE);

  const values = readForm(formData);
  const parsed = depotSchema.safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);

  await db.$transaction(async (tx) => {
    await tx.depot.update({ where: { id: current.id }, data: parsed.data });
    await audit(tx, user, { action: "depot.update", entity: "Depot", entityId: current.id });
  });
  revalidateDepots();
  if (depotMoved(current, parsed.data)) {
    const routes = await db.route.findMany({
      where: { vehicle: { depotId: current.id }, serviceDate: { gte: fromIsoDate(todayIso()) } },
      select: { serviceDate: true, status: true },
    });
    const notice = movedDepotNotice(toUpcomingRoutes(routes));
    if (notice) return successState(notice);
  }
  redirect("/depots");
}

const activeArgs = z.object({ id: idSchema, active: z.boolean() });

/**
 * Deactivate (the depot is no longer offered in the forms) or reactivate.
 * Deactivation is refused while active vehicles start from the depot: they
 * would keep using a closed place. Attached drivers keep their attachment.
 */
export async function setDepotActive(depotId: string, active: boolean): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const args = activeArgs.safeParse({ id: depotId, active });
  if (!args.success) return messageState("Requête invalide.");

  const depot = await db.depot.findUnique({
    where: { id: args.data.id },
    select: { id: true, active: true, _count: { select: { vehicles: { where: { active: true } } } } },
  });
  if (!depot) return messageState(DEPOT_GONE);

  if (args.data.active) {
    if (depot.active) return successState("Ce dépôt est déjà actif.");
    await db.$transaction(async (tx) => {
      await tx.depot.update({ where: { id: depot.id }, data: { active: true } });
      await audit(tx, user, { action: "depot.reactivate", entity: "Depot", entityId: depot.id });
    });
    revalidateDepots();
    return successState("Dépôt réactivé : il est de nouveau proposé dans les fiches véhicule et chauffeur.");
  }

  if (!depot.active) return successState("Ce dépôt est déjà désactivé.");
  // Guarded write: a vehicle attached meanwhile by another regulator blocks it too.
  const updated = await db.$transaction(async (tx) => {
    const result = await tx.depot.updateMany({
      where: { id: depot.id, active: true, vehicles: { none: { active: true } } },
      data: { active: false },
    });
    if (result.count > 0) await audit(tx, user, { action: "depot.deactivate", entity: "Depot", entityId: depot.id });
    return result;
  });
  if (updated.count === 0) {
    const n = await db.vehicle.count({ where: { depotId: depot.id, active: true } });
    if (n === 0) return messageState("Le dépôt vient d'être modifié depuis un autre poste : rechargez la page.");
    return messageState(
      `Désactivation impossible : ${n === 1 ? "1 véhicule actif part" : `${n} véhicules actifs partent`} de ce dépôt. ` +
        "Rattachez-les à un autre dépôt ou désactivez-les d'abord.",
    );
  }
  revalidateDepots();
  return successState("Dépôt désactivé : il n'est plus proposé dans les fiches véhicule et chauffeur.");
}
