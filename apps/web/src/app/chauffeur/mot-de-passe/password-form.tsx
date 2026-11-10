"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { ArrowLeft, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FormMessage, Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { IDLE_STATE, SAVING_LABEL } from "@/lib/forms";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@/app/(regulator)/chauffeurs/schema";
import { fieldsToClear } from "../_lib/password";
import { changeOwnPassword } from "./actions";

/** Large fields for a phone: 16 px text (no zoom on focus in iOS Safari), 48 px high. */
const fieldClass = "h-12 text-base";

const roadmapLink =
  "flex min-h-12 items-center justify-center rounded-xl bg-brand-700 px-6 text-base font-semibold text-white " +
  "hover:bg-brand-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";

type PasswordField = "current" | "next" | "confirm";

/**
 * The whole « mot de passe » page below the header: heading, explanation,
 * form, then the confirmation alone. `forced` (password still provisional) is
 * read once: after the change the page re-renders with the new session, no
 * longer provisional, and the driver keeps reading the words they started
 * with. The form posts the server action itself, so it also works before the
 * page is hydrated (slow network). Fields are controlled: a refusal empties
 * the fields in error only, the others keep what was typed on the phone.
 */
export function PasswordChange({ forced: forcedOnLoad }: { forced: boolean }) {
  const [forced] = useState(forcedOnLoad);
  const [state, action] = useActionState(changeOwnPassword, IDLE_STATE);
  const [values, setValues] = useState<Record<PasswordField, string>>({ current: "", next: "", confirm: "" });
  const [answered, setAnswered] = useState(state.submissionId);
  const [visible, setVisible] = useState(false);
  const errors = state.status === "error" ? state.fieldErrors : {};
  const done = state.status === "success";

  // A new answer: empty the fields it refused (state adjusted while rendering, no effect needed).
  if (state.submissionId !== answered) {
    setAnswered(state.submissionId);
    const cleared = fieldsToClear(errors);
    if (cleared.size > 0) {
      setValues((typed) => ({
        current: cleared.has("current") ? "" : typed.current,
        next: cleared.has("next") ? "" : typed.next,
        confirm: cleared.has("confirm") ? "" : typed.confirm,
      }));
    }
  }

  function input(field: PasswordField, autoComplete: string, extra: { minLength?: number } = {}) {
    return (
      <Input
        id={`password-${field}`}
        name={field}
        type={visible ? "text" : "password"}
        autoComplete={autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        required
        maxLength={MAX_PASSWORD_LENGTH}
        {...extra}
        className={fieldClass}
        value={values[field]}
        onChange={(e) => {
          const value = e.target.value;
          setValues((typed) => ({ ...typed, [field]: value }));
        }}
        aria-invalid={Boolean(errors[field])}
      />
    );
  }

  return (
    <div className="space-y-4">
      {forced || done ? null : (
        <Link
          href="/chauffeur"
          className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-brand-800 underline-offset-2 hover:underline"
        >
          <ArrowLeft aria-hidden className="size-4" />
          Feuille de route
        </Link>
      )}
      <h1 className="text-xl font-bold text-slate-950">
        {forced ? "Choisissez votre mot de passe" : "Changer mon mot de passe"}
      </h1>
      {done ? null : forced ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          Votre mot de passe est provisoire&nbsp;: la régulation vous l&apos;a donné. Choisissez le vôtre pour ouvrir
          votre feuille de route&#x202F;; la régulation ne le connaîtra pas.
        </p>
      ) : (
        <p className="text-sm text-slate-600">
          Après le changement, vos sessions ouvertes sur d&apos;autres appareils sont fermées.
        </p>
      )}
      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        {done ? (
          <div className="space-y-4">
            <FormMessage tone="success">{state.message}</FormMessage>
            <Link href="/chauffeur" className={roadmapLink}>
              Voir ma feuille de route
            </Link>
          </div>
        ) : (
          <form action={action} className="space-y-4">
            {state.message && Object.keys(errors).length === 0 ? <FormMessage>{state.message}</FormMessage> : null}
            <Field
              label={forced ? "Mot de passe provisoire (donné par la régulation)" : "Mot de passe actuel"}
              htmlFor="password-current"
              error={errors.current}
            >
              {input("current", "current-password")}
            </Field>
            <Field
              label="Nouveau mot de passe"
              htmlFor="password-next"
              error={errors.next}
              hint={`${MIN_PASSWORD_LENGTH} caractères minimum. Ne le communiquez à personne, pas même à la régulation.`}
            >
              {input("next", "new-password", { minLength: MIN_PASSWORD_LENGTH })}
            </Field>
            <Field label="Confirmation du nouveau mot de passe" htmlFor="password-confirm" error={errors.confirm}>
              {input("confirm", "new-password")}
            </Field>
            <Button
              variant="secondary"
              className="min-h-11 w-full text-base"
              onClick={() => setVisible((v) => !v)}
            >
              {visible ? <EyeOff aria-hidden className="size-5" /> : <Eye aria-hidden className="size-5" />}
              {visible ? "Masquer les mots de passe" : "Afficher les mots de passe"}
            </Button>
            <SubmitButton className="min-h-12 w-full text-base" pendingLabel={SAVING_LABEL}>
              Enregistrer mon mot de passe
            </SubmitButton>
          </form>
        )}
      </div>
    </div>
  );
}
