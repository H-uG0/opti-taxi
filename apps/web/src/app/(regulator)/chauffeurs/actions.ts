"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { hashPassword } from "@/lib/auth/password";
import { db } from "@/lib/db";
import { fromIsoDate, todayIso } from "@/lib/time";
import { toUpcomingRoutes, upcomingRoutesNotice } from "../vehicules/_lib/upcoming-routes";
import {
  errorState,
  idSchema,
  invalidState,
  isUniqueViolation,
  messageState,
  readForm,
  successState,
  valueOf,
  type FormState,
} from "@/lib/forms";
import { accountSchema, assignmentConflicts, DRIVER_MULTI_FIELDS, driverSchema, OPEN_SESSION_NOTE } from "./schema";

const DRIVER_GONE = "Ce chauffeur n'existe plus : rechargez la page.";

function revalidateDriver(driverId?: string) {
  revalidatePath("/chauffeurs");
  if (driverId) revalidatePath(`/chauffeurs/${driverId}`);
  // The vehicle list shows default drivers and their qualifications.
  revalidatePath("/vehicules");
}

export async function createDriver(_state: FormState, formData: FormData): Promise<FormState> {
  await requireUser("REGULATOR");
  const values = readForm(formData, DRIVER_MULTI_FIELDS);
  const parsed = driverSchema.safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);

  const driver = await db.driver.create({ data: parsed.data, select: { id: true } });
  revalidateDriver();
  // Next step for the regulator: give the driver an access account.
  redirect(`/chauffeurs/${driver.id}?cree=1`);
}

export async function updateDriver(driverId: string, _state: FormState, formData: FormData): Promise<FormState> {
  await requireUser("REGULATOR");
  const id = idSchema.safeParse(driverId);
  if (!id.success) return messageState(DRIVER_GONE);
  const current = await db.driver.findUnique({
    where: { id: id.data },
    select: {
      id: true,
      defaultForVehicles: { where: { active: true }, select: { label: true, type: true } },
      crewMateForVehicles: { where: { active: true }, select: { label: true, type: true } },
    },
  });
  if (!current) return messageState(DRIVER_GONE);

  const values = readForm(formData, DRIVER_MULTI_FIELDS);
  const parsed = driverSchema.safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);

  const conflicts = assignmentConflicts(
    parsed.data.qualifications,
    current.defaultForVehicles,
    current.crewMateForVehicles.filter((v) => v.type === "AMBULANCE"),
  );
  if (conflicts.length > 0) {
    return errorState(
      {
        qualifications: `Qualification encore nécessaire : ${conflicts.join(" ; ")}. Changez d'abord l'équipage de ce véhicule.`,
      },
      values,
    );
  }

  await db.$transaction([
    db.driver.update({ where: { id: current.id }, data: parsed.data }),
    // Keep the login display name in sync with the driver record.
    db.user.updateMany({
      where: { driverId: current.id, role: "DRIVER" },
      data: { name: `${parsed.data.firstName} ${parsed.data.lastName}` },
    }),
  ]);
  revalidateDriver(current.id);
  return successState("Fiche chauffeur enregistrée.");
}

const activeArgs = z.object({ id: idSchema, active: z.boolean() });

/**
 * Deactivate (history kept) or reactivate a driver. Deactivating also removes
 * them from the default crew of every vehicle and disables their login (an
 * open session ends too, see OPEN_SESSION_NOTE). Upcoming routes already
 * planned with them are kept and reported: the regulator re-runs those days.
 */
export async function setDriverActive(driverId: string, active: boolean): Promise<FormState> {
  await requireUser("REGULATOR");
  const args = activeArgs.safeParse({ id: driverId, active });
  if (!args.success) return messageState("Requête invalide.");
  const driver = await db.driver.findUnique({ where: { id: args.data.id }, select: { id: true, active: true } });
  if (!driver) return messageState(DRIVER_GONE);

  if (args.data.active) {
    if (driver.active) return successState("Ce chauffeur est déjà actif.");
    await db.driver.update({ where: { id: driver.id }, data: { active: true } });
    revalidateDriver(driver.id);
    return successState(
      "Chauffeur réactivé. Affectez-le à un véhicule et réactivez son accès si besoin : ils n'ont pas été restaurés.",
    );
  }

  if (!driver.active) return successState("Ce chauffeur est déjà désactivé.");
  const [, asDriver, asCrewMate, accounts, routes] = await db.$transaction([
    db.driver.update({ where: { id: driver.id }, data: { active: false } }),
    db.vehicle.updateMany({ where: { defaultDriverId: driver.id }, data: { defaultDriverId: null } }),
    db.vehicle.updateMany({ where: { defaultCrewMateId: driver.id }, data: { defaultCrewMateId: null } }),
    db.user.updateMany({ where: { driverId: driver.id, role: "DRIVER", active: true }, data: { active: false } }),
    // Planned routes keep their crew: the regulator re-runs those days.
    db.route.findMany({
      where: { serviceDate: { gte: fromIsoDate(todayIso()) }, OR: [{ driverId: driver.id }, { crewMateId: driver.id }] },
      select: { serviceDate: true, status: true },
    }),
  ]);
  revalidateDriver(driver.id);
  const detached = asDriver.count + asCrewMate.count;
  const parts = ["Chauffeur désactivé."];
  if (detached > 0) parts.push(`Retiré de l'équipage par défaut de ${detached} véhicule${detached > 1 ? "s" : ""}.`);
  if (accounts.count > 0) parts.push(`Son compte d'accès est désactivé : il ne peut plus se connecter. ${OPEN_SESSION_NOTE}`);
  const notice = upcomingRoutesNotice(toUpcomingRoutes(routes), "driver");
  if (notice) parts.push(notice);
  return successState(parts.join(" "));
}

