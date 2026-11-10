"use client";

import { useActionState, type ReactNode } from "react";
import { Button, type ButtonSize, type ButtonVariant } from "./button";
import { cn } from "./cn";
import { ConfirmPanel, useConfirmStep, type ConfirmTone } from "./confirm-action";
import { SubmitButton } from "./submit-button";
import { INITIAL_ACTION_RESULT, PENDING_LABEL, type ActionResult } from "@/lib/forms";

export type ActionConfirm = {
  question: ReactNode;
  /** Repeats the action: « Oui, désactiver le patient ». */
  confirmLabel: string;
  /** What is kept: « Garder le patient actif » (default « Retour »). */
  keepLabel?: string;
  tone?: ConfirmTone;
};

/**
 * A one-button form (deactivate, delete, attach…) bound to a server action
 * returning an ActionResult. Hidden `fields` identify the record; the server
 * action re-checks them. With `confirm`, the button first asks (ConfirmPanel,
 * the app's one confirmation). Shows the message returned by the action next to
 * the button: the refusal, or what the change did (e.g. the trips cancelled).
 */
export function ActionButton({
  action,
  fields,
  children,
  confirm,
  pendingLabel = PENDING_LABEL,
  variant = "secondary",
  size = "sm",
  className,
  align = "end",
  ariaLabel,
}: {
  action: (prev: ActionResult, formData: FormData) => Promise<ActionResult>;
  fields: Record<string, string>;
  children: ReactNode;
  confirm?: ActionConfirm;
  pendingLabel?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  align?: "start" | "end";
  ariaLabel?: string;
}) {
  const [state, formAction] = useActionState(action, INITIAL_ACTION_RESULT);
  const { open, triggerRef, ask, close } = useConfirmStep();
  const destructive = confirm && (confirm.tone ?? "danger") === "danger";

  return (
    <form
      action={(formData) => {
        if (open) close();
        formAction(formData);
      }}
      className={cn("flex flex-col gap-1", align === "end" ? "items-end" : "items-start", className)}
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {confirm && open ? (
        <ConfirmPanel
          question={confirm.question}
          confirmLabel={confirm.confirmLabel}
          keepLabel={confirm.keepLabel}
          tone={confirm.tone}
          onKeep={close}
          pendingLabel={pendingLabel}
          className="max-w-md text-left"
        />
      ) : confirm ? (
        <Button
          ref={triggerRef}
          variant={variant}
          size={size}
          aria-label={ariaLabel}
          className={cn(destructive && variant !== "primary" && "text-red-700 hover:bg-red-50")}
          onClick={ask}
        >
          {children}
        </Button>
      ) : (
        <SubmitButton variant={variant} size={size} aria-label={ariaLabel} pendingLabel={pendingLabel}>
          {children}
        </SubmitButton>
      )}
      {state.message ? (
        <p
          role={state.ok ? "status" : "alert"}
          className={cn("max-w-xs text-xs font-medium", state.ok ? "text-emerald-800" : "text-red-700", align === "end" && "text-right")}
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
