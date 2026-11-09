/**
 * Validation of the trips screen forms and construction of a one-off trip.
 * Pure (zod + domain rules): shared by the server actions and the tests.
 */
import type { Payer, Prisma, PrescribedMode, SharingScope, TripDirection } from "@prisma/client";
import { z } from "zod";
import { LAT_RANGE, LNG_RANGE } from "@/components/address/address-utils";
import { CANCELLATION_NOTE_MAX, USER_CANCELLATION_REASONS } from "@/lib/domain/cancellation";
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

/** "43.29" or "43,29" -> 43.29; empty, missing or not a number -> null. */
function coordinateValue(value: string | undefined): number | null {
  const text = value?.trim();
  if (!text) return null;
  const n = Number(text.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

type Range = { readonly min: number; readonly max: number };

const inRange = (n: number, range: Range) => n >= range.min && n <= range.max;

function formatBound(value: number): string {
  return String(value).replace(".", ",");
}

/**
 * A typed coordinate of the destination, in metropolitan France (the ranges of
 * the address forms): a point outside goes to the optimizer hundreds of
 * kilometres away. Accepts "43.29" or "43,29"; empty -> undefined.
 */
const optionalCoordinate = (label: string, range: Range, example: string) =>
  z
    .string()
    .trim()
    .optional()
    .transform((value, ctx) => {
      if (!value) return undefined;
      const n = coordinateValue(value);
      if (n === null) {
        ctx.addIssue({ code: "custom", message: `${label} invalide : nombre décimal attendu (ex. ${example}).` });
        return z.NEVER;
      }
      if (!inRange(n, range)) {
        ctx.addIssue({
          code: "custom",
          message: `${label} invalide : hors de France métropolitaine (entre ${formatBound(range.min)} et ${formatBound(range.max)}).`,
        });
        return z.NEVER;
      }
      return n;
    });

/** Most common typing mistake on a coordinate pair, shown instead of the two range errors. */
export const SWAPPED_COORDINATES_MESSAGE =
  "Latitude et longitude semblent inversées (Marseille : latitude 43,30 ; longitude 5,37).";

/** Latitude typed as longitude and the reverse: the pair is outside France, the swapped pair inside. */
function looksSwapped(rawLat: string | undefined, rawLng: string | undefined): boolean {
  const lat = coordinateValue(rawLat);
  const lng = coordinateValue(rawLng);
  if (lat === null || lng === null) return false;
  const inFrance = (la: number, lo: number) => inRange(la, LAT_RANGE) && inRange(lo, LNG_RANGE);
  return !inFrance(lat, lng) && inFrance(lng, lat);
}

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
  destinationLat: optionalCoordinate("Latitude", LAT_RANGE, "43,2965"),
  destinationLng: optionalCoordinate("Longitude", LNG_RANGE, "5,3698"),
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
 * - free coordinates come as a latitude + longitude pair, in metropolitan
 *   France; a pair typed the wrong way round is reported as such;
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
  if (looksSwapped(raw.destinationLat, raw.destinationLng)) {
    errors.destinationLat = [SWAPPED_COORDINATES_MESSAGE];
    delete errors.destinationLng;
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

/** « Péage » of a trip: euros on this patient's invoice (French decimal comma); blank = none. */
export const tollSchema = z.object({
  tripId: tripIdSchema,
  toll: z
    .string()
    .trim()
    .transform((raw) => (raw === "" ? null : Number(raw.replace(/\s/g, "").replace(",", "."))))
    .refine((value) => value === null || (Number.isFinite(value) && value >= 0 && value <= 1000), "Péage entre 0 et 1 000 €.")
    .transform((value) => (value === null || value === 0 ? null : Math.round(value * 100) / 100)),
});

export const CANCEL_TRIP_FIELDS = ["tripId", "reason", "note", "returnTripId"] as const;

/**
 * « Annuler la course » : a reason from the list (a free note is required with
 * « Autre motif »), and the return of the same care when the box « annuler
 * aussi le retour » is ticked (its id, only sent when ticked).
 */
export const cancelTripSchema = z
  .object({
    tripId: tripIdSchema,
    reason: z.enum(USER_CANCELLATION_REASONS, { error: "Choisissez le motif de l'annulation." }),
    note: optionalText(CANCELLATION_NOTE_MAX, `Précision trop longue (${CANCELLATION_NOTE_MAX} caractères au plus).`),
    returnTripId: optionalId,
  })
  .superRefine((value, ctx) => {
    if (value.reason === "OTHER" && !value.note) {
      ctx.addIssue({ code: "custom", path: ["note"], message: "Précisez le motif de l'annulation." });
    }
  });

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
