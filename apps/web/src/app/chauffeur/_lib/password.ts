/**
 * « Changer mon mot de passe » of the driver app: form rules and messages.
 * Pure module, unit-tested; the action is in ../mot-de-passe/actions.ts.
 * Same length rules as the password a regulator sets (chauffeurs/schema.ts).
 */
import { z } from "zod";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@/app/(regulator)/chauffeurs/schema";

export const WRONG_CURRENT_PASSWORD = "Mot de passe actuel incorrect.";
/** Same check while the password is still the one the regulation gave. */
export const WRONG_PROVISIONAL_PASSWORD = "Mot de passe provisoire incorrect : reprenez celui que la régulation vous a donné.";

/** First choice of a password (it was provisional): the driver has no other session to hear about. */
export const PASSWORD_SET = "Mot de passe enregistré : utilisez-le désormais pour vous connecter.";

export const PASSWORD_CHANGED =
  "Mot de passe changé : utilisez-le désormais pour vous connecter. " +
  "Vos sessions ouvertes sur d'autres appareils sont fermées.";

/**
 * The change is refused by the sign-in throttle (5 wrong passwords for the
 * account): the driver cannot sign in again either until it lifts, hence the
 * call to the regulation.
 */
export function tooManyPasswordAttempts(retryInMin: number): string {
  return (
    `Trop d'essais : réessayez dans ${retryInMin} min ou appelez la régulation. ` +
    "D'ici là, vous ne pourrez pas non plus vous reconnecter."
  );
}

export const passwordChangeSchema = z
  .object({
    current: z.string({ error: "Saisissez votre mot de passe actuel." }).min(1, "Saisissez votre mot de passe actuel."),
    next: z
      .string({ error: `${MIN_PASSWORD_LENGTH} caractères minimum.` })
      .min(MIN_PASSWORD_LENGTH, `${MIN_PASSWORD_LENGTH} caractères minimum.`)
      .max(MAX_PASSWORD_LENGTH, `${MAX_PASSWORD_LENGTH} caractères maximum.`),
    confirm: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.next === v.current) {
      ctx.addIssue({ code: "custom", path: ["next"], message: "Choisissez un mot de passe différent de l'actuel." });
    } else if (v.confirm !== v.next) {
      ctx.addIssue({ code: "custom", path: ["confirm"], message: "Les deux mots de passe ne correspondent pas." });
    }
  });

/** The fields of the form, as FormData holds them. */
export function readPasswordForm(formData: FormData): Record<"current" | "next" | "confirm", unknown> {
  return { current: formData.get("current"), next: formData.get("next"), confirm: formData.get("confirm") ?? undefined };
}

/**
 * Fields to empty after a refused change: the ones in error (the confirmation
 * with the new password). The others keep what the driver typed, client-side
 * only: the server never sends a password back.
 */
export function fieldsToClear(fieldErrors: Readonly<Record<string, string>>): Set<"current" | "next" | "confirm"> {
  const cleared = new Set<"current" | "next" | "confirm">();
  if (fieldErrors.current) cleared.add("current");
  if (fieldErrors.next) cleared.add("next").add("confirm");
  if (fieldErrors.confirm) cleared.add("confirm");
  return cleared;
}
