"use client";

import { useActionState, useState, type ReactNode } from "react";
import { Button, type ButtonVariant } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { IDLE_STATE, type FormState } from "@/lib/forms";

type Action = (state: FormState, formData: FormData) => Promise<FormState>;

/**
 * Two-step button for consequential actions (désactiver, supprimer…): the first
 * click shows what will happen, the second runs the server action. The result
 * message stays visible after the page refreshes.
 */
export function ConfirmAction({
  action,
  label,
  confirmLabel,
  pendingLabel = "En cours…",
  question,
  variant = "danger",
  ariaLabel,
}: {
  action: Action;
  label: string;
  confirmLabel: string;
  pendingLabel?: string;
  question: ReactNode;
  variant?: ButtonVariant;
  /** Accessible name of the first button when `label` alone does not say what it acts on (a row of a list). */
  ariaLabel?: string;
}) {
  const [state, formAction] = useActionState(action, IDLE_STATE);
  const [confirming, setConfirming] = useState(false);

  const result = state.message ? (
    <FormMessage tone={state.status === "error" ? "error" : "success"}>{state.message}</FormMessage>
  ) : null;

  if (!confirming) {
    return (
      <div className="space-y-3">
        <Button variant={variant === "danger" ? "secondary" : variant} size="sm" aria-label={ariaLabel} onClick={() => setConfirming(true)}>
          {label}
        </Button>
        {result}
      </div>
    );
  }

  return (
    <form
      // Closing the panel is committed together with the action result.
      action={(formData) => {
        setConfirming(false);
        formAction(formData);
      }}
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3"
    >
      <div className="text-sm text-slate-700">{question}</div>
      <div className="flex flex-wrap gap-2">
        <SubmitButton variant={variant} size="sm" pendingLabel={pendingLabel} autoFocus>
          {confirmLabel}
        </SubmitButton>
        <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
          Annuler
        </Button>
      </div>
    </form>
  );
}
