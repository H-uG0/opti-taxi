/**
 * The form of a patient's absence (« Absences » on the record): reason, first
 * and last day (included), note. Pure module (unit-tested).
 */
import { z } from "zod";
import { dateField, optionalText } from "@/lib/forms";
import { MAX_PATIENT_ABSENCE_DAYS, PATIENT_ABSENCE_KINDS, PATIENT_ABSENCE_NOTE_MAX } from "@/lib/domain/patient-absences";
import { addDays } from "@/lib/time";

export const patientAbsenceSchema = z
  .object({
    kind: z.enum(PATIENT_ABSENCE_KINDS, { error: "Choisissez un motif." }),
    startDate: dateField(),
    endDate: dateField(),
    note: optionalText(PATIENT_ABSENCE_NOTE_MAX),
  })
  .superRefine((v, ctx) => {
    if (v.endDate < v.startDate) {
      ctx.addIssue({ code: "custom", path: ["endDate"], message: "La fin doit être le même jour que le début, ou après." });
    } else if (v.endDate > addDays(v.startDate, MAX_PATIENT_ABSENCE_DAYS - 1)) {
      ctx.addIssue({ code: "custom", path: ["endDate"], message: `Au plus ${MAX_PATIENT_ABSENCE_DAYS} jours d'affilée.` });
    }
  });

export type PatientAbsenceInput = z.output<typeof patientAbsenceSchema>;
