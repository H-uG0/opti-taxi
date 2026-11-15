"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { audit, type AuditEntity, type AuditEntry } from "@/lib/audit";
import { requireUser, type SessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorState, idSchema, invalidState, messageState, readForm, successState, type FormState } from "@/lib/forms";
import { formatShortDate, fromIsoDate, todayIso, toIsoDate } from "@/lib/time";
import { checkReading } from "@/lib/fleet/odometer";
import { loadKmPoints, loadLatestKm } from "@/lib/fleet/odometer-load";
import { deadlineSchema, fuelSchema, odometerConflict, readingCorrectionSchema, unavailabilitySchema } from "./fleet-schema";
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
 * Marks a deadline done today, at the last mileage known (fill-ups and the crews' readings, FLD-03). The
 * next deadline of the same kind is entered separately: its date or mileage
 * depends on the vehicle and the garage.
 */
export async function completeDeadline(vehicleId: string, deadlineId: string): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const id = idSchema.safeParse(deadlineId);
  const vehicle = idSchema.safeParse(vehicleId);
  if (!id.success || !vehicle.success) return messageState("Demande invalide.");
  const last = (await loadLatestKm(db, [vehicle.data])).get(vehicle.data) ?? null;
  const count = await db.$transaction(async (tx) => {
    const done = await tx.maintenanceDeadline.updateMany({
      where: { id: id.data, vehicleId: vehicle.data, doneDate: null },
      data: { doneDate: fromIsoDate(todayIso()), doneKm: last },
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
  // Against the other fill-ups and the crews' odometer readings (FLD-03).
  const others = await loadKmPoints(db, id);
  const conflict = odometerConflict(
    parsed.data,
    others.map((o) => ({ date: o.date, odometerKm: o.km, moment: o.moment })),
  );
  if (conflict) return errorState({ odometerKm: conflict }, values);
  const { date, ...rest } = parsed.data;
  await db.$transaction(async (tx) => {
    const created = await tx.fuelLog.create({
      data: { vehicleId: id, date: fromIsoDate(date), ...rest, recordedById: user.id },
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

// ------------------------------------------------------------------- odometer readings (FLD-03)

const READING_GONE = "Ce relevé n'existe plus\u00a0: rechargez la page.";
const MOMENT_WORDS = { START: "de départ", END: "de retour" } as const;

async function existingReading(vehicleId: string, readingId: string) {
  const vehicle = idSchema.safeParse(vehicleId);
  const id = idSchema.safeParse(readingId);
  if (!vehicle.success || !id.success) return null;
  const reading = await db.odometerReading.findFirst({
    where: { id: id.data, vehicleId: vehicle.data },
    select: { id: true, vehicleId: true, serviceDate: true, moment: true, km: true },
  });
  return reading ? { ...reading, date: toIsoDate(reading.serviceDate) } : null;
}

/**
 * The regulator corrects a crew's odometer reading (a typo found once the day is closed, which the crew can no longer
 * change): checked like the crew's against every other mileage known of the vehicle (never a decrease), an unusual
 * jump accepted (the regulator vouches for it). Audited on the vehicle (odometer.update: details.moment, details.km
 * { from, to }).
 */
export async function correctOdometerReading(vehicleId: string, readingId: string, _state: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const values = readForm(formData);
  const reading = await existingReading(vehicleId, readingId);
  if (!reading) return messageState(READING_GONE);
  const parsed = readingCorrectionSchema.safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);
  const { km } = parsed.data;
  if (km === reading.km) return errorState({ km: "C'est déjà le kilométrage enregistré." }, values);
  const points = await loadKmPoints(db, reading.vehicleId);
  const check = checkReading({
    km,
    date: reading.date,
    moment: reading.moment,
    others: points.filter((p) => !(p.date === reading.date && p.moment === reading.moment)),
    startKm: reading.moment === "END" ? (points.find((p) => p.date === reading.date && p.moment === "START")?.km ?? null) : null,
  });
  if (!check.ok && check.kind === "refused") return errorState({ km: check.message }, values);
  const count = await db.$transaction(async (tx) => {
    // Guarded by the value read: the crew may have typed another one meanwhile (until 03:00 the next day).
    const updated = await tx.odometerReading.updateMany({
      where: { id: reading.id, vehicleId: reading.vehicleId, km: reading.km },
      data: { km, confirmed: false },
    });
    if (updated.count > 0) {
      await audit(tx, user, {
        action: "odometer.update",
        entity: "Vehicle",
        entityId: reading.vehicleId,
        serviceDate: reading.date,
        details: { moment: reading.moment, km: { from: reading.km, to: km } },
      });
    }
    return updated.count;
  });
  refreshPages(reading.vehicleId);
  if (count === 0) return messageState("Le relevé a changé entre-temps\u00a0: rechargez la page.", values);
  return successState(`Relevé ${MOMENT_WORDS[reading.moment]} du ${formatShortDate(reading.date)} corrigé\u00a0: ${new Intl.NumberFormat("fr-FR").format(km)}\u00a0km.`);
}

/** The regulator deletes a crew's odometer reading (wrong vehicle, impossible value). Audited (odometer.delete). */
export async function deleteOdometerReading(vehicleId: string, readingId: string): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const reading = await existingReading(vehicleId, readingId);
  if (!reading) return successState("Ce relevé était déjà supprimé.");
  const count = await db.$transaction(async (tx) => {
    const removed = await tx.odometerReading.deleteMany({ where: { id: reading.id, vehicleId: reading.vehicleId } });
    if (removed.count > 0) {
      await audit(tx, user, {
        action: "odometer.delete",
        entity: "Vehicle",
        entityId: reading.vehicleId,
        serviceDate: reading.date,
        details: { moment: reading.moment, km: { from: reading.km, to: null } },
      });
    }
    return removed.count;
  });
  refreshPages(reading.vehicleId);
  return successState(count > 0 ? "Relevé supprimé." : "Ce relevé était déjà supprimé.");
}
