/**
 * Form plumbing for every regulator screen (patients, établissements,
 * véhicules, personnel, tarifs, paramètres…): server action state, FormData
 * reading, tolerant French number / time / date parsing and Prisma
 * unique-constraint detection. The one form-state module of the app.
 *
 * Pure module (no server-only import): unit-tested with vitest and importable
 * from client components.
 */
import { z } from "zod";
import { isIsoDate, parseMinute } from "@/lib/time";

/** Raw form values as strings (multi-valued fields such as checkbox groups are arrays). */
export type FormValues = Record<string, string | string[]>;
export type FieldErrors = Record<string, string>;

/** State returned by every form server action (useActionState). */
export type FormState = {
  status: "idle" | "error" | "success";
  message: string | null;
  fieldErrors: FieldErrors;
  /** Submitted values echoed back after an error so the form keeps what was typed. */
  values: FormValues | null;
  /** Changes on every response: used as the form `key` so inputs remount with `values`. */
  submissionId: number;
};

export const IDLE_STATE: FormState = {
  status: "idle",
  message: null,
  fieldErrors: {},
  values: null,
  submissionId: 0,
};

export const REQUIRED = "Champ obligatoire.";
export const GENERIC_ERROR = "Le formulaire contient des erreurs : corrigez les champs signalés.";

/** Label of a button while its action runs; a save says « Enregistrement… » (SAVING_LABEL). */
export const PENDING_LABEL = "En cours…";
export const SAVING_LABEL = "Enregistrement…";

/** Result of a one-button action (deactivate, delete, cancel a trip…): a success or a refusal, one line. */
export type ActionResult = { ok: boolean; message: string | null };

export const INITIAL_ACTION_RESULT: ActionResult = { ok: true, message: null };

function nextSubmissionId(): number {
  return Date.now() + Math.random();
}

export function errorState(fieldErrors: FieldErrors, values: FormValues | null, message: string = GENERIC_ERROR): FormState {
  return { status: "error", message, fieldErrors, values, submissionId: nextSubmissionId() };
}

/** Error without field detail (record not found, forbidden transition…). */
export function messageState(message: string, values: FormValues | null = null): FormState {
  return errorState({}, values, message);
}

export function successState(message: string): FormState {
  return { status: "success", message, fieldErrors: {}, values: null, submissionId: nextSubmissionId() };
}

/** First message per top-level field; issues without a path become form-level messages. */
export function fieldErrorsFromZod(error: z.ZodError): { fieldErrors: FieldErrors; formErrors: string[] } {
  const fieldErrors: FieldErrors = {};
  const formErrors: string[] = [];
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (key === undefined) formErrors.push(issue.message);
    else fieldErrors[String(key)] ??= issue.message;
  }
  return { fieldErrors, formErrors };
}

export function invalidState(error: z.ZodError, values: FormValues | null): FormState {
  const { fieldErrors, formErrors } = fieldErrorsFromZod(error);
  return errorState(fieldErrors, values, formErrors[0] ?? GENERIC_ERROR);
}

/**
 * FormData -> plain object of strings. Fields listed in `multi` are read with
 * getAll() and always present (empty array when no checkbox is ticked).
 * Next.js internal `$ACTION_*` keys and files are skipped.
 */
export function readForm(formData: FormData, multi: readonly string[] = []): FormValues {
  const values: FormValues = {};
  for (const key of new Set(formData.keys())) {
    if (key.startsWith("$ACTION")) continue;
    if (multi.includes(key)) {
      values[key] = formData.getAll(key).filter((v): v is string => typeof v === "string");
    } else {
      const value = formData.get(key);
      if (typeof value === "string") values[key] = value;
    }
  }
  for (const key of multi) values[key] ??= [];
  return values;
}

/** A text input value ("" when missing or a file). */
export function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/** All values of a multi-valued input (checkbox group). */
export function formStrings(formData: FormData, key: string): string[] {
  return formData.getAll(key).filter((v): v is string => typeof v === "string");
}

/** A checkbox is "on" when checked and absent otherwise. */
export function formCheckbox(formData: FormData, key: string): boolean {
  return formData.get(key) === "on";
}

/** Reads a value for a form input: the echoed value after a rejected submit, else the initial one. */
export function echoed(state: Pick<FormState, "values">, key: string, initial: string): string {
  const value = state.values?.[key];
  return typeof value === "string" ? value : initial;
}

/** Checkbox state: absent from the echoed values means unchecked. */
export function echoedCheckbox(state: Pick<FormState, "values">, key: string, initial: boolean): boolean {
  if (!state.values) return initial;
  return state.values[key] === "on";
}

/** Checkbox group: the echoed list after a rejected submit, else the initial list. */
export function echoedList(state: Pick<FormState, "values">, key: string, initial: string[]): string[] {
  if (!state.values) return initial;
  const value = state.values[key];
  if (Array.isArray(value)) return value;
  return typeof value === "string" ? [value] : [];
}

/**
 * Key that changes on every refused submission (null otherwise): ErrorFocus moves the focus to the
 * first field to correct, or to the form message, each time it changes.
 */
export function refusalKey(state: Pick<FormState, "status" | "submissionId">): number | null {
  return state.status === "error" ? state.submissionId : null;
}

