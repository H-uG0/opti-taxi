"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { audit, type AuditEntry } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { hashPassword } from "@/lib/auth/password";
import { db } from "@/lib/db";
import { fromIsoDate, todayIso } from "@/lib/time";
import { toUpcomingRoutes, upcomingRoutesNotice } from "../vehicules/_lib/upcoming-routes";
import { depotChoiceError } from "@/app/(regulator)/depots/options";
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
import {
  accountActiveData,
  accountSchema,
  ACCOUNT_CREATED_MESSAGE,
  accountUpdate,
  accountUpdateMessage,
  assignmentConflicts,
  DRIVER_MULTI_FIELDS,
  driverSchema,
  OPEN_SESSION_NOTE,
} from "./schema";

const DRIVER_GONE = "Ce chauffeur n'existe plus : rechargez la page.";

function revalidateDriver(driverId?: string) {
  revalidatePath("/chauffeurs");
  if (driverId) revalidatePath(`/chauffeurs/${driverId}`);
  // The vehicle list shows default drivers and their qualifications.
  revalidatePath("/vehicules");
}

export async function createDriver(_state: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const values = readForm(formData, DRIVER_MULTI_FIELDS);
  const parsed = driverSchema.safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);
  const depotError = await depotChoiceError(parsed.data.depotId, null);
  if (depotError) return errorState({ depotId: depotError }, values);

  const driver = await db.$transaction(async (tx) => {
    const created = await tx.driver.create({ data: parsed.data, select: { id: true } });
    await audit(tx, user, { action: "driver.create", entity: "Driver", entityId: created.id });
    return created;
  });
  revalidateDriver();
  // Next step for the regulator: give the driver an access account.
  redirect(`/chauffeurs/${driver.id}?cree=1`);
}

export async function updateDriver(driverId: string, _state: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const id = idSchema.safeParse(driverId);
  if (!id.success) return messageState(DRIVER_GONE);
  const current = await db.driver.findUnique({
    where: { id: id.data },
    select: {
      id: true,
      depotId: true,
      defaultForVehicles: {
        where: { active: true },
        select: { label: true, type: true, defaultCrewMate: { select: { qualifications: true } } },
      },
      crewMateForVehicles: {
        where: { active: true },
        select: { label: true, type: true, defaultDriver: { select: { qualifications: true } } },
      },
    },
  });
  if (!current) return messageState(DRIVER_GONE);

  const values = readForm(formData, DRIVER_MULTI_FIELDS);
  const parsed = driverSchema.safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);

  const depotError = await depotChoiceError(parsed.data.depotId, current.depotId);
  if (depotError) return errorState({ depotId: depotError }, values);

  // The other member of an ambulance's default crew: the pair must keep its DEA.
  const conflicts = assignmentConflicts(
    parsed.data.qualifications,
    current.defaultForVehicles.map((v) => ({
      label: v.label,
      type: v.type,
      partner: v.type === "AMBULANCE" ? (v.defaultCrewMate?.qualifications ?? null) : null,
    })),
    current.crewMateForVehicles
      .filter((v) => v.type === "AMBULANCE")
      .map((v) => ({ label: v.label, type: v.type, partner: v.defaultDriver?.qualifications ?? null })),
  );
  if (conflicts.length > 0) {
    return errorState(
      {
        qualifications: `Qualification encore nécessaire : ${conflicts.join(" ; ")}. Changez d'abord l'équipage de ce véhicule.`,
      },
      values,
    );
  }

  await db.$transaction(async (tx) => {
    await tx.driver.update({ where: { id: current.id }, data: parsed.data });
    // Keep the login display name in sync with the driver record (covered by driver.update).
    await tx.user.updateMany({
      where: { driverId: current.id, role: "DRIVER" },
      data: { name: `${parsed.data.firstName} ${parsed.data.lastName}` },
    });
    await audit(tx, user, { action: "driver.update", entity: "Driver", entityId: current.id });
  });
  revalidateDriver(current.id);
  return successState("Fiche chauffeur enregistrée.");
}

const activeArgs = z.object({ id: idSchema, active: z.boolean() });

/**
 * Deactivate (history kept) or reactivate a driver. Deactivating also removes
 * them from the default crew of every vehicle and disables their login (its
 * open sessions end too, see OPEN_SESSION_NOTE). Upcoming routes already
 * planned with them are kept and reported: the regulator re-runs those days.
 */
