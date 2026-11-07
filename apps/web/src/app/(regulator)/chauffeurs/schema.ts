/**
 * Driver forms: profile (qualifications, work days, shift, break, cost) and
 * access account. Pure module, unit-tested.
 */
import { z } from "zod";
import type { Driver, Prisma, Qualification, VehicleType } from "@prisma/client";
import { REVOKE_SESSIONS } from "@/lib/auth/revoke";
import { formatDuration, formatMinute } from "@/lib/time";
import {
  crewMateRequirement,
  driverRequirement,
  hasRequiredQualification,
  qualificationRequirement,
} from "../vehicules/_lib/crew";
import {
  formatDecimalInput,
  numberField,
  optionalNumberField,
  optionalText,
  optionalTimeField,
  requiredText,
  REQUIRED,
  timeField,
  type FormValues,
  optionalIdField,
} from "@/lib/forms";

export const QUALIFICATIONS = ["TAXI_CARD", "AUXILIARY", "DEA"] as const satisfies readonly Qualification[];
export const ISO_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/** Checkbox groups, read with FormData.getAll(). */
export const DRIVER_MULTI_FIELDS = ["qualifications", "workDays"] as const;

export const QUALIFICATION_SHORT: Record<Qualification, string> = {
  TAXI_CARD: "Carte taxi",
  AUXILIARY: "Auxiliaire",
  DEA: "DEA",
};

export const MAX_BREAK_MINUTES = 240;

const driverFields = z.object({
  firstName: requiredText(60),
  lastName: requiredText(60),
  phone: optionalText(20).refine(
    (value) => value === null || /^\+?[0-9 .()-]{6,20}$/.test(value),
    "Numéro invalide (ex. 06 12 34 56 78).",
  ),
  qualifications: z
    .array(z.enum(QUALIFICATIONS, { error: "Qualification inconnue." }))
    .min(1, "Cochez au moins une qualification."),
  workDays: z
    .array(z.coerce.number({ error: "Jour invalide." }).int("Jour invalide.").min(1, "Jour invalide.").max(7, "Jour invalide."))
    .min(1, "Cochez au moins un jour travaillé."),
  shiftStart: timeField(),
  shiftEnd: timeField(),
  breakWindowStart: optionalTimeField(),
  breakWindowEnd: optionalTimeField(),
  breakMinutes: optionalNumberField({ integer: true, min: 0, max: MAX_BREAK_MINUTES, unit: "min" }),
  hourlyCost: numberField({ min: 0, max: 200, unit: "€/h" }),
  depotId: optionalIdField,
});

export const driverSchema = driverFields
  .superRefine((v, ctx) => {
    if (v.shiftEnd <= v.shiftStart) {
      ctx.addIssue({
        code: "custom",
        path: ["shiftEnd"],
        message: "La fin de service doit être après le début (même journée).",
      });
      return;
    }
    // Break: window start, window end and duration are optional together.
    const minutes = v.breakMinutes ?? 0;
    const anyBreak = v.breakWindowStart !== undefined || v.breakWindowEnd !== undefined || minutes > 0;
    if (!anyBreak) return;
    if (v.breakWindowStart === undefined) {
      ctx.addIssue({ code: "custom", path: ["breakWindowStart"], message: "Début de la fenêtre de pause manquant." });
    }
    if (v.breakWindowEnd === undefined) {
      ctx.addIssue({ code: "custom", path: ["breakWindowEnd"], message: "Fin de la fenêtre de pause manquante." });
    }
    if (minutes <= 0) {
      ctx.addIssue({ code: "custom", path: ["breakMinutes"], message: "Durée de la pause manquante." });
    }
    if (v.breakWindowStart === undefined || v.breakWindowEnd === undefined || minutes <= 0) return;

    if (v.breakWindowEnd <= v.breakWindowStart) {
      ctx.addIssue({
        code: "custom",
        path: ["breakWindowEnd"],
        message: "La fin de la fenêtre doit être après son début.",
      });
      return;
    }
    if (v.breakWindowStart < v.shiftStart || v.breakWindowEnd > v.shiftEnd) {
      ctx.addIssue({
        code: "custom",
        path: ["breakWindowStart"],
        message: `La fenêtre de pause doit être comprise dans les horaires de service (${formatMinute(v.shiftStart)} – ${formatMinute(v.shiftEnd)}).`,
      });
    }
    const window = v.breakWindowEnd - v.breakWindowStart;
    if (window < minutes) {
      ctx.addIssue({
        code: "custom",
        path: ["breakMinutes"],
        message: `La fenêtre (${formatDuration(window)}) est plus courte que la pause (${formatDuration(minutes)}).`,
      });
    }
  })
  .transform((v) => {
    const hasBreak = v.breakWindowStart !== undefined && v.breakWindowEnd !== undefined && (v.breakMinutes ?? 0) > 0;
    return {
      firstName: v.firstName,
      lastName: v.lastName,
      phone: v.phone,
      qualifications: QUALIFICATIONS.filter((q) => v.qualifications.includes(q)),
      workDays: [...new Set(v.workDays)].sort((a, b) => a - b),
      shiftStartMinute: v.shiftStart,
      shiftEndMinute: v.shiftEnd,
      breakWindowStartMinute: hasBreak ? (v.breakWindowStart ?? null) : null,
      breakWindowEndMinute: hasBreak ? (v.breakWindowEnd ?? null) : null,
      breakMinutes: hasBreak ? (v.breakMinutes ?? 0) : 0,
      hourlyCost: v.hourlyCost,
      depotId: v.depotId,
    };
  });

