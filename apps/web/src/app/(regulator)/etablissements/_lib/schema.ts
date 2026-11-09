/**
 * Validation of the facility form. Pure module: used by the server actions
 * and the unit tests.
 */
import { z } from "zod";
import { addressShape } from "@/components/address/address-schema";
import { readAddressForm } from "@/components/address/address-utils";
import { optionalPhone, optionalText, parseForm, type ParseResult } from "@/app/(regulator)/patients/_lib/form-parse";
import { formString, type FormValues } from "@/app/(regulator)/patients/_lib/form-state";
import { parseDecimal } from "@/lib/forms";
import { FACILITY_TYPES } from "./options";

/** Most minutes a facility adds to the stop there (the settings' own durations are 60 min at most). */
export const MAX_FACILITY_EXTRA_SERVICE_MIN = 60;

/** Minutes added to the stop at the facility; blank: 0. Plain decimal digits only, as the other numeric fields (parseDecimal). */
const extraServiceMin = z.preprocess(
  (value) => parseDecimal(value) ?? 0,
  z
    .number({ error: "Nombre de minutes attendu" })
    .int("Nombre entier de minutes attendu")
    .min(0, "0 min au moins")
    .max(MAX_FACILITY_EXTRA_SERVICE_MIN, `${MAX_FACILITY_EXTRA_SERVICE_MIN} min au plus`),
);

export const facilitySchema = z.object({
  name: z.string().trim().min(1, "Nom obligatoire").max(120, "Nom trop long (120 caractères max.)"),
  type: z.enum(FACILITY_TYPES, { error: "Choisissez un type d'établissement" }),
  ...addressShape,
  phone: optionalPhone,
  notes: optionalText(1000, "Notes"),
  extraServiceMin,
});

export type FacilityInput = z.output<typeof facilitySchema>;

export function parseFacilityForm(formData: FormData): ParseResult<FacilityInput> {
  const values: FormValues = {
    name: formString(formData, "name"),
    type: formString(formData, "type"),
    ...readAddressForm(formData),
    phone: formString(formData, "phone"),
    notes: formString(formData, "notes"),
    extraServiceMin: formString(formData, "extraServiceMin"),
  };
  return parseForm(facilitySchema, values, values);
}
