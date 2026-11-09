/**
 * Settings (AppSettings singleton): optimizer rules and the regulation phone
 * number shown to the drivers. The decree caps are upper bounds: the
 * regulator may be stricter, never looser. Pure module, unit-tested.
 */
import { z } from "zod";
import type { AppSettings } from "@prisma/client";
import { LATE_CANCELLATION_HOURS } from "@/lib/domain/cancellation";
import { TRIP_HORIZON_DAYS } from "@/lib/trips/horizon";
import { formatDecimalInput, numberField, type FormValues } from "@/lib/forms";
import { fractionToPercent, percentToFraction } from "../tarifs/schema";

/** Décret 2025-202 (transport partagé): art. R. 322-11-5 (détours) and R. 322-11-6 (attente). */
export const DECREE_LIMITS = {
  maxTotalWaitMin: 45,
  maxDetourKmPerExtraPatient: 10,
  maxDetourKmTotal: 30,
} as const;

export const MAX_SOLVER_TIME_LIMIT_SEC = 120;

/** Upper bounds of the « Équipages » settings. */
export const CREW_LIMITS = { maxReplacementKm: 400, minPairOverlapMin: 720, reservePerDepot: 50 } as const;

export const PHONE_ERROR =
  "Numéro invalide : saisissez un numéro français à 10 chiffres (ex. 04 65 71 00 00), éventuellement au format +33 4 65 71 00 00.";

/**
 * Confirmation after a save. The regulation number is mentioned only when it
 * changed; open roadmaps pick it up at their next refresh.
 */
export function settingsSavedMessage(previousPhone: string | null, savedPhone: string | null): string {
  const rules = "Paramètres enregistrés : les règles s'appliqueront au prochain calcul des tournées.";
  if (previousPhone === savedPhone) return rules;
  if (!savedPhone) return `${rules} La feuille de route des chauffeurs n'affichera plus de numéro de la régulation.`;
  return `${rules} Les chauffeurs verront le numéro ${savedPhone} dès la prochaine actualisation de leur feuille de route.`;
}

/**
 * French phone number typed in any usual form ("0465710000", "04.65.71.00.00",
 * "04-65-71-00-00", "+33 4 65 71 00 00", "+33 (0)4 65 71 00 00", "0033 4…"),
 * written "04 65 71 00 00". Null when it is not a 10-digit French number.
 */
export function normalizeFrenchPhone(input: string): string | null {
  const compact = input.replace(/[\s.-]/g, "").replace(/^(\+33|0033)\(0\)/, "$1");
  const national = /^(?:\+33|0033)([1-9]\d{8})$/.exec(compact)?.[1] ?? /^0([1-9]\d{8})$/.exec(compact)?.[1];
  return national ? `0${national}`.replace(/(\d{2})(?=\d)/g, "$1 ") : null;
}