export type DriverInput = z.output<typeof driverSchema>;

type DriverRecord = Pick<
  Driver,
  | "firstName"
  | "lastName"
  | "phone"
  | "qualifications"
  | "workDays"
  | "shiftStartMinute"
  | "shiftEndMinute"
  | "breakWindowStartMinute"
  | "breakWindowEndMinute"
  | "breakMinutes"
  | "hourlyCost"
  | "depotId"
>;

function timeInput(minute: number | null): string {
  return minute === null ? "" : formatMinute(minute);
}

export function driverFormValues(driver?: DriverRecord): FormValues {
  if (!driver) {
    return {
      firstName: "",
      lastName: "",
      phone: "",
      qualifications: [],
      workDays: ["1", "2", "3", "4", "5"],
      shiftStart: "07:00",
      shiftEnd: "18:00",
      breakWindowStart: "11:30",
      breakWindowEnd: "14:00",
      breakMinutes: "45",
      hourlyCost: "",
      depotId: "",
    };
  }
  const hasBreak = driver.breakMinutes > 0 && driver.breakWindowStartMinute !== null && driver.breakWindowEndMinute !== null;
  return {
    firstName: driver.firstName,
    lastName: driver.lastName,
    phone: driver.phone ?? "",
    qualifications: [...driver.qualifications],
    workDays: driver.workDays.map(String),
    shiftStart: timeInput(driver.shiftStartMinute),
    shiftEnd: timeInput(driver.shiftEndMinute),
    breakWindowStart: hasBreak ? timeInput(driver.breakWindowStartMinute) : "",
    breakWindowEnd: hasBreak ? timeInput(driver.breakWindowEndMinute) : "",
    breakMinutes: hasBreak ? String(driver.breakMinutes) : "",
    hourlyCost: formatDecimalInput(driver.hourlyCost),
    depotId: driver.depotId ?? "",
  };
}

/** "45 min entre 11:30 et 14:00", or null without a planned break. */
export function describeBreak(driver: Pick<Driver, "breakWindowStartMinute" | "breakWindowEndMinute" | "breakMinutes">): string | null {
  if (driver.breakMinutes <= 0 || driver.breakWindowStartMinute === null || driver.breakWindowEndMinute === null) return null;
  return `${formatDuration(driver.breakMinutes)} entre ${formatMinute(driver.breakWindowStartMinute)} et ${formatMinute(driver.breakWindowEndMinute)}`;
}

type AssignedVehicle = { label: string; type: VehicleType };

/**
 * Vehicles whose default crew would become unqualified with these
 * qualifications (the vehicle form enforces the same rule from the other side).
 */
export function assignmentConflicts(
  qualifications: readonly Qualification[],
  asDriver: readonly AssignedVehicle[],
  asCrewMate: readonly AssignedVehicle[],
): string[] {
  const conflicts: string[] = [];
  for (const vehicle of asDriver) {
    const rule = driverRequirement(vehicle.type);
    if (!hasRequiredQualification(qualifications, rule)) {
      conflicts.push(`chauffeur par défaut de « ${vehicle.label} » (requis : ${qualificationRequirement(rule)})`);
    }
  }
  for (const vehicle of asCrewMate) {
    const rule = crewMateRequirement(vehicle.type);
    if (rule && !hasRequiredQualification(qualifications, rule)) {
      conflicts.push(`équipier par défaut de « ${vehicle.label} » (requis : ${qualificationRequirement(rule)})`);
    }
  }
  return conflicts;
}

// ---------------------------------------------------------------- account

/**
 * requireUser (lib/auth) re-checks the account on every request: disabling it,
 * deactivating the driver, or setting a new password or e-mail bumps the
 * account's session version (REVOKE_SESSIONS), which rejects every session
 * opened before at its next server round-trip (an action, or a refresh of the
 * page; a roadmap already on screen stays visible until then). Reactivating
 * later does not bring those sessions back: the driver signs in again, with an
 * unchanged password. Said wherever the regulator could think the phone stays
 * signed in.
 */
export const OPEN_SESSION_NOTE =
  "Une session déjà ouverte sur son téléphone est coupée dès sa prochaine action ou actualisation.";

