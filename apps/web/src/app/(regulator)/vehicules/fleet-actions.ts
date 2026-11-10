"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { audit, type AuditEntity, type AuditEntry } from "@/lib/audit";
import { requireUser, type SessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorState, idSchema, invalidState, messageState, readForm, successState, type FormState } from "@/lib/forms";
import { formatShortDate, fromIsoDate, todayIso, toIsoDate } from "@/lib/time";
import { deadlineSchema, fuelSchema, odometerConflict, unavailabilitySchema } from "./fleet-schema";
import { toUpcomingRoutes, upcomingRouteDates } from "./_lib/upcoming-routes";

const VEHICLE_GONE = "Ce véhicule n'existe plus\u00a0: rechargez la page.";

function refreshPages(vehicleId: string) {
  revalidatePath("/vehicules");
  revalidatePath(`/vehicules/${vehicleId}`);
  revalidatePath("/equipages");
  revalidatePath("/planning");
}

async function existingVehicle(vehicleId: string): Promise<string | null> {
  const id = idSchema.safeParse(vehicleId);
  if (!id.success) return null;
  const vehicle = await db.vehicle.findUnique({ where: { id: id.data }, select: { id: true } });
  return vehicle?.id ?? null;
}

/** " Tournées déjà calculées avec ce véhicule le … : relancez l'optimisation de ces jours." or "". */
async function plannedDaysNotice(vehicleId: string, from: string, to: string): Promise<string> {
  const today = todayIso();
  if (to < today) return "";
  const routes = await db.route.findMany({
    where: { vehicleId, serviceDate: { gte: fromIsoDate(from > today ? from : today), lte: fromIsoDate(to) } },
    select: { serviceDate: true, status: true },
  });
  const dates = upcomingRouteDates(toUpcomingRoutes(routes));
  if (dates.length === 0) return "";
  const listed = dates.slice(0, 5).map(formatShortDate).join(", ");
  const days = dates.length > 1 ? "ces jours" : "ce jour";
  return ` Tournées déjà calculées avec ce véhicule le${dates.length > 1 ? "s" : ""} ${listed}${dates.length > 5 ? "…" : ""}\u00a0: relancez l'optimisation de ${days} depuis le planning.`;
}

/**
 * Deletes one row of the vehicle with `remove` and, when a row was actually
 * deleted, traces it in the same transaction. Returns the number deleted.
 */
async function deleteTraced(
  user: SessionUser,
  action: AuditEntry["action"],
  entity: AuditEntity,
  entityId: string,
  vehicleId: string,
  remove: (tx: Prisma.TransactionClient) => Promise<{ count: number }>,
): Promise<number> {
  return db.$transaction(async (tx) => {
    const { count } = await remove(tx);
    if (count > 0) await audit(tx, user, { action, entity, entityId, details: { vehicleId } });
    return count;
  });
}

// ------------------------------------------------------------------- unavailability

export async function addUnavailability(vehicleId: string, _state: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const id = await existingVehicle(vehicleId);
  if (!id) return messageState(VEHICLE_GONE);
  const values = readForm(formData);
  const parsed = unavailabilitySchema.safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);
  const { kind, startDate, endDate, note } = parsed.data;
  await db.$transaction(async (tx) => {
    const created = await tx.vehicleUnavailability.create({
      data: { vehicleId: id, kind, startDate: fromIsoDate(startDate), endDate: fromIsoDate(endDate), note },
      select: { id: true },
    });
    await audit(tx, user, {
      action: "vehicle_unavailability.create",
      entity: "VehicleUnavailability",
      entityId: created.id,
      details: { vehicleId: id, kind, startDate, endDate },
    });
  });
  refreshPages(id);
  return successState(`Indisponibilité enregistrée\u00a0: le véhicule ne sera pas planifié ces jours-là.${await plannedDaysNotice(id, startDate, endDate)}`);
}

export async function deleteUnavailability(vehicleId: string, unavailabilityId: string): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const id = idSchema.safeParse(unavailabilityId);
  const vehicle = idSchema.safeParse(vehicleId);
  if (!id.success || !vehicle.success) return messageState("Demande invalide.");
  const count = await deleteTraced(
    user,
    "vehicle_unavailability.delete",
    "VehicleUnavailability",
    id.data,
    vehicle.data,
    (tx) => tx.vehicleUnavailability.deleteMany({ where: { id: id.data, vehicleId: vehicle.data } }),
  );
  refreshPages(vehicle.data);
  return successState(count > 0 ? "Indisponibilité supprimée." : "Cette indisponibilité était déjà supprimée.");
}

// ------------------------------------------------------------------- maintenance deadlines

