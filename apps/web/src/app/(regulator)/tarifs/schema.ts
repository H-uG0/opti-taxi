/**
 * Tariff grid form. Shared-transport discounts are typed as percentages in the
 * UI and stored as fractions (23 % -> 0.23), like every rate in the app.
 * Pure module, unit-tested.
 */
import { z } from "zod";
import type { TariffGrid, VehicleType } from "@prisma/client";
import { fromIsoDate, toIsoDate } from "@/lib/time";
import { departmentField } from "../vehicules/_lib/departments";
import {
  dateField,
  formatDecimalInput,
  numberField,
  optionalDateField,
  optionalNumberField,
  optionalText,
  type FormValues,
} from "@/lib/forms";

export const VEHICLE_TYPES = ["TAXI", "VSL", "AMBULANCE"] as const satisfies readonly VehicleType[];

/** 23 -> 0.23 (rounded to 1/100 of a percent to avoid float noise). */
export function percentToFraction(percent: number): number {
  return Math.round(percent * 100) / 10000;
}

/** 0.23 -> 23. */
export function fractionToPercent(fraction: number): number {
  return Math.round(fraction * 10000) / 100;
}

const tariffFields = z.object({
  vehicleType: z.enum(VEHICLE_TYPES, { error: "Choisissez un type de véhicule." }),
  department: departmentField({ allowAllZones: true }),
  label: optionalText(80),
  baseFare: numberField({ min: 0, max: 1000, unit: "€" }),
  pricePerKm: numberField({ min: 0, max: 50, unit: "€/km" }),
  includedKm: optionalNumberField({ min: 0, max: 1000, unit: "km" }),
  sharedDiscount2: numberField({ min: 0, max: 100, unit: "%" }),
  sharedDiscount3: numberField({ min: 0, max: 100, unit: "%" }),
  validFrom: dateField(),
  validTo: optionalDateField(),
  notes: optionalText(500),
});

export const tariffSchema = tariffFields
  .superRefine((v, ctx) => {
    if (v.sharedDiscount3 < v.sharedDiscount2) {
      ctx.addIssue({
        code: "custom",
        path: ["sharedDiscount3"],
        message: "L'abattement à 3 patients ne peut pas être inférieur à celui à 2 patients.",
      });
    }
    if (v.validTo !== null && v.validTo < v.validFrom) {
      ctx.addIssue({
        code: "custom",
        path: ["validTo"],
        message: "La fin de validité doit être postérieure ou égale au début.",
      });
    }
  })
  .transform((v) => ({
    vehicleType: v.vehicleType,
    department: v.department,
    label: v.label,
    baseFare: v.baseFare,
    pricePerKm: v.pricePerKm,
    includedKm: v.includedKm ?? 0,
    sharedDiscount2: percentToFraction(v.sharedDiscount2),
    sharedDiscount3: percentToFraction(v.sharedDiscount3),
    validFrom: fromIsoDate(v.validFrom),
    validTo: v.validTo === null ? null : fromIsoDate(v.validTo),
    notes: v.notes,
  }));

export type TariffInput = z.output<typeof tariffSchema>;

type TariffRecord = Pick<
  TariffGrid,
  | "vehicleType"
  | "department"
  | "label"
  | "baseFare"
  | "pricePerKm"
  | "includedKm"
  | "sharedDiscount2"
  | "sharedDiscount3"
  | "validFrom"
  | "validTo"
  | "notes"
>;

/**
 * Form values of a grid. `overrides` lets "Dupliquer" start a new version
 * from an existing grid (new start date, no end date).
 */
export function tariffFormValues(grid?: TariffRecord, overrides: Partial<Record<string, string>> = {}): FormValues {
  const base: FormValues = grid
    ? {
        vehicleType: grid.vehicleType,
        department: grid.department,
        label: grid.label ?? "",
        baseFare: formatDecimalInput(grid.baseFare),
        pricePerKm: formatDecimalInput(grid.pricePerKm),
        includedKm: formatDecimalInput(grid.includedKm),
        sharedDiscount2: formatDecimalInput(fractionToPercent(grid.sharedDiscount2)),
        sharedDiscount3: formatDecimalInput(fractionToPercent(grid.sharedDiscount3)),
        validFrom: toIsoDate(grid.validFrom),
        validTo: grid.validTo ? toIsoDate(grid.validTo) : "",
        notes: grid.notes ?? "",
      }
    : {
        vehicleType: "TAXI",
        department: "",
        label: "",
        baseFare: "",
        pricePerKm: "",
        includedKm: "0",
        sharedDiscount2: "",
        sharedDiscount3: "",
        validFrom: "",
        validTo: "",
        notes: "",
      };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) base[key] = value;
  }
  return base;
}

export type TariffStatus = "IN_FORCE" | "UPCOMING" | "EXPIRED" | "SUPERSEDED";

export const TARIFF_STATUS_LABELS: Record<TariffStatus, string> = {
  IN_FORCE: "En vigueur aujourd'hui",
  UPCOMING: "À venir",
  EXPIRED: "Expirée",
  SUPERSEDED: "Remplacée",
};

/**
 * Status of a grid on `isoDate`, given the ids returned by tariffsInForce():
 * a grid inside its validity that is not in force was overridden by a more
 * recent grid for the same vehicle type and department.
 */
export function tariffStatus(
  grid: Pick<TariffGrid, "id" | "validFrom" | "validTo">,
  isoDate: string,
  inForceIds: ReadonlySet<string>,
): TariffStatus {
  if (inForceIds.has(grid.id)) return "IN_FORCE";
  if (toIsoDate(grid.validFrom) > isoDate) return "UPCOMING";
  if (grid.validTo && toIsoDate(grid.validTo) < isoDate) return "EXPIRED";
  return "SUPERSEDED";
}
