"use client";

import { useState } from "react";
import { Eye, EyeOff, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FormMessage, Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { IDLE_STATE, type FormState } from "@/lib/forms";
import { generatePassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "../schema";

type Action = (state: FormState, formData: FormData) => Promise<FormState>;

/**
 * Create the driver's login, or change its e-mail / reset its password. A
 * password typed here is provisional: the driver replaces it with their own at
 * the next sign-in. Fields are controlled: a server error keeps what was
 * typed, a successful save clears the password fields.
 */
export function AccountForm({
  action,
  email: savedEmail,
  hasAccount,
  accountActive,
}: {
  action: Action;
  email: string;
  hasAccount: boolean;
  /** Whether the existing account can sign in (ignored without an account). */
  accountActive: boolean;
}) {
  const [state, setState] = useState<FormState>(IDLE_STATE);
  const [email, setEmail] = useState(savedEmail);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [visible, setVisible] = useState(false);
  const [generated, setGenerated] = useState(false);
  const errors = state.status === "error" ? state.fieldErrors : {};

  async function submit(formData: FormData) {
    const result = await action(state, formData);
    setState(result);
    if (result.status === "success") {
      setPassword("");
      setConfirm("");
      setVisible(false);
      setGenerated(false);
    }
  }

  function generate() {
    const next = generatePassword((array) => crypto.getRandomValues(array));
    setPassword(next);
    setConfirm(next);
    setVisible(true);
    setGenerated(true);
  }

  return (
    <form action={submit} className="space-y-3">
      {state.message ? (
        <FormMessage tone={state.status === "error" ? "error" : "success"}>{state.message}</FormMessage>
      ) : null}
      <Field
        label="Adresse e-mail (identifiant)"
        htmlFor="account-email"
        error={errors.email}
        hint="Le chauffeur se connecte avec cette adresse sur son téléphone."
      >
        <Input
          id="account-email"
          name="email"
          type="email"
          required
          maxLength={120}
          autoComplete="off"
          spellCheck={false}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={Boolean(errors.email)}
        />
      </Field>
      <Field
        label={hasAccount ? "Nouveau mot de passe provisoire" : "Mot de passe provisoire"}
        htmlFor="account-password"
        error={errors.password}
        hint={
          hasAccount
            ? `Laissez vide pour conserver le mot de passe actuel. ${MIN_PASSWORD_LENGTH} caractères minimum\u202f; ` +
              "le chauffeur le remplacera par le sien à sa prochaine connexion."
            : `${MIN_PASSWORD_LENGTH} caractères minimum. Le chauffeur le remplacera par le sien à sa première connexion.`
        }
      >
        <div className="flex gap-2">
          <Input
            id="account-password"
            name="password"
            type={visible ? "text" : "password"}
            required={!hasAccount}
            minLength={MIN_PASSWORD_LENGTH}
            maxLength={MAX_PASSWORD_LENGTH}
            autoComplete="new-password"
            spellCheck={false}
            className="font-mono"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setGenerated(false);
            }}
            aria-invalid={Boolean(errors.password)}
          />
          <Button
            variant="secondary"
            className="shrink-0 px-3"
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? "Masquer le mot de passe" : "Afficher le mot de passe"}
            aria-pressed={visible}
          >
            {visible ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
          </Button>
        </div>
      </Field>
      <Field label="Confirmation du mot de passe" htmlFor="account-password-confirm" error={errors.passwordConfirm}>
        <Input
          id="account-password-confirm"
          name="passwordConfirm"
          type={visible ? "text" : "password"}
          required={!hasAccount || password !== ""}
          maxLength={MAX_PASSWORD_LENGTH}
          autoComplete="new-password"
          spellCheck={false}
          className="font-mono"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          aria-invalid={Boolean(errors.passwordConfirm)}
        />
      </Field>
      {generated ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="status">
          Notez ce mot de passe provisoire pour le communiquer au chauffeur&nbsp;: il ne sera plus affiché après
          l&apos;enregistrement.
        </p>
      ) : null}
      {hasAccount ? (
        <p className="text-xs text-slate-500">
          {accountActive
            ? "Changer l'adresse ou le mot de passe déconnecte le chauffeur\u00a0: il se reconnecte avec ses nouveaux identifiants."
            : "L'accès est désactivé\u00a0: les identifiants modifiés serviront une fois l'accès réactivé."}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <SubmitButton size="sm">{hasAccount ? "Mettre à jour le compte" : "Créer le compte"}</SubmitButton>
        <Button variant="secondary" size="sm" onClick={generate}>
          <KeyRound aria-hidden className="size-4" />
          Générer un mot de passe provisoire
        </Button>
      </div>
    </form>
  );
}
