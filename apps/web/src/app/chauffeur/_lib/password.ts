/**
 * « Changer mon mot de passe » of the driver app: form rules and messages.
 * Pure module, unit-tested; the action is in ../mot-de-passe/actions.ts.
 * Same length rules as the password a regulator sets (chauffeurs/schema.ts).
 */
import { z } from "zod";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@/app/(regulator)/chauffeurs/schema";

export const WRONG_CURRENT_PASSWORD = "Mot de passe actuel incorrect.";

export const PASSWORD_CHANGED =
  "Mot de passe changé. Vos sessions ouvertes sur d'autres appareils sont fermées : " +
  "reconnectez-vous-y avec ce nouveau mot de passe.";

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
