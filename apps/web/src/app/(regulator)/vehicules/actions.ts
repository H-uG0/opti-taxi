"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { PLANNING_TX_OPTIONS } from "@/lib/planning/run-optimization";
import { fromIsoDate, todayIso, toIsoDate } from "@/lib/time";
import { depotChoiceError } from "@/app/(regulator)/depots/options";
import { crewMemberName, crewQualificationErrors } from "./_lib/crew";
import {
  errorState,
  idSchema,
  invalidState,
  isUniqueViolation,
  messageState,
  readForm,
  successState,
  type FieldErrors,
  type FormState,
} from "@/lib/forms";
import { toUpcomingRoutes, upcomingRoutesNotice } from "./_lib/upcoming-routes";
import { vehicleSchema, type VehicleInput } from "./schema";

const REGISTRATION_TAKEN = "Cette immatriculation est déjà enregistrée pour un autre véhicule.";
const VEHICLE_GONE = "Ce véhicule n'existe plus\u00a0: rechargez la page.";

function revalidateFleet(vehicleId?: string) {
  revalidatePath("/vehicules");
  if (vehicleId) revalidatePath(`/vehicules/${vehicleId}`);
  // Driver pages show their default vehicle; the tariff page checks vehicle coverage.
  revalidatePath("/chauffeurs");
  revalidatePath("/tarifs");
}

/**
 * The depot must exist and be active (unless already the vehicle's). The
 * default driver / crew mate must exist, be active (unless already assigned
 * to this vehicle) and hold the qualification the type requires.
 * A person shared with another vehicle is only a warning (form and list):
 * spare vehicles keep the usual driver.
 */
async function referenceErrors(
  input: VehicleInput,
  current: { defaultDriverId: string | null; defaultCrewMateId: string | null; depotId: string } | null,
): Promise<FieldErrors> {
  const depotError = await depotChoiceError(input.depotId, current?.depotId ?? null);
  const ids = [input.defaultDriverId, input.defaultCrewMateId].filter((id): id is string => id !== null);
  if (ids.length === 0) return depotError ? { depotId: depotError } : {};

  const members = await db.driver.findMany({
    where: { id: { in: ids } },
    select: { id: true, firstName: true, lastName: true, qualifications: true, active: true },
  });
  const byId = new Map(members.map((m) => [m.id, m]));
  const driver = input.defaultDriverId ? (byId.get(input.defaultDriverId) ?? null) : null;
  const crewMate = input.defaultCrewMateId ? (byId.get(input.defaultCrewMateId) ?? null) : null;

  const errors: FieldErrors = { ...crewQualificationErrors(input.type, driver, crewMate) };
  if (depotError) errors.depotId = depotError;
  if (input.defaultDriverId && !driver) errors.defaultDriverId = "Chauffeur introuvable.";
  else if (driver && !driver.active && driver.id !== current?.defaultDriverId) {
    errors.defaultDriverId = `${crewMemberName(driver)} est désactivé.`;
  }
  if (input.defaultCrewMateId && !crewMate) errors.defaultCrewMateId = "Équipier introuvable.";
  else if (crewMate && !crewMate.active && crewMate.id !== current?.defaultCrewMateId) {
    errors.defaultCrewMateId = `${crewMemberName(crewMate)} est désactivé.`;
  }
  return errors;
}

export async function createVehicle(_state: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const values = readForm(formData);
  const parsed = vehicleSchema.safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);

  const errors = await referenceErrors(parsed.data, null);
  if (Object.keys(errors).length > 0) return errorState(errors, values);

  let createdId: string;
  try {
    createdId = await db.$transaction(async (tx) => {
      const created = await tx.vehicle.create({ data: parsed.data, select: { id: true } });
      await audit(tx, user, { action: "vehicle.create", entity: "Vehicle", entityId: created.id });
      return created.id;
    });
  } catch (error) {
    if (isUniqueViolation(error, "registration")) return errorState({ registration: REGISTRATION_TAKEN }, values);
    throw error;
  }
  revalidateFleet();
  // A creation opens the record (indisponibilités, échéances, pleins) with a banner.
  redirect(`/vehicules/${createdId}?cree=1`);
}

