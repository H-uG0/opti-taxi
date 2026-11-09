"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Field, FormMessage, Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { IDLE_STATE } from "@/lib/forms";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@/app/(regulator)/chauffeurs/schema";
import { changeOwnPassword } from "./actions";

/** Large fields for a phone: 16 px text (no zoom on focus in iOS Safari), 48 px high. */
const fieldClass = "h-12 text-base";

const roadmapLink =
  "flex min-h-12 items-center justify-center rounded-xl bg-brand-700 px-6 text-base font-semibold text-white " +
  "hover:bg-brand-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";

/** Current password, new password twice. Fields are emptied after each answer (never echoed back). */
export function PasswordForm() {
  const [state, action] = useActionState(changeOwnPassword, IDLE_STATE);
  const errors = state.status === "error" ? state.fieldErrors : {};

  if (state.status === "success") {
    return (
      <div className="space-y-4">
        <FormMessage tone="success">{state.message}</FormMessage>
        <Link href="/chauffeur" className={roadmapLink}>
          Voir ma feuille de route
        </Link>
      </div>
    );
  }

  return (
    <form key={state.submissionId} action={action} className="space-y-4">
      {state.message && Object.keys(errors).length === 0 ? <FormMessage>{state.message}</FormMessage> : null}
      <Field label="Mot de passe actuel" htmlFor="password-current" error={errors.current}>
        <Input
          id="password-current"
          name="current"
          type="password"
          autoComplete="current-password"
          required
          className={fieldClass}
          aria-invalid={Boolean(errors.current)}
        />
      </Field>
      <Field
        label="Nouveau mot de passe"
        htmlFor="password-next"
        error={errors.next}
        hint={`${MIN_PASSWORD_LENGTH} caractères minimum. Ne le communiquez à personne, pas même à la régulation.`}
      >
        <Input
          id="password-next"
          name="next"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          maxLength={MAX_PASSWORD_LENGTH}
          className={fieldClass}
          aria-invalid={Boolean(errors.next)}
        />
      </Field>
      <Field label="Confirmation du nouveau mot de passe" htmlFor="password-confirm" error={errors.confirm}>
        <Input
          id="password-confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
          maxLength={MAX_PASSWORD_LENGTH}
          className={fieldClass}
          aria-invalid={Boolean(errors.confirm)}
        />
      </Field>
      <SubmitButton className="min-h-12 w-full text-base" pendingLabel="Enregistrement…">
        Enregistrer mon mot de passe
      </SubmitButton>
    </form>
  );
}