/**
 * User data that enables or disables a driver account. Disabling also ends its
 * open sessions (see OPEN_SESSION_NOTE); enabling restores the sign-in, not
 * those sessions.
 */
export function accountActiveData(active: boolean) {
  return active ? { active: true } : { active: false, ...REVOKE_SESSIONS };
}

export type AccountAuditAction = "account.update" | "account.password_reset";

export type AccountChange = {
  data: Prisma.UserUpdateInput;
  actions: AccountAuditAction[];
  emailChanged: boolean;
  passwordReset: boolean;
};

/**
 * What saving the account form does to an existing driver account, or null
 * when it changes nothing. A new e-mail or a new password also ends every open
 * session of the account (REVOKE_SESSIONS): whoever holds the old credentials,
 * e.g. on a lost or handed-over phone, is signed out.
 */
export function accountUpdate(
  currentEmail: string,
  next: { email: string; passwordHash: string | null },
): AccountChange | null {
  const emailChanged = next.email !== currentEmail;
  const { passwordHash } = next;
  const passwordReset = passwordHash !== null;
  if (!emailChanged && !passwordReset) return null;

  const actions: AccountAuditAction[] = [];
  if (emailChanged) actions.push("account.update");
  if (passwordReset) actions.push("account.password_reset");

  return {
    data: {
      ...(emailChanged ? { email: next.email } : {}),
      ...(passwordHash !== null ? { passwordHash } : {}),
      ...REVOKE_SESSIONS,
    },
    actions,
    emailChanged,
    passwordReset,
  };
}

/** Said when the credentials of a disabled account change: they cannot sign in yet. */
export const ACCESS_STILL_DISABLED_NOTE =
  "L'accès reste désactivé : réactivez-le pour que le chauffeur puisse se connecter.";

/**
 * Success message after an account change. `accountActive` is the account's
 * state as written by that change: a disabled account cannot sign in and has
 * no open session (disabling it ended them), so neither is promised.
 */
export function accountUpdateMessage(
  change: Pick<AccountChange, "emailChanged" | "passwordReset">,
  accountActive: boolean,
): string {
  const lead =
    change.emailChanged && change.passwordReset
      ? "Identifiant modifié et mot de passe réinitialisé : communiquez-les au chauffeur."
      : change.passwordReset
        ? "Mot de passe réinitialisé : communiquez-le au chauffeur."
        : "Identifiant modifié : communiquez-le au chauffeur.";
  if (!accountActive) return `${lead} ${ACCESS_STILL_DISABLED_NOTE}`;
  const detail = change.passwordReset
    ? "L'ancien mot de passe ne permet plus de se connecter."
    : "Il se connecte désormais avec la nouvelle adresse et son mot de passe actuel.";
  return `${lead} ${detail} ${OPEN_SESSION_NOTE}`;
}

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 64;

const emptyToUndefined = (raw: unknown) => (typeof raw === "string" && raw === "" ? undefined : raw);

/**
 * Login of a driver. When creating the account the password is required;
 * on an existing account a blank password keeps the current one.
 */
export function accountSchema({ requirePassword }: { requirePassword: boolean }) {
  return z
    .object({
      email: z.preprocess(
        (raw) => (typeof raw === "string" ? raw.trim().toLowerCase() : raw),
        z.string({ error: REQUIRED }).min(1, REQUIRED).max(120, "120 caractères maximum.").pipe(z.email("Adresse e-mail invalide.")),
      ),
      password: z.preprocess(
        emptyToUndefined,
        z
          .string()
          .min(MIN_PASSWORD_LENGTH, `${MIN_PASSWORD_LENGTH} caractères minimum.`)
          .max(MAX_PASSWORD_LENGTH, `${MAX_PASSWORD_LENGTH} caractères maximum.`)
          .optional(),
      ),
      passwordConfirm: z.preprocess(emptyToUndefined, z.string().optional()),
    })
    .superRefine((v, ctx) => {
      if (requirePassword && v.password === undefined) {
        ctx.addIssue({ code: "custom", path: ["password"], message: "Mot de passe obligatoire pour créer le compte." });
      }
      if (v.password !== undefined && v.passwordConfirm !== v.password) {
        ctx.addIssue({ code: "custom", path: ["passwordConfirm"], message: "Les deux mots de passe ne correspondent pas." });
      }
    })
    .transform((v) => ({ email: v.email, password: v.password ?? null }));
}

/** No 0/O, 1/l/I: easy to read out over the phone. */
const PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * Random password "xxxx-xxxx-xxxx" (12 random characters, ~69 bits).
 * `random` fills an array with random 32-bit values (crypto.getRandomValues).
 */
export function generatePassword(random: (array: Uint32Array) => Uint32Array): string {
  const values = random(new Uint32Array(12));
  const chars = Array.from(values, (n) => PASSWORD_ALPHABET[n % PASSWORD_ALPHABET.length] ?? "x");
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)].map((group) => group.join("")).join("-");
}
