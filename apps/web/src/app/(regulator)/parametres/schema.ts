/**
 * Optimizer settings (AppSettings singleton). The decree caps are upper
 * bounds: the regulator may be stricter, never looser. Pure module, unit-tested.
 */
import { z } from "zod";
import type { AppSettings } from "@prisma/client";
import { formatDecimalInput, numberField, type FormValues } from "@/lib/forms";

/** Décret 2025-202 (transport partagé): art. R. 322-11-5 (détours) and R. 322-11-6 (attente). */
export const DECREE_LIMITS = {
  maxTotalWaitMin: 45,
  maxDetourKmPerExtraPatient: 10,
  maxDetourKmTotal: 30,
} as const;

export const MAX_SOLVER_TIME_LIMIT_SEC = 120;

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
] as const satisfies readonly (keyof SettingsInput & keyof AppSettings)[];

export function settingsFormValues(settings: Pick<AppSettings, (typeof SETTINGS_FIELDS)[number]>): FormValues {
  return Object.fromEntries(SETTINGS_FIELDS.map((field) => [field, formatDecimalInput(settings[field])]));
}
