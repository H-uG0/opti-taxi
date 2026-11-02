/**
 * Validation of the address fields shared by the patient and facility forms.
 * Pure module (no server-only import): used by server actions and tests.
 */
import { z } from "zod";
import { GEOCODE_QUERY_MAX, LAT_RANGE, LNG_RANGE } from "./address-utils";

function formatBound(value: number): string {
  return String(value).replace(".", ",");
}

/** Accepts "43.2965" as well as the French "43,2965". */
function coordinate(label: string, range: { min: number; max: number }) {
  const outOfRange = `${label} hors de France métropolitaine (entre ${formatBound(range.min)} et ${formatBound(range.max)})`;
  return z
    .string()
    .trim()
    .min(1, `${label} obligatoire`)
    .transform((value, ctx) => {
      const n = Number(value.replace(",", "."));
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: "custom", message: `${label} : nombre décimal attendu (ex. 43,2965)` });
        return z.NEVER;
      }
      return n;
    })
    .pipe(z.number().min(range.min, outOfRange).max(range.max, outOfRange));
}

export const addressShape = {
  address: z.string().trim().min(1, "Adresse obligatoire").max(200, "Adresse trop longue (200 caractères max.)"),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{5}$/, "Code postal : 5 chiffres"),
  city: z.string().trim().min(1, "Ville obligatoire").max(100, "Ville trop longue (100 caractères max.)"),
  lat: coordinate("Latitude", LAT_RANGE),
  lng: coordinate("Longitude", LNG_RANGE),
};

export const addressSchema = z.object(addressShape);
export type AddressData = z.infer<typeof addressSchema>;

export const geocodeQuerySchema = z
  .string()
  .trim()
  .min(3, "Saisissez au moins 3 caractères d'adresse.")
  .max(GEOCODE_QUERY_MAX, `Adresse trop longue pour la recherche (${GEOCODE_QUERY_MAX} caractères max.).`);
