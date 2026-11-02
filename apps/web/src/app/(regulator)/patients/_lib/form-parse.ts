/**
 * zod helpers of the referential forms: FormData validation into a FormState
 * with per-field errors, and common field schemas. Server actions and tests only.
 */
import { z } from "zod";
import { GENERIC_FORM_ERROR, type FieldErrors, type FormState, type FormValues } from "./form-state";

export type ParseResult<T> = { success: true; data: T } | { success: false; state: FormState };

/** Validates `raw` with `schema`; on failure returns a form state with per-field errors. */
export function parseForm<S extends z.ZodType>(
  schema: S,
  raw: unknown,
  values: FormValues,
): ParseResult<z.output<S>> {
  const result = schema.safeParse(raw);
  if (result.success) return { success: true, data: result.data };
  return { success: false, state: errorState(result.error, values) };
}

export function errorState(error: z.ZodError, values: FormValues): FormState {
  const fieldErrors: FieldErrors = {};
  const formErrors: string[] = [];
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === "string") {
      (fieldErrors[key] ??= []).push(issue.message);
    } else {
      formErrors.push(issue.message);
    }
  }
  return { message: formErrors[0] ?? GENERIC_FORM_ERROR, fieldErrors, values };
}

/** Record ids received from forms (cuid). */
export const idSchema = z.string().trim().min(1).max(64);

/** Optional free text: trimmed, "" becomes null. */
export function optionalText(max: number, label = "Texte") {
  return z
    .string()
    .trim()
    .max(max, `${label} trop long (${max} caractères max.)`)
    .transform((v) => (v === "" ? null : v));
}

/** Optional French phone number, kept as typed (spaces, dots, +33…). */
export const optionalPhone = z
  .string()
  .trim()
  .max(30, "Numéro de téléphone trop long")
  .refine((v) => v === "" || (/^[+0-9 ().-]+$/.test(v) && v.replace(/\D/g, "").length >= 6), {
    message: "Numéro de téléphone invalide (chiffres, espaces, points, + uniquement)",
  })
  .transform((v) => (v === "" ? null : v));