export function valueOf(values: FormValues, key: string): string {
  const value = values[key];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export function listOf(values: FormValues, key: string): string[] {
  const value = values[key];
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

// ---------------------------------------------------------------- numbers

/**
 * Tolerant decimal parsing for French input: "1,25", "1.25", " 1 250,5 ".
 * Empty -> undefined (missing), anything else that is not a number -> NaN.
 */
export function parseDecimal(raw: unknown): number | undefined {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return undefined;
  const compact = raw.trim().replace(/[\s  ]/g, "").replace(",", ".");
  if (compact === "") return undefined;
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(compact) ? Number(compact) : Number.NaN;
}

const numberFormatter = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 4 });

export function formatNumber(value: number): string {
  return numberFormatter.format(value);
}

/** Number -> input text with a French decimal comma ("0,32"); null/undefined -> "". */
export function formatDecimalInput(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return String(value).replace(".", ",");
}

export type NumberOptions = {
  min?: number;
  max?: number;
  integer?: boolean;
  /** Appended to range messages, e.g. "€/km". */
  unit?: string;
  minMessage?: string;
  maxMessage?: string;
};

function numberSchema({ min, max, integer = false, unit, minMessage, maxMessage }: NumberOptions) {
  const suffix = unit ? ` ${unit}` : "";
  let schema = z.number({
    error: (issue) => (issue.input === undefined ? REQUIRED : "Nombre attendu (ex. 12,5)."),
  });
  if (integer) schema = schema.int("Nombre entier attendu.");
  if (min !== undefined) schema = schema.min(min, minMessage ?? `Minimum : ${formatNumber(min)}${suffix}.`);
  if (max !== undefined) schema = schema.max(max, maxMessage ?? `Maximum : ${formatNumber(max)}${suffix}.`);
  return schema;
}

export function numberField(options: NumberOptions = {}) {
  return z.preprocess(parseDecimal, numberSchema(options));
}

export function optionalNumberField(options: NumberOptions = {}) {
  return z.preprocess(parseDecimal, numberSchema(options).optional());
}

// ------------------------------------------------------------------- text

export function requiredText(max: number) {
  return z.string({ error: REQUIRED }).trim().min(1, REQUIRED).max(max, `${max} caractères maximum.`);
}

/** Optional text: blank -> null. */
export function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max, `${max} caractères maximum.`)
    .optional()
    .transform((value) => (value ? value : null));
}

export const idSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

/** Optional foreign key from a <select>: "" -> null. */
export const optionalIdField = z
  .string()
  .trim()
  .max(64, "Identifiant invalide.")
  .regex(/^[A-Za-z0-9_-]*$/, "Identifiant invalide.")
  .optional()
  .transform((value) => (value ? value : null));

// ------------------------------------------------------------------- time

/** "07:30", "7:30", "7h30", "07h" -> minutes since midnight; "" -> undefined; else NaN. */
export function parseTimeInput(raw: unknown): number | undefined {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  if (value === "") return undefined;
  const normalized = value.replace(/^(\d{1,2})\s*h\s*(\d{2})?$/, (_, h: string, m: string | undefined) => `${h}:${m ?? "00"}`);
  return parseMinute(normalized) ?? Number.NaN;
}

const timeError = (issue: { input?: unknown }) =>
  issue.input === undefined ? REQUIRED : "Heure attendue au format HH:MM (ex. 07:30).";

export function timeField() {
  return z.preprocess(parseTimeInput, z.number({ error: timeError }));
}

export function optionalTimeField() {
  return z.preprocess(parseTimeInput, z.number({ error: timeError }).optional());
}

// ------------------------------------------------------------------- dates

/** "2025-05-01" or "01/05/2025" -> "2025-05-01"; anything else is returned trimmed. */
export function normalizeDateInput(raw: string): string {
  const value = raw.trim();
  const french = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (!french) return value;
  const [, day = "", month = "", year = ""] = french;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function toDateInput(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  return raw.trim() === "" ? undefined : normalizeDateInput(raw);
}

const INVALID_DATE = "Date invalide (JJ/MM/AAAA).";

/** Required calendar date -> "YYYY-MM-DD". */
export function dateField() {
  return z.preprocess(toDateInput, z.string({ error: REQUIRED }).refine((v) => isIsoDate(v), INVALID_DATE));
}

/** Optional calendar date -> "YYYY-MM-DD" or null. */
export function optionalDateField() {
  return z.preprocess(
    toDateInput,
    z
      .string()
      .refine((v) => isIsoDate(v), INVALID_DATE)
      .optional()
      .transform((value) => value ?? null),
  );
}

// ------------------------------------------------------------------ prisma

/**
 * True when `error` is a Prisma unique-constraint violation (P2002) on `field`.
 * Duck-typed so this module does not import the Prisma runtime.
 */
export function isUniqueViolation(error: unknown, field: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: unknown; meta?: { target?: unknown }; message?: unknown };
  if (e.code !== "P2002") return false;
  const target = e.meta?.target;
  if (Array.isArray(target)) return target.some((t) => String(t) === field);
  if (typeof target === "string") return target.includes(field);
  return typeof e.message === "string" && e.message.includes(`\`${field}\``);
}
