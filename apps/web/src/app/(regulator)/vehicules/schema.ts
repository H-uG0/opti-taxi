/**
 * Vehicle form: validation, normalisation and the mapping between a Vehicle
 * row and form values. Pure module (unit-tested); crew qualification rules
 * live in ./_lib/crew.ts.
 */
import { z } from "zod";
import type { Vehicle, VehicleType } from "@prisma/client";
import { DEFAULT_CAPACITY } from "@/lib/domain/rules";
import { departmentField } from "./_lib/departments";
import {
  formatDecimalInput,
  numberField,
  optionalIdField,
  optionalNumberField,
  requiredText,
  REQUIRED,
  type FormValues,
} from "@/lib/forms";

const CHOOSE_DEPOT = "Choisissez un dépôt.";

export const VEHICLE_TYPES = ["TAXI", "VSL", "AMBULANCE"] as const satisfies readonly VehicleType[];

/** V shares at most 2 patients (DEFAULT_CAPACITY); the VSL texts (avenant 11) allow up to 3. */
export const MAX_SHARED_CAPACITY = 3;

/** "ab 123 cd" -> "AB-123-CD": uppercase, spaces and underscores become single dashes. */
export function normalizeRegistration(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

const vehicleFields = z.object({
  label: requiredText(60),
  registration: z.preprocess(
    (raw) => (typeof raw === "string" ? normalizeRegistration(raw) : raw),
    z
      .string({ error: REQUIRED })
      .min(1, REQUIRED)
      .max(15, "15 caractères maximum.")
      .regex(/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/, "Lettres, chiffres et tirets uniquement (ex. AB-123-CD)."),
  ),
  type: z.enum(VEHICLE_TYPES, { error: "Choisissez un type de véhicule." }),
  capacity: optionalNumberField({ integer: true }),
  depotId: z
    .string({ error: CHOOSE_DEPOT })
    .trim()
    .min(1, CHOOSE_DEPOT)
    .max(64, "Identifiant invalide.")
    .regex(/^[A-Za-z0-9_-]+$/, "Identifiant invalide."),
  department: departmentField(),
  costPerKm: numberField({ min: 0, max: 10, unit: "€/km" }),
  defaultDriverId: optionalIdField,
  defaultCrewMateId: optionalIdField,
});

export const vehicleSchema = vehicleFields
  .superRefine((v, ctx) => {
    if (v.type !== "AMBULANCE" && v.capacity !== undefined && (v.capacity < 1 || v.capacity > MAX_SHARED_CAPACITY)) {
      ctx.addIssue({
        code: "custom",
        path: ["capacity"],
        message: `Entre 1 et ${MAX_SHARED_CAPACITY} patients (règle de V : 2).`,
      });
    }
    if (v.type === "AMBULANCE" && v.defaultCrewMateId !== null && v.defaultCrewMateId === v.defaultDriverId) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultCrewMateId"],
        message: "L'équipier doit être une autre personne que le chauffeur.",
      });
    }
  })
  .transform((v) => ({
    ...v,
    // An ambulance carries one lying patient; taxis and VSL default to V's rule.
    capacity: v.type === "AMBULANCE" ? 1 : (v.capacity ?? DEFAULT_CAPACITY[v.type]),
    // Only an ambulance has a crew mate.
    defaultCrewMateId: v.type === "AMBULANCE" ? v.defaultCrewMateId : null,
  }));

export type VehicleInput = z.output<typeof vehicleSchema>;

type VehicleRecord = Pick<
  Vehicle,
  | "label"
  | "registration"
  | "type"
  | "capacity"
  | "depotId"
  | "department"
  | "costPerKm"
  | "defaultDriverId"
  | "defaultCrewMateId"
>;

/** Form values of an existing vehicle, or of a new one. */
export function vehicleFormValues(vehicle?: VehicleRecord): FormValues {
  if (!vehicle) {
    return {
      label: "",
      registration: "",
      type: "TAXI",
      capacity: String(DEFAULT_CAPACITY.TAXI),
      depotId: "",
      department: "",
      costPerKm: "",
      defaultDriverId: "",
      defaultCrewMateId: "",
    };
  }
  return {
    label: vehicle.label,
    registration: vehicle.registration,
    type: vehicle.type,
    capacity: String(vehicle.capacity),
    depotId: vehicle.depotId,
    department: vehicle.department,
    costPerKm: formatDecimalInput(vehicle.costPerKm),
    defaultDriverId: vehicle.defaultDriverId ?? "",
    defaultCrewMateId: vehicle.defaultCrewMateId ?? "",
  };
}

export function isVehicleType(value: string): value is VehicleType {
  return (VEHICLE_TYPES as readonly string[]).includes(value);
}