/** Create the driver's login, or change its e-mail and/or reset its password. */
export async function saveDriverAccount(driverId: string, _state: FormState, formData: FormData): Promise<FormState> {
  await requireUser("REGULATOR");
  const id = idSchema.safeParse(driverId);
  if (!id.success) return messageState(DRIVER_GONE);
  const driver = await db.driver.findUnique({
    where: { id: id.data },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      active: true,
      user: { select: { id: true, role: true, email: true } },
    },
  });
  if (!driver) return messageState(DRIVER_GONE);
  if (!driver.active) return messageState("Chauffeur désactivé : réactivez-le avant de gérer son accès.");
  const account = driver.user;
  if (account && account.role !== "DRIVER") return messageState("Ce compte n'est pas un compte chauffeur.");

  const raw = readForm(formData);
  // Never echo passwords back to the browser.
  const safeValues = { email: valueOf(raw, "email") };
  const parsed = accountSchema({ requirePassword: account === null }).safeParse(raw);
  if (!parsed.success) return invalidState(parsed.error, safeValues);
  const { email, password } = parsed.data;
  const passwordHash = password ? await hashPassword(password) : null;

  try {
    if (account) {
      if (email === account.email && !passwordHash) return successState("Aucune modification.");
      await db.user.update({
        where: { id: account.id },
        data: passwordHash ? { email, passwordHash } : { email },
      });
    } else {
      if (!passwordHash) return errorState({ password: "Mot de passe obligatoire pour créer le compte." }, safeValues);
      await db.user.create({
        data: {
          email,
          name: `${driver.firstName} ${driver.lastName}`,
          passwordHash,
          role: "DRIVER",
          driverId: driver.id,
          active: true,
        },
      });
    }
  } catch (error) {
    if (isUniqueViolation(error, "email")) {
      return errorState({ email: "Cette adresse est déjà utilisée par un autre compte." }, safeValues);
    }
    if (isUniqueViolation(error, "driverId")) return messageState("Ce chauffeur a déjà un compte : rechargez la page.");
    throw error;
  }

  revalidateDriver(driver.id);
  if (!account) return successState("Compte créé. Communiquez l'identifiant et le mot de passe au chauffeur.");
  // The old password no longer logs in, and sessions opened with it end.
  const resetNote = `L'ancien mot de passe ne permet plus de se connecter. ${OPEN_SESSION_NOTE}`;
  if (passwordHash && email !== account.email) {
    return successState(`Identifiant modifié et mot de passe réinitialisé : communiquez-les au chauffeur. ${resetNote}`);
  }
  if (passwordHash) return successState(`Mot de passe réinitialisé : communiquez-le au chauffeur. ${resetNote}`);
  return successState("Identifiant modifié.");
}

export async function setDriverAccountActive(driverId: string, active: boolean): Promise<FormState> {
  await requireUser("REGULATOR");
  const args = activeArgs.safeParse({ id: driverId, active });
  if (!args.success) return messageState("Requête invalide.");
  const driver = await db.driver.findUnique({
    where: { id: args.data.id },
    select: { id: true, active: true, user: { select: { id: true, role: true } } },
  });
  if (!driver) return messageState(DRIVER_GONE);
  if (!driver.user || driver.user.role !== "DRIVER") return messageState("Ce chauffeur n'a pas de compte d'accès.");
  if (args.data.active && !driver.active) return messageState("Réactivez d'abord le chauffeur.");

  await db.user.update({ where: { id: driver.user.id }, data: { active: args.data.active } });
  revalidateDriver(driver.id);
  return successState(
    args.data.active
      ? "Accès réactivé : le chauffeur peut se connecter."
      : `Accès désactivé : le chauffeur ne peut plus se connecter. ${OPEN_SESSION_NOTE}`,
  );
}