export const settingsSchema = z
  .object({
    waitBeforeAppointmentMin: numberField({
      integer: true,
      min: 0,
      max: DECREE_LIMITS.maxTotalWaitMin,
      unit: "min",
    }),
    waitAfterSessionMin: numberField({ integer: true, min: 0, max: DECREE_LIMITS.maxTotalWaitMin, unit: "min" }),
    maxTotalWaitMin: numberField({
      integer: true,
      min: 0,
      max: DECREE_LIMITS.maxTotalWaitMin,
      maxMessage: `${DECREE_LIMITS.maxTotalWaitMin} min maximum : plafond du décret 2025-202 (art. R. 322-11-6).`,
    }),
    maxDetourKmPerExtraPatient: numberField({
      min: 0,
      max: DECREE_LIMITS.maxDetourKmPerExtraPatient,
      maxMessage: `${DECREE_LIMITS.maxDetourKmPerExtraPatient} km maximum : plafond du décret 2025-202 (art. R. 322-11-5).`,
    }),
    maxDetourKmTotal: numberField({
      min: 0,
      max: DECREE_LIMITS.maxDetourKmTotal,
      maxMessage: `${DECREE_LIMITS.maxDetourKmTotal} km maximum : plafond du décret 2025-202 (art. R. 322-11-5).`,
    }),
    pickupServiceMin: numberField({ integer: true, min: 0, max: 60, unit: "min" }),
    dropoffServiceMin: numberField({ integer: true, min: 0, max: 60, unit: "min" }),
    unassignedPenalty: numberField({ min: 0, max: 1_000_000, unit: "€" }),
    solverTimeLimitSec: numberField({ integer: true, min: 1, max: MAX_SOLVER_TIME_LIMIT_SEC, unit: "s" }),
    // Replacing the routes in place (lib/planning/plan-compare.ts): beyond these, the regulator confirms.
    replanMaxServedLoss: numberField({ integer: true, min: 0, max: 1000, unit: "courses" }),
    // Typed in %, stored as a fraction of the revenue in place.
    replanMaxMarginLoss: numberField({ min: 0, max: 100, unit: "%" }).transform(percentToFraction),
    // Recurring trips are created from tomorrow to D+N (lib/trips/completion.ts).
    tripHorizonDays: numberField({ integer: true, min: TRIP_HORIZON_DAYS.min, max: TRIP_HORIZON_DAYS.max, unit: "jours" }),
    // A cancellation typed less than this many hours before the pickup is late (lib/domain/cancellation.ts).
    lateCancellationHours: numberField({
      integer: true,
      min: LATE_CANCELLATION_HOURS.min,
      max: LATE_CANCELLATION_HOURS.max,
      unit: "h",
    }),
    // Automatic crews of the day (lib/staff/day-crews.ts): replacements and ambulance pairs.
    crewMaxReplacementKm: numberField({ min: 0, max: CREW_LIMITS.maxReplacementKm, unit: "km" }),
    crewMinPairOverlapMin: numberField({ integer: true, min: 0, max: CREW_LIMITS.minPairOverlapMin, unit: "min" }),
    crewReservePerDepot: numberField({ integer: true, min: 0, max: CREW_LIMITS.reservePerDepot, unit: "personnes" }),
    // Blank: no number, the drivers' roadmap shows no call link.
    regulatorPhone: z
      .string()
      .trim()
      .optional()
      .refine((value) => !value || normalizeFrenchPhone(value) !== null, PHONE_ERROR)
      .transform((value) => (value ? normalizeFrenchPhone(value) : null)),
  })
  .superRefine((v, ctx) => {
    const wait = v.waitBeforeAppointmentMin + v.waitAfterSessionMin;
    if (wait > v.maxTotalWaitMin) {
      ctx.addIssue({
        code: "custom",
        path: ["maxTotalWaitMin"],
        message: `Marge avant le RDV (${v.waitBeforeAppointmentMin} min) + marge après la séance (${v.waitAfterSessionMin} min) = ${wait} min : dépasse l'attente maximale de ${v.maxTotalWaitMin} min.`,
      });
    }
    if (v.maxDetourKmPerExtraPatient > v.maxDetourKmTotal) {
      ctx.addIssue({
        code: "custom",
        path: ["maxDetourKmPerExtraPatient"],
        message: "Le détour par patient ajouté ne peut pas dépasser le plafond total du détour.",
      });
    }
  });

export type SettingsInput = z.output<typeof settingsSchema>;

/** Numeric settings, shown in the form with formatDecimalInput. */
export const SETTINGS_FIELDS = [
  "waitBeforeAppointmentMin",
  "waitAfterSessionMin",
  "maxTotalWaitMin",
  "maxDetourKmPerExtraPatient",
  "maxDetourKmTotal",
  "pickupServiceMin",
  "dropoffServiceMin",
  "unassignedPenalty",
  "solverTimeLimitSec",
  "replanMaxServedLoss",
  "lateCancellationHours",
  "tripHorizonDays",
  "crewMaxReplacementKm",
  "crewMinPairOverlapMin",
  "crewReservePerDepot",
] as const satisfies readonly (keyof SettingsInput & keyof AppSettings)[];

export function settingsFormValues(
  settings: Pick<AppSettings, (typeof SETTINGS_FIELDS)[number] | "regulatorPhone" | "replanMaxMarginLoss">,
): FormValues {
  return {
    ...Object.fromEntries(SETTINGS_FIELDS.map((field) => [field, formatDecimalInput(settings[field])])),
    replanMaxMarginLoss: formatDecimalInput(fractionToPercent(settings.replanMaxMarginLoss)),
    regulatorPhone: settings.regulatorPhone ?? "",
  };
}
