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
  parseDecimal,
  requiredText,
  REQUIRED,
  type FormValues,
} from "@/lib/forms";

export const VEHICLE_TYPES = ["TAXI", "VSL", "AMBULANCE"] as const satisfies readonly VehicleType[];

/** V shares at most 2 patients (DEFAULT_CAPACITY); the VSL texts (avenant 11) allow up to 3. */
export const MAX_SHARED_CAPACITY = 3;

/** Metropolitan France (Corsica included): catches swapped or mistyped coordinates. */
export const FRANCE_BOUNDS = { minLat: 41, maxLat: 51.2, minLng: -5.3, maxLng: 9.7 } as const;

export function isInFrance(lat: number, lng: number): boolean {
  return (
    lat >= FRANCE_BOUNDS.minLat && lat <= FRANCE_BOUNDS.maxLat && lng >= FRANCE_BOUNDS.minLng && lng <= FRANCE_BOUNDS.maxLng
  );
}

/** "ab 123 cd" -> "AB-123-CD": uppercase, spaces and underscores become single dashes. */
export function normalizeRegistration(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * A "lat, lng" pair pasted from a map ("43.29651, 5.36978", "43,2965 ; 5,3698").
 * Returns null when the text is not exactly two coordinates.
 */
export function parseCoordinatePair(text: string): { lat: string; lng: string } | null {
  const match = /^\s*(-?\d{1,3}(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:[.,]\d+)?)\s*$/.exec(text);
  if (!match) return null;
  const [, lat = "", lng = ""] = match;
  const latNum = parseDecimal(lat);
  const lngNum = parseDecimal(lng);
  if (latNum === undefined || lngNum === undefined || Number.isNaN(latNum) || Number.isNaN(lngNum)) return null;
  if (Math.abs(latNum) > 90 || Math.abs(lngNum) > 180) return null;
  return { lat, lng };
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
  depotLabel: requiredText(60),
  depotAddress: requiredText(200),
  depotLat: numberField({ min: -90, max: 90 }),
  depotLng: numberField({ min: -180, max: 180 }),
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
    if (!isInFrance(v.depotLat, v.depotLng)) {
      ctx.addIssue({
        code: "custom",
        path: ["depotLat"],
        message: isInFrance(v.depotLng, v.depotLat)
          ? "Latitude et longitude semblent inversées (Marseille : latitude 43,30 ; longitude 5,37)."
          : "Coordonnées hors de France métropolitaine : vérifiez la latitude et la longitude.",
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
  | "depotLabel"
  | "depotAddress"
  | "depotLat"
  | "depotLng"
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
      depotLabel: "",
      depotAddress: "",
      depotLat: "",
      depotLng: "",
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
    depotLabel: vehicle.depotLabel,
    depotAddress: vehicle.depotAddress,
    // Coordinates keep the dot used by map tools.
    depotLat: String(vehicle.depotLat),
    depotLng: String(vehicle.depotLng),
    department: vehicle.department,
    costPerKm: formatDecimalInput(vehicle.costPerKm),
    defaultDriverId: vehicle.defaultDriverId ?? "",
    defaultCrewMateId: vehicle.defaultCrewMateId ?? "",
  };
}

export function isVehicleType(value: string): value is VehicleType {
  return (VEHICLE_TYPES as readonly string[]).includes(value);
}
