/**
 * Validation of the facility form. Pure module: used by the server actions
 * and the unit tests.
 */
import { z } from "zod";
import { addressShape } from "@/components/address/address-schema";
import { readAddressForm } from "@/components/address/address-utils";
import { optionalPhone, optionalText, parseForm, type ParseResult } from "@/app/(regulator)/patients/_lib/form-parse";
import { formCheckbox, formString, parseTimeInput, type FormValues } from "@/lib/forms";
import type { OpeningHours } from "@/lib/domain/facility-hours";
import { hoursCloseField, hoursOpenField } from "./hours-fields";

export { hoursCloseField, hoursOpenField };
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
    .min(0, "0\u00a0min au moins")
    .max(MAX_FACILITY_EXTRA_SERVICE_MIN, `${MAX_FACILITY_EXTRA_SERVICE_MIN}\u00a0min au plus`),
);

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/** An optional time of day, "" -> null; anything else that is not HH:MM fails. */
const optionalMinute = z
  .string()
  .trim()
  .transform((value, ctx) => {
    if (value === "") return null;
    const minute = parseTimeInput(value);
    if (minute === undefined || Number.isNaN(minute)) {
      ctx.addIssue({ code: "custom", message: "Heure invalide (HH:MM, ex. 07:00)" });
      return z.NEVER;
    }
    return minute;
  });

const facilityObject = z.object({
  name: z.string().trim().min(1, "Nom obligatoire").max(120, "Nom trop long (120 caractères max.)"),
  type: z.enum(FACILITY_TYPES, { error: "Choisissez un type d'établissement" }),
  ...addressShape,
  phone: optionalPhone,
  notes: optionalText(1000, "Consignes"),
  extraServiceMin,
  openOnHolidays: z.boolean(),
  earliestArrival: optionalMinute,
  ...Object.fromEntries(WEEKDAYS.flatMap((d) => [[hoursOpenField(d), optionalMinute], [hoursCloseField(d), optionalMinute]])),
});

/**
 * The facility form. Reception hours: per weekday an opening and a closing time (both, or neither: no
 * hours that day), and an earliest accepted arrival for every day (lib/domain/facility-hours.ts).
 */
export const facilitySchema = facilityObject
  .superRefine((f, ctx) => {
    const day = f as unknown as Record<string, number | null>;
    for (const d of WEEKDAYS) {
      const open = day[hoursOpenField(d)] ?? null;
      const close = day[hoursCloseField(d)] ?? null;
      if ((open === null) !== (close === null)) {
        ctx.addIssue({ code: "custom", path: [open === null ? hoursOpenField(d) : hoursCloseField(d)], message: "Saisissez l'ouverture et la fermeture" });
      } else if (open !== null && close !== null && close <= open) {
        ctx.addIssue({ code: "custom", path: [hoursCloseField(d)], message: "La fermeture doit suivre l'ouverture" });
      }
    }
  })
  .transform((f) => {
    const day = f as unknown as Record<string, number | null>;
    const openingHours: OpeningHours[] = [];
    for (const d of WEEKDAYS) {
      const open = day[hoursOpenField(d)];
      const close = day[hoursCloseField(d)];
      if (open != null && close != null) openingHours.push({ weekday: d, openMinute: open, closeMinute: close });
    }
    const { name, type, address, postalCode, city, lat, lng, phone, notes, extraServiceMin, openOnHolidays, earliestArrival } = f;
    return {
      name,
      type,
      address,
      postalCode,
      city,
      lat,
      lng,
      phone,
      notes,
      extraServiceMin,
      openOnHolidays,
      openingHours,
      earliestArrivalMinute: earliestArrival,
    };
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
    earliestArrival: formString(formData, "earliestArrival"),
  };
  for (const d of WEEKDAYS) {
    values[hoursOpenField(d)] = formString(formData, hoursOpenField(d));
    values[hoursCloseField(d)] = formString(formData, hoursCloseField(d));
  }
  const openOnHolidays = formCheckbox(formData, "openOnHolidays");
  if (openOnHolidays) values.openOnHolidays = "on";
  return parseForm(facilitySchema, { ...values, openOnHolidays }, values);
}
