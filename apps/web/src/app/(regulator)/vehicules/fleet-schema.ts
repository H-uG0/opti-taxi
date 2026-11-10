/**
 * Vehicle planning forms (lot 4): unavailability, maintenance deadlines and
 * fuel log entries. Pure module (unit-tested).
 */
import { z } from "zod";
import type { EnergyType, MaintenanceKind, VehicleUnavailabilityKind } from "@prisma/client";
import { dateField, numberField, optionalDateField, optionalNumberField, optionalText, type FormValues } from "@/lib/forms";
import { addDays, formatShortDate } from "@/lib/time";

export const UNAVAILABILITY_KINDS = ["MAINTENANCE", "REPAIR", "INSPECTION", "ON_CALL", "OTHER"] as const satisfies readonly VehicleUnavailabilityKind[];
export const MAINTENANCE_KINDS = ["INSPECTION", "SERVICE", "TIRES", "INSURANCE", "OTHER"] as const satisfies readonly MaintenanceKind[];
export const ENERGY_TYPES = ["DIESEL", "PETROL", "HYBRID", "ELECTRIC", "OTHER"] as const satisfies readonly EnergyType[];

export const MAX_UNAVAILABILITY_DAYS = 366;
export const MAX_ODOMETER_KM = 2_000_000;

export const unavailabilitySchema = z
  .object({
    kind: z.enum(UNAVAILABILITY_KINDS, { error: "Choisissez un motif." }),
    startDate: dateField(),
    endDate: dateField(),
    note: optionalText(200),
  })
  .superRefine((v, ctx) => {
    if (v.endDate < v.startDate) {
      ctx.addIssue({ code: "custom", path: ["endDate"], message: "La fin doit être le même jour que le début, ou après." });
    } else if (v.endDate > addDays(v.startDate, MAX_UNAVAILABILITY_DAYS - 1)) {
      ctx.addIssue({ code: "custom", path: ["endDate"], message: `Au plus ${MAX_UNAVAILABILITY_DAYS} jours d'affilée.` });
    }
  });

const KM_OPTIONS = { integer: true, min: 0, max: MAX_ODOMETER_KM, unit: "km" } as const;

export const deadlineSchema = z
  .object({
    kind: z.enum(MAINTENANCE_KINDS, { error: "Choisissez un type d'échéance." }),
    label: optionalText(60),
    dueDate: optionalDateField(),
    dueKm: optionalNumberField(KM_OPTIONS),
    note: optionalText(200),
  })
  .superRefine((v, ctx) => {
    if (v.dueDate === null && v.dueKm === undefined) {
      ctx.addIssue({ code: "custom", path: ["dueDate"], message: "Indiquez une date, un kilométrage, ou les deux." });
    }
  })
  .transform((v) => ({ ...v, dueKm: v.dueKm ?? null }));

export const fuelSchema = z.object({
  date: dateField(),
  odometerKm: numberField(KM_OPTIONS),
  quantity: numberField({ min: 0.1, max: 500, unit: "L ou kWh" }),
  cost: numberField({ min: 0, max: 2000, unit: "€" }),
  fullTank: z
    .string()
    .optional()
    .transform((v) => v === "on" || v === "true"),
  note: optionalText(200),
});

export type FuelInput = z.output<typeof fuelSchema>;

/**
 * An odometer reading must not go backwards: the readings on or before its
 * date must be lower or equal, those after it higher or equal. Message, or null.
 */
export function odometerConflict(
  entry: Pick<FuelInput, "date" | "odometerKm">,
  others: readonly { date: string; odometerKm: number }[],
): string | null {
  const nf = new Intl.NumberFormat("fr-FR");
  for (const o of others) {
    if (o.date <= entry.date && o.odometerKm > entry.odometerKm) {
      return `Compteur inférieur au relevé du ${formatShortDate(o.date)} (${nf.format(o.odometerKm)}\u00a0km).`;
    }
    if (o.date > entry.date && o.odometerKm < entry.odometerKm) {
      return `Compteur supérieur au relevé suivant du ${formatShortDate(o.date)} (${nf.format(o.odometerKm)}\u00a0km).`;
    }
  }
  return null;
}

/** Empty fuel form, today's date by default. */
export function emptyFuelValues(today: string): FormValues {
  return { date: today, odometerKm: "", quantity: "", cost: "", fullTank: "on", note: "" };
}
