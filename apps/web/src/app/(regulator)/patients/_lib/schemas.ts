/**
 * Validation of the patient, prescription and recurrence forms.
 * Pure module: used by the server actions and the unit tests.
 */
import { z } from "zod";
import { addressShape } from "@/components/address/address-schema";
import { readAddressForm } from "@/components/address/address-utils";
import { isIsoDate, parseMinute } from "@/lib/time";
import { optionalPhone, optionalText, parseForm, type ParseResult } from "./form-parse";
import { formCheckbox, formString, formStrings, type FormValues } from "@/lib/forms";
import { MAX_SESSION_MINUTES, MOBILITIES, PRESCRIBED_MODES, RECURRENCE_LEGS, SHARING_SCOPES } from "./options";

function requiredDate(label: string) {
  return z
    .string()
    .trim()
    .min(1, `${label} obligatoire`)
    .refine((v) => isIsoDate(v), { message: `${label} invalide (JJ/MM/AAAA)` });
}

function optionalDate(label: string) {
  return z
    .string()
    .trim()
    .refine((v) => v === "" || isIsoDate(v), { message: `${label} invalide (JJ/MM/AAAA)` })
    .transform((v) => (v === "" ? null : v));
}

// ---------------------------------------------------------------- patient

export const patientSchema = z.object({
  lastName: z.string().trim().min(1, "Nom obligatoire").max(80, "Nom trop long (80 caractères max.)"),
  firstName: z.string().trim().min(1, "Prénom obligatoire").max(80, "Prénom trop long (80 caractères max.)"),
  phone: optionalPhone,
  ...addressShape,
  mobility: z.enum(MOBILITIES, { error: "Choisissez une mobilité" }),
  accessNotes: optionalText(1000, "Notes d'accès"),
});

export type PatientInput = z.output<typeof patientSchema>;

export function readPatientForm(formData: FormData): { raw: Record<string, unknown>; values: FormValues } {
  const address = readAddressForm(formData);
  const values: FormValues = {
    lastName: formString(formData, "lastName"),
    firstName: formString(formData, "firstName"),
    phone: formString(formData, "phone"),
    ...address,
    mobility: formString(formData, "mobility"),
    accessNotes: formString(formData, "accessNotes"),
  };
  return { raw: values, values };
}

export function parsePatientForm(formData: FormData): ParseResult<PatientInput> {
  const { raw, values } = readPatientForm(formData);
  return parseForm(patientSchema, raw, values);
}

// ---------------------------------------------------------------- prescription

export const prescriptionSchema = z
  .object({
    mode: z.enum(PRESCRIBED_MODES, { error: "Choisissez le mode prescrit" }),
    sharing: z.enum(SHARING_SCOPES, { error: "Choisissez le partage autorisé" }),
    validFrom: requiredDate("Début de validité"),
    validTo: requiredDate("Fin de validité"),
    isSeries: z.boolean(),
    prescriber: optionalText(120, "Prescripteur"),
    notes: optionalText(1000, "Notes"),
  })
  .superRefine((p, ctx) => {
    if (isIsoDate(p.validFrom) && isIsoDate(p.validTo) && p.validTo < p.validFrom) {
      ctx.addIssue({
        code: "custom",
        path: ["validTo"],
        message: "La fin de validité doit être égale ou postérieure au début",
      });
    }
  })
  // Sharing only concerns seated transport: an ambulance always carries one patient.
  .transform((p) => (p.mode === "AMBULANCE" ? { ...p, sharing: "NONE" as const } : p));

export type PrescriptionInput = z.output<typeof prescriptionSchema>;

export function parsePrescriptionForm(formData: FormData): ParseResult<PrescriptionInput> {
  const values: FormValues = {
    mode: formString(formData, "mode"),
    sharing: formString(formData, "sharing"),
    validFrom: formString(formData, "validFrom"),
    validTo: formString(formData, "validTo"),
    prescriber: formString(formData, "prescriber"),
    notes: formString(formData, "notes"),
  };
  if (formCheckbox(formData, "isSeries")) values.isSeries = "on";
  return parseForm(prescriptionSchema, { ...values, isSeries: formCheckbox(formData, "isSeries") }, values);
}

// ---------------------------------------------------------------- recurrence

export const recurrenceSchema = z
  .object({
    facilityId: z.string().trim().min(1, "Choisissez un établissement").max(64),
    prescriptionId: z.string().trim().min(1, "Choisissez une prescription").max(64),
    label: optionalText(80, "Libellé"),
    weekdays: z
      .array(z.string().regex(/^[1-7]$/, "Jour invalide"))
      .min(1, "Cochez au moins un jour")
      .transform((days) => [...new Set(days.map(Number))].sort((a, b) => a - b)),
    appointmentTime: z
      .string()
      .trim()
      .min(1, "Heure de rendez-vous obligatoire")
      .transform((value, ctx) => {
        const minute = parseMinute(value);
        if (minute === null) {
          ctx.addIssue({ code: "custom", message: "Heure invalide (HH:MM, ex. 07:30)" });
          return z.NEVER;
        }
        return minute;
      }),
    sessionMinutes: z
      .string()
      .trim()
      .min(1, "Durée de séance obligatoire")
      .regex(/^\d+$/, "Durée en minutes entières")
      .transform(Number)
      .pipe(
        z
          .number()
          .int()
          .min(0, "Durée positive attendue")
          .max(MAX_SESSION_MINUTES, `Durée de séance : ${MAX_SESSION_MINUTES} min au plus`),
      ),
    legs: z.enum(RECURRENCE_LEGS, { error: "Choisissez les trajets" }),
    startDate: requiredDate("Date de début"),
    endDate: optionalDate("Date de fin"),
  })
  .superRefine((r, ctx) => {
    if (r.endDate !== null && isIsoDate(r.startDate) && r.endDate < r.startDate) {
      ctx.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "La date de fin doit être égale ou postérieure à la date de début",
      });
    }
    const end = r.appointmentTime + r.sessionMinutes;
    if (r.legs !== "OUTBOUND" && Number.isFinite(end) && end >= 1440) {
      ctx.addIssue({
        code: "custom",
        path: ["sessionMinutes"],
        message: "La fin de séance dépasse minuit : le retour ne peut pas être planifié",
      });
    }
  })
  .transform(({ appointmentTime, ...r }) => ({ ...r, appointmentMinute: appointmentTime }));

export type RecurrenceInput = z.output<typeof recurrenceSchema>;

export function readRecurrenceForm(formData: FormData): FormValues {
  return {
    facilityId: formString(formData, "facilityId"),
    prescriptionId: formString(formData, "prescriptionId"),
    label: formString(formData, "label"),
    weekdays: formStrings(formData, "weekdays"),
    appointmentTime: formString(formData, "appointmentTime"),
    sessionMinutes: formString(formData, "sessionMinutes"),
    legs: formString(formData, "legs"),
    startDate: formString(formData, "startDate"),
    endDate: formString(formData, "endDate"),
  };
}

export function parseRecurrenceForm(formData: FormData): ParseResult<RecurrenceInput> {
  const values = readRecurrenceForm(formData);
  return parseForm(recurrenceSchema, values, values);
}
