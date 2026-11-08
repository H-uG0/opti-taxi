"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorState, idSchema, invalidState, isUniqueViolation, messageState, readForm, successState, type FormState } from "@/lib/forms";
import { formatShortDate, fromIsoDate, todayIso } from "@/lib/time";
import { toUpcomingRoutes, upcomingRouteDates } from "../vehicules/_lib/upcoming-routes";
import { absenceSchema, incompatibilitySchema, orderedPair } from "./staff-schema";

const DRIVER_GONE = "Ce chauffeur n'existe plus : rechargez la page.";

function refreshPages(driverId: string) {
  revalidatePath(`/chauffeurs/${driverId}`);
  revalidatePath("/equipages");
  revalidatePath("/planning");
}

/** " Tournées déjà calculées avec lui les 10/11/2026, 12/11/2026 : relancez l'optimisation de ces jours." or "". */
async function plannedDaysNotice(driverIds: string[], from: string, to: string | null): Promise<string> {
  const start = from > todayIso() ? from : todayIso();
  const routes = await db.route.findMany({
    where: {
      serviceDate: { gte: fromIsoDate(start), ...(to ? { lte: fromIsoDate(to) } : {}) },
      OR: [{ driverId: { in: driverIds } }, { crewMateId: { in: driverIds } }],
    },
    select: { serviceDate: true, status: true },
  });
  const dates = upcomingRouteDates(toUpcomingRoutes(routes));
  if (dates.length === 0) return "";
  const listed = dates.slice(0, 5).map(formatShortDate).join(", ");
  const days = dates.length > 1 ? "ces jours" : "ce jour";
  return ` Tournées déjà calculées avec cette personne le${dates.length > 1 ? "s" : ""} ${listed}${dates.length > 5 ? "…" : ""} : relancez l'optimisation de ${days} depuis le planning.`;
}

export async function addAbsence(driverId: string, _state: FormState, formData: FormData): Promise<FormState> {
  await requireUser("REGULATOR");
  const id = idSchema.safeParse(driverId);
  if (!id.success) return messageState(DRIVER_GONE);
  const values = readForm(formData);
  const parsed = absenceSchema.safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);
  const driver = await db.driver.findUnique({ where: { id: id.data }, select: { id: true } });
  if (!driver) return messageState(DRIVER_GONE);

  const { kind, startDate, endDate, note } = parsed.data;
  await db.staffAbsence.create({
    data: { driverId: driver.id, kind, startDate: fromIsoDate(startDate), endDate: fromIsoDate(endDate), note },
  });
  refreshPages(driver.id);
  return successState(`Absence enregistrée.${await plannedDaysNotice([driver.id], startDate, endDate)}`);
}

export async function deleteAbsence(driverId: string, absenceId: string): Promise<FormState> {
  await requireUser("REGULATOR");
  const ids = idSchema.safeParse(absenceId);
  const driver = idSchema.safeParse(driverId);
  if (!ids.success || !driver.success) return messageState("Demande invalide.");
  const { count } = await db.staffAbsence.deleteMany({ where: { id: ids.data, driverId: driver.data } });
  refreshPages(driverId);
  return count > 0 ? successState("Absence supprimée.") : successState("Cette absence était déjà supprimée.");
}

export async function addIncompatibility(driverId: string, _state: FormState, formData: FormData): Promise<FormState> {
  await requireUser("REGULATOR");
  const id = idSchema.safeParse(driverId);
  if (!id.success) return messageState(DRIVER_GONE);
  const values = readForm(formData);
  const parsed = incompatibilitySchema.safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);
  if (parsed.data.otherId === id.data) return errorState({ otherId: "Choisissez une autre personne." }, values);

  const people = await db.driver.findMany({ where: { id: { in: [id.data, parsed.data.otherId] } }, select: { id: true } });
  if (people.length < 2) return messageState("Personne introuvable : rechargez la page.", values);
  try {
    await db.crewIncompatibility.create({ data: { ...orderedPair(id.data, parsed.data.otherId), note: parsed.data.note } });
  } catch (error) {
    if (isUniqueViolation(error, "driverAId")) return errorState({ otherId: "Cette paire est déjà enregistrée." }, values);
    throw error;
  }
  refreshPages(id.data);
  revalidatePath(`/chauffeurs/${parsed.data.otherId}`);
  return successState(
    `Paire enregistrée : ces deux personnes ne seront plus proposées ensemble.${await plannedDaysNotice([id.data, parsed.data.otherId], todayIso(), null)}`,
  );
}

export async function deleteIncompatibility(driverId: string, incompatibilityId: string): Promise<FormState> {
  await requireUser("REGULATOR");
  const ids = idSchema.safeParse(incompatibilityId);
  const driver = idSchema.safeParse(driverId);
  if (!ids.success || !driver.success) return messageState("Demande invalide.");
  const { count } = await db.crewIncompatibility.deleteMany({
    where: { id: ids.data, OR: [{ driverAId: driver.data }, { driverBId: driver.data }] },
  });
  refreshPages(driverId);
  return count > 0 ? successState("Paire supprimée.") : successState("Cette paire était déjà supprimée.");
}
