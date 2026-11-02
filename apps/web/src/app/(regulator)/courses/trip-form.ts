/**
 * Validation of the trips screen forms and construction of a one-off trip.
 * Pure (zod + domain rules): shared by the server actions and the tests.
 */
import type { Payer, Prisma, PrescribedMode, SharingScope, TripDirection } from "@prisma/client";
import { z } from "zod";
import { allowedVehicleTypesFor, formatAddress, initialSharingStatus, sharingAllowedFor } from "@/lib/domain/rules";
import { fromIsoDate, isIsoDate, isoWeekday, parseMinute, toIsoDate } from "@/lib/time";
import { prescriptionValidOn } from "./trip-rules";

/** Result of the small row actions (cancel, restore, schedule, sharing). */
export type ActionResult = { ok: boolean; message: string | null };
export const INITIAL_ACTION_RESULT: ActionResult = { ok: false, message: null };

export type FieldErrors = Partial<Record<string, string[]>>;

/** Reads string fields of a FormData; files and missing fields become undefined. */
export function formValues<K extends string>(formData: FormData, keys: readonly K[]): Record<K, string | undefined> {
  const values = {} as Record<K, string | undefined>;
  for (const key of keys) {
    const value = formData.get(key);
    values[key] = typeof value === "string" ? value : undefined;
  }
  return values;
}

const requiredId = (message: string) => z.string({ error: message }).trim().min(1, message).max(64, message);

/** Empty or missing -> undefined, otherwise the trimmed text. */
const optionalText = (max: number, message: string) =>
  z
    .string()
    .trim()
    .max(max, message)
    .optional()
    .transform((v) => (v ? v : undefined));

const optionalId = optionalText(64, "Identifiant invalide.");

/** Accepts "43.29" or "43,29"; empty -> undefined. */
const optionalCoordinate = (min: number, max: number, message: string) =>
  z
    .string()
    .trim()
    .optional()
    .transform((value, ctx) => {
      if (!value) return undefined;
      const n = Number(value.replace(",", "."));
      if (!Number.isFinite(n) || n < min || n > max) {
        ctx.addIssue({ code: "custom", message });
        return z.NEVER;
      }
      return n;
    });

const isoDateField = z
  .string({ error: "Choisissez une date." })
  .trim()
  .refine((v) => isIsoDate(v), "Date invalide.");

/** "HH:MM" -> minutes since midnight. */
const minuteField = z
  .string({ error: "Saisissez une heure." })
  .trim()
  .transform((value, ctx) => {
    if (!value) {
      ctx.addIssue({ code: "custom", message: "Saisissez une heure." });
      return z.NEVER;
    }
    const minute = parseMinute(value.slice(0, 5));
    if (minute === null) {
      ctx.addIssue({ code: "custom", message: "Heure invalide (format HH:MM)." });
      return z.NEVER;
    }
    return minute;
  });

export const NEW_TRIP_FIELDS = [
  "patientId",
  "payer",
  "prescriptionId",
  "direction",
  "facilityId",
  "destinationAddress",
  "destinationLat",
  "destinationLng",
  "serviceDate",
  "time",
  "notes",
] as const;

export type NewTripField = (typeof NEW_TRIP_FIELDS)[number];
export type NewTripValues = Partial<Record<NewTripField, string>>;

const newTripSchema = z.object({
  patientId: requiredId("Choisissez un patient."),
  payer: z.enum(["CPAM", "PRIVATE"], { error: "Choisissez le payeur." }),
  prescriptionId: optionalId,
  direction: z.enum(["OUTBOUND", "RETURN"], { error: "Choisissez le sens de la course." }),
  facilityId: optionalId,
  destinationAddress: optionalText(200, "Adresse trop longue (200 caractères au plus)."),
  destinationLat: optionalCoordinate(-90, 90, "Latitude invalide (ex. 43.2965)."),
  destinationLng: optionalCoordinate(-180, 180, "Longitude invalide (ex. 5.3698)."),
  serviceDate: isoDateField,
  time: minuteField,
  notes: optionalText(500, "Note trop longue (500 caractères au plus)."),
});

export type NewTripInput = z.output<typeof newTripSchema>;

export type ParseResult<T> = { ok: true; data: T } | { ok: false; errors: FieldErrors };

function addError(errors: FieldErrors, field: string, message: string) {
  if (!errors[field]?.length) errors[field] = [message];
}

/**
 * Validates the one-off trip form. Cross-field rules are checked on the raw
 * values so every error shows at once:
 * - a CPAM trip needs a prescription and a care facility;
 * - a private trip goes to a facility or to a free address;
 * - free coordinates come as a latitude + longitude pair;
 * - no trip in the past.
 */
