/**
 * State exchanged between the referential forms (useActionState) and their
 * server actions. Pure and dependency-free (imported by client components);
 * shared by the patient and facility screens.
 */

export type FieldErrors = Record<string, string[] | undefined>;

/** Raw submitted values, echoed back so a rejected form keeps what was typed. */
export type FormValues = Record<string, string | string[]>;

export type FormState = {
  message: string | null;
  fieldErrors: FieldErrors;
  values: FormValues | null;
};

export const INITIAL_FORM_STATE: FormState = { message: null, fieldErrors: {}, values: null };

/** Result of a one-button action (deactivate, delete…). */
export type ActionResult = { ok: boolean; message: string | null };

export const INITIAL_ACTION_RESULT: ActionResult = { ok: true, message: null };

export const GENERIC_FORM_ERROR = "Le formulaire contient des erreurs : corrigez les champs signalés.";

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

/** A form-level error (not tied to a field) keeping the typed values. */
export function messageState(message: string, values: FormValues | null, fieldErrors: FieldErrors = {}): FormState {
  return { message, fieldErrors, values };
}

/** Reads a value for a form input: the echoed value after a rejected submit, else the initial one. */
export function echoed(state: FormState, key: string, initial: string): string {
  const value = state.values?.[key];
  return typeof value === "string" ? value : initial;
}

/** Checkbox state: absent from the echoed values means unchecked. */
export function echoedCheckbox(state: FormState, key: string, initial: boolean): boolean {
  if (!state.values) return initial;
  return state.values[key] === "on";
}

/** Checkbox group: the echoed list after a rejected submit, else the initial list. */
export function echoedList(state: FormState, key: string, initial: string[]): string[] {
  if (!state.values) return initial;
  const value = state.values[key];
  if (Array.isArray(value)) return value;
  return typeof value === "string" ? [value] : [];
}