export async function addDeadline(vehicleId: string, _state: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const id = await existingVehicle(vehicleId);
  if (!id) return messageState(VEHICLE_GONE);
  const values = readForm(formData);
  const parsed = deadlineSchema.safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);
  const { dueDate, ...rest } = parsed.data;
  await db.$transaction(async (tx) => {
    const created = await tx.maintenanceDeadline.create({
      data: { vehicleId: id, ...rest, dueDate: dueDate ? fromIsoDate(dueDate) : null },
      select: { id: true },
    });
    await audit(tx, user, {
      action: "maintenance_deadline.create",
      entity: "MaintenanceDeadline",
      entityId: created.id,
      details: { vehicleId: id },
    });
  });
  refreshPages(id);
  return successState("Échéance enregistrée.");
}

/**
 * Marks a deadline done today, at the last odometer reading (fuel log). The
 * next deadline of the same kind is entered separately: its date or mileage
 * depends on the vehicle and the garage.
 */
export async function completeDeadline(vehicleId: string, deadlineId: string): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const id = idSchema.safeParse(deadlineId);
  const vehicle = idSchema.safeParse(vehicleId);
  if (!id.success || !vehicle.success) return messageState("Demande invalide.");
  const last = await db.fuelLog.findFirst({
    where: { vehicleId: vehicle.data },
    orderBy: { odometerKm: "desc" },
    select: { odometerKm: true },
  });
  const count = await db.$transaction(async (tx) => {
    const done = await tx.maintenanceDeadline.updateMany({
      where: { id: id.data, vehicleId: vehicle.data, doneDate: null },
      data: { doneDate: fromIsoDate(todayIso()), doneKm: last?.odometerKm ?? null },
    });
    if (done.count > 0) {
      await audit(tx, user, {
        action: "maintenance_deadline.complete",
        entity: "MaintenanceDeadline",
        entityId: id.data,
        details: { vehicleId: vehicle.data },
      });
    }
    return done.count;
  });
  refreshPages(vehicle.data);
  return successState(
    count > 0
      ? "Échéance marquée comme faite. Ajoutez la suivante (prochain contrôle, prochaine révision…)."
      : "Cette échéance était déjà faite.",
  );
}

export async function deleteDeadline(vehicleId: string, deadlineId: string): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const id = idSchema.safeParse(deadlineId);
  const vehicle = idSchema.safeParse(vehicleId);
  if (!id.success || !vehicle.success) return messageState("Demande invalide.");
  const count = await deleteTraced(
    user,
    "maintenance_deadline.delete",
    "MaintenanceDeadline",
    id.data,
    vehicle.data,
    (tx) => tx.maintenanceDeadline.deleteMany({ where: { id: id.data, vehicleId: vehicle.data } }),
  );
  refreshPages(vehicle.data);
  return successState(count > 0 ? "Échéance supprimée." : "Cette échéance était déjà supprimée.");
}

// ------------------------------------------------------------------- fuel log

export async function addFuelLog(vehicleId: string, _state: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const id = await existingVehicle(vehicleId);
  if (!id) return messageState(VEHICLE_GONE);
  const values = readForm(formData);
  const parsed = fuelSchema.safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);
  const others = await db.fuelLog.findMany({ where: { vehicleId: id }, select: { date: true, odometerKm: true } });
  const conflict = odometerConflict(
    parsed.data,
    others.map((o) => ({ date: toIsoDate(o.date), odometerKm: o.odometerKm })),
  );
  if (conflict) return errorState({ odometerKm: conflict }, values);
  const { date, ...rest } = parsed.data;
  await db.$transaction(async (tx) => {
    const created = await tx.fuelLog.create({
      data: { vehicleId: id, date: fromIsoDate(date), ...rest },
      select: { id: true },
    });
    await audit(tx, user, {
      action: "fuel_log.create",
      entity: "FuelLog",
      entityId: created.id,
      details: { vehicleId: id },
    });
  });
  refreshPages(id);
  return successState("Plein enregistré.");
}

export async function deleteFuelLog(vehicleId: string, fuelLogId: string): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const id = idSchema.safeParse(fuelLogId);
  const vehicle = idSchema.safeParse(vehicleId);
  if (!id.success || !vehicle.success) return messageState("Demande invalide.");
  const count = await deleteTraced(user, "fuel_log.delete", "FuelLog", id.data, vehicle.data, (tx) =>
    tx.fuelLog.deleteMany({ where: { id: id.data, vehicleId: vehicle.data } }),
  );
  refreshPages(vehicle.data);
  return successState(count > 0 ? "Plein supprimé." : "Ce plein était déjà supprimé.");
}