export function parseNewTrip(raw: NewTripValues, todayIso: string): ParseResult<NewTripInput> {
  const parsed = newTripSchema.safeParse(raw);
  const errors: FieldErrors = parsed.success ? {} : { ...z.flattenError(parsed.error).fieldErrors };

  const filled = (field: NewTripField) => Boolean(raw[field]?.trim());
  if (raw.payer === "CPAM") {
    if (!filled("prescriptionId")) {
      addError(errors, "prescriptionId", "Une course CPAM nécessite une prescription valide à cette date.");
    }
    if (!filled("facilityId")) addError(errors, "facilityId", "Choisissez l'établissement de soins.");
  }
  if (raw.payer === "PRIVATE" && !filled("facilityId")) {
    if (!filled("destinationAddress")) {
      addError(errors, "destinationAddress", "Saisissez l'adresse ou choisissez un établissement.");
    }
    if (filled("destinationLat") !== filled("destinationLng")) {
      addError(errors, filled("destinationLat") ? "destinationLng" : "destinationLat", "Saisissez la latitude et la longitude.");
    }
  }
  const date = raw.serviceDate?.trim();
  if (date && isIsoDate(date) && date < todayIso) {
    addError(errors, "serviceDate", "La date ne peut pas être passée.");
  }

  if (!parsed.success || Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, data: parsed.data };
}

type HomePlace = { id: string; address: string; postalCode: string; city: string; lat: number; lng: number };

export type TripDestination = {
  facilityId: string | null;
  address: string;
  lat: number;
  lng: number;
};

export type TripPrescription = { id: string; mode: PrescribedMode; sharing: SharingScope };

/**
 * Data of a one-off trip, derived like a recurring one: vehicle types from the
 * prescribed mode and payer, sharing from the prescription scope, address
 * snapshot from the patient's home and the destination.
 */
export function buildNewTripData(
  input: Pick<NewTripInput, "payer" | "direction" | "serviceDate" | "time" | "notes">,
  patient: HomePlace,
  prescription: TripPrescription | null,
  destination: TripDestination,
): Prisma.TripUncheckedCreateInput {
  const payer: Payer = input.payer;
  const direction: TripDirection = input.direction;
  const usedPrescription = payer === "CPAM" ? prescription : null;
  const mode = usedPrescription?.mode ?? null;
  const sharingAllowed = sharingAllowedFor(usedPrescription?.sharing ?? null, direction, mode, payer);
  const home = { address: formatAddress(patient), lat: patient.lat, lng: patient.lng };
  const [pickup, dropoff] = direction === "OUTBOUND" ? [home, destination] : [destination, home];

  return {
    serviceDate: fromIsoDate(input.serviceDate),
    direction,
    patientId: patient.id,
    prescriptionId: usedPrescription?.id ?? null,
    recurrenceId: null,
    facilityId: destination.facilityId,
    payer,
    allowedVehicleTypes: allowedVehicleTypesFor(mode, payer),
    pickupAddress: pickup.address,
    pickupLat: pickup.lat,
    pickupLng: pickup.lng,
    dropoffAddress: dropoff.address,
    dropoffLat: dropoff.lat,
    dropoffLng: dropoff.lng,
    appointmentMinute: direction === "OUTBOUND" ? input.time : null,
    readyMinute: direction === "RETURN" ? input.time : null,
    status: "PLANNED",
    sharingAllowed,
    sharingStatus: initialSharingStatus(sharingAllowed),
    notes: input.notes ?? null,
  };
}

/** Prescription check done again on the server: it must belong to the patient and cover the date. */
export function prescriptionUsableOn(
  prescription: { patientId: string; validFrom: Date; validTo: Date },
  patientId: string,
  isoDate: string,
): boolean {
  return (
    prescription.patientId === patientId &&
    prescriptionValidOn(
      { validFrom: toIsoDate(prescription.validFrom), validTo: toIsoDate(prescription.validTo) },
      isoDate,
    )
  );
}

// ---------------------------------------------------------------------------
// Row actions

export const tripIdSchema = requiredId("Course introuvable.");

export const scheduleSchema = z.object({ tripId: tripIdSchema, time: minuteField });

export const sharingDecisionSchema = z.object({
  tripId: tripIdSchema,
  decision: z.enum(["ACCEPTED", "REFUSED"], { error: "Décision de partage inconnue." }),
  note: optionalText(500, "Note trop longue (500 caractères au plus)."),
});

/** The week to generate starts on a Monday. */
export const generateWeekSchema = z.object({
  weekStart: isoDateField.refine((v) => isoWeekday(v) === 1, "La semaine doit commencer un lundi."),
});

/** First error message of a failed parse, for one-line feedback. */
export function firstErrorMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Données invalides.";
}