export async function updateVehicle(vehicleId: string, _state: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const id = idSchema.safeParse(vehicleId);
  if (!id.success) return messageState(VEHICLE_GONE);
  const current = await db.vehicle.findUnique({
    where: { id: id.data },
    select: { id: true, defaultDriverId: true, defaultCrewMateId: true, depotId: true },
  });
  if (!current) return messageState(VEHICLE_GONE);

  const values = readForm(formData);
  const parsed = vehicleSchema.safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);

  const errors = await referenceErrors(parsed.data, current);
  if (Object.keys(errors).length > 0) return errorState(errors, values);

  try {
    await db.$transaction(async (tx) => {
      await tx.vehicle.update({ where: { id: current.id }, data: parsed.data });
      await audit(tx, user, { action: "vehicle.update", entity: "Vehicle", entityId: current.id });
    });
  } catch (error) {
    if (isUniqueViolation(error, "registration")) return errorState({ registration: REGISTRATION_TAKEN }, values);
    throw error;
  }
  revalidateFleet(current.id);
  // A change stays on the record, with a banner.
  return successState("Véhicule enregistré.");
}

const activeArgs = z.object({ id: idSchema, active: z.boolean() });

/**
 * Deactivate (history is kept, the vehicle leaves planning) or reactivate.
 * Deactivating releases the upcoming trips locked on this vehicle so the next
 * optimisation can place them elsewhere; upcoming routes already planned on it
 * are kept and reported, the regulator re-runs those days.
 */
export async function setVehicleActive(vehicleId: string, active: boolean): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const args = activeArgs.safeParse({ id: vehicleId, active });
  if (!args.success) return messageState("Requête invalide.");

  const vehicle = await db.vehicle.findUnique({
    where: { id: args.data.id },
    select: {
      id: true,
      type: true,
      active: true,
      defaultDriver: { select: { firstName: true, lastName: true, qualifications: true } },
      defaultCrewMate: { select: { firstName: true, lastName: true, qualifications: true } },
    },
  });
  if (!vehicle) return messageState(VEHICLE_GONE);

  if (args.data.active) {
    if (vehicle.active) return successState("Ce véhicule est déjà actif.");
    // Qualifications may have changed while the vehicle was inactive.
    const problems = Object.values(
      crewQualificationErrors(vehicle.type, vehicle.defaultDriver, vehicle.type === "AMBULANCE" ? vehicle.defaultCrewMate : null),
    );
    if (problems.length > 0) {
      return messageState(`Réactivation impossible\u00a0: ${problems.join(" ")} Modifiez d'abord l'équipage par défaut.`);
    }
    await db.$transaction(async (tx) => {
      await tx.vehicle.update({ where: { id: vehicle.id }, data: { active: true } });
      await audit(tx, user, { action: "vehicle.reactivate", entity: "Vehicle", entityId: vehicle.id });
    });
    revalidateFleet(vehicle.id);
    return successState("Véhicule réactivé\u00a0: il est de nouveau proposé à l'optimisation.");
  }

  if (!vehicle.active) return successState("Ce véhicule est déjà désactivé.");
  const today = fromIsoDate(todayIso());
  // Same budget as the other writes of trips: savePlan or a sync may hold their rows for a while.
  const { released, routes } = await db.$transaction(async (tx) => {
    await tx.vehicle.update({ where: { id: vehicle.id }, data: { active: false } });
    const released = await tx.trip.updateManyAndReturn({
      where: { lockedVehicleId: vehicle.id, serviceDate: { gte: today } },
      data: { lockedVehicleId: null },
      select: { id: true, serviceDate: true },
    });
    await audit(tx, user, [
      { action: "vehicle.deactivate", entity: "Vehicle", entityId: vehicle.id },
      ...released.map((trip) => ({
        action: "trip.unlock" as const,
        entity: "Trip" as const,
        entityId: trip.id,
        serviceDate: toIsoDate(trip.serviceDate),
      })),
    ]);
    // Planned routes are left as they are: the regulator re-runs those days.
    const routes = await tx.route.findMany({
      where: { vehicleId: vehicle.id, serviceDate: { gte: today } },
      select: { serviceDate: true, status: true },
    });
    return { released, routes };
  }, PLANNING_TX_OPTIONS);
  revalidateFleet(vehicle.id);
  revalidatePath("/planning");
  revalidatePath("/courses");

  const parts = ["Véhicule désactivé\u00a0: il n'est plus proposé à l'optimisation."];
  if (released.length > 0) {
    const many = released.length > 1;
    parts.push(
      `${released.length} course${many ? "s" : ""} à venir figée${many ? "s" : ""} sur ce véhicule ${many ? "ont" : "a"} été libérée${many ? "s" : ""}.`,
    );
  }
  const notice = upcomingRoutesNotice(toUpcomingRoutes(routes), "vehicle");
  if (notice) parts.push(notice);
  return successState(parts.join(" "));
}