export async function setDriverActive(driverId: string, active: boolean): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const args = activeArgs.safeParse({ id: driverId, active });
  if (!args.success) return messageState("Requête invalide.");
  const driver = await db.driver.findUnique({ where: { id: args.data.id }, select: { id: true } });
  if (!driver) return messageState(DRIVER_GONE);

  // Each branch flips the flag with a conditional write: of two concurrent
  // requests (two tabs), only the one that changes it acts and writes the
  // audit events; the other one reports the state already reached. Both
  // revalidate, so a stale page shows the current state.
  if (args.data.active) {
    const reactivated = await db.$transaction(async (tx) => {
      const { count } = await tx.driver.updateMany({ where: { id: driver.id, active: false }, data: { active: true } });
      if (count === 0) return false;
      await audit(tx, user, { action: "driver.reactivate", entity: "Driver", entityId: driver.id });
      return true;
    });
    revalidateDriver(driver.id);
    if (!reactivated) return successState("Ce chauffeur est déjà actif.");
    return successState(
      "Chauffeur réactivé. Affectez-le à un véhicule et réactivez son accès si besoin : ils n'ont pas été restaurés.",
    );
  }

  const result = await db.$transaction(async (tx) => {
    const { count } = await tx.driver.updateMany({ where: { id: driver.id, active: true }, data: { active: false } });
    if (count === 0) return null;
    const asDriver = await tx.vehicle.updateMany({ where: { defaultDriverId: driver.id }, data: { defaultDriverId: null } });
    const asCrewMate = await tx.vehicle.updateMany({
      where: { defaultCrewMateId: driver.id },
      data: { defaultCrewMateId: null },
    });
    // driverId is unique on User: one account at most. Only an account still
    // active is disabled (and its sessions ended): one already disabled has no
    // open session left, disabling it ended them. Conditional, like the account
    // toggle it may race with.
    const account = await tx.user.findFirst({ where: { driverId: driver.id, role: "DRIVER" }, select: { id: true } });
    const accountDisabled = account
      ? (await tx.user.updateMany({ where: { id: account.id, active: true }, data: accountActiveData(false) })).count === 1
      : false;
    const events: AuditEntry[] = [{ action: "driver.deactivate", entity: "Driver", entityId: driver.id }];
    if (account && accountDisabled) events.push({ action: "account.deactivate", entity: "User", entityId: account.id });
    await audit(tx, user, events);
    // Planned routes keep their crew: the regulator re-runs those days.
    const routes = await tx.route.findMany({
      where: { serviceDate: { gte: fromIsoDate(todayIso()) }, OR: [{ driverId: driver.id }, { crewMateId: driver.id }] },
      select: { serviceDate: true, status: true },
    });
    return { detached: asDriver.count + asCrewMate.count, accountDisabled, routes };
  });
  revalidateDriver(driver.id);
  if (!result) return successState("Ce chauffeur est déjà désactivé.");
  const { detached, accountDisabled, routes } = result;
  const parts = ["Chauffeur désactivé."];
  if (detached > 0) parts.push(`Retiré de l'équipage par défaut de ${detached} véhicule${detached > 1 ? "s" : ""}.`);
  if (accountDisabled) parts.push(`Son compte d'accès est désactivé : il ne peut plus se connecter. ${OPEN_SESSION_NOTE}`);
  const notice = upcomingRoutesNotice(toUpcomingRoutes(routes), "driver");
  if (notice) parts.push(notice);
  return successState(parts.join(" "));
}

/**
 * Create the driver's login, or change its e-mail and/or reset its password
 * (either ends its open sessions, see accountUpdate). A password set here is
 * provisional: the driver must replace it at the next sign-in.
 */
export async function saveDriverAccount(driverId: string, _state: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
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

  let message: string;
  try {
    if (account) {
      const update = accountUpdate(account.email, { email, passwordHash });
      if (!update) return successState("Aucune modification.");
      const saved = await db.$transaction(async (tx) => {
        // `active` as of this write: the message must not promise a sign-in to
        // a disabled account, even one disabled from another tab meanwhile.
        const updated = await tx.user.update({ where: { id: account.id }, data: update.data, select: { active: true } });
        await audit(tx, user, update.actions.map((action) => ({ action, entity: "User", entityId: account.id })));
        return updated;
      });
      message = accountUpdateMessage(update, saved.active);
    } else {
      if (!passwordHash) return errorState({ password: "Mot de passe obligatoire pour créer le compte." }, safeValues);
      await db.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email,
            name: `${driver.firstName} ${driver.lastName}`,
            passwordHash,
            // The regulator chose it: the driver replaces it at the first sign-in.
            mustChangePassword: true,
            role: "DRIVER",
            driverId: driver.id,
            active: true,
          },
          select: { id: true },
        });
        await audit(tx, user, { action: "account.create", entity: "User", entityId: created.id });
      });
      message = ACCOUNT_CREATED_MESSAGE;
    }
  } catch (error) {
    if (isUniqueViolation(error, "email")) {
      return errorState({ email: "Cette adresse est déjà utilisée par un autre compte." }, safeValues);
    }
    if (isUniqueViolation(error, "driverId")) return messageState("Ce chauffeur a déjà un compte : rechargez la page.");
    throw error;
  }

  revalidateDriver(driver.id);
  return successState(message);
}

/**
 * Disable (open sessions end, see OPEN_SESSION_NOTE) or re-enable the
 * driver's login. Re-enabling brings back the sign-in with the unchanged
 * e-mail and password, not the sessions.
 */
export async function setDriverAccountActive(driverId: string, active: boolean): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const args = activeArgs.safeParse({ id: driverId, active });
  if (!args.success) return messageState("Requête invalide.");
  const target = args.data.active;
  const driver = await db.driver.findUnique({
    where: { id: args.data.id },
    select: { id: true, active: true, user: { select: { id: true, role: true } } },
  });
  if (!driver) return messageState(DRIVER_GONE);
  if (!driver.user || driver.user.role !== "DRIVER") return messageState("Ce chauffeur n'a pas de compte d'accès.");
  const account = driver.user;
  if (target && !driver.active) return messageState("Réactivez d'abord le chauffeur.");

  // Conditional write: of two concurrent requests (two tabs), only the one that
  // flips the flag bumps the session version and writes the audit event.
  const changed = await db.$transaction(async (tx) => {
    const { count } = await tx.user.updateMany({
      where: { id: account.id, active: !target },
      data: accountActiveData(target),
    });
    if (count === 0) return false;
    await audit(tx, user, {
      action: target ? "account.reactivate" : "account.deactivate",
      entity: "User",
      entityId: account.id,
    });
    return true;
  });
  // Also when nothing changed: the page was stale, show the current state.
  revalidateDriver(driver.id);
  if (!changed) return successState(target ? "Cet accès est déjà actif." : "Cet accès est déjà désactivé.");
  return successState(
    target
      ? "Accès réactivé : le chauffeur se reconnecte avec son identifiant et son mot de passe actuels."
      : `Accès désactivé : le chauffeur ne peut plus se connecter. ${OPEN_SESSION_NOTE}`,
  );
}
