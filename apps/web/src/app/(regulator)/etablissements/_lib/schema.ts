/**
 * Validation of the facility form. Pure module: used by the server actions
 * and the unit tests.
 */
import { z } from "zod";
import { addressShape } from "@/components/address/address-schema";
import { readAddressForm } from "@/components/address/address-utils";
import { optionalPhone, optionalText, parseForm, type ParseResult } from "@/app/(regulator)/patients/_lib/form-parse";
import { formString, type FormValues } from "@/app/(regulator)/patients/_lib/form-state";
import { FACILITY_TYPES } from "./options";

export const facilitySchema = z.object({
  name: z.string().trim().min(1, "Nom obligatoire").max(120, "Nom trop long (120 caractères max.)"),
  type: z.enum(FACILITY_TYPES, { error: "Choisissez un type d'établissement" }),
  ...addressShape,
  phone: optionalPhone,
  notes: optionalText(1000, "Notes"),
});

export type FacilityInput = z.output<typeof facilitySchema>;

export function parseFacilityForm(formData: FormData): ParseResult<FacilityInput> {
  const values: FormValues = {
    name: formString(formData, "name"),
    type: formString(formData, "type"),
    ...readAddressForm(formData),
    phone: formString(formData, "phone"),
    notes: formString(formData, "notes"),
  };
  return parseForm(facilitySchema, values, values);
}
