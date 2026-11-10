"use client";

import { useActionState, useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button, type ButtonVariant } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { FormMessage } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { IDLE_STATE, PENDING_LABEL, type FormState } from "@/lib/forms";

/**
 * The one way to confirm a consequential action (désactiver, supprimer, annuler une course,
 * valider malgré des alertes…), never the browser's own dialog:
 * - the first button only asks; a panel says what will happen;
 * - its confirm button repeats the action (« Oui, annuler la course »), red for a destructive one;
 * - its other button says what is kept (« Garder la course », or « Retour »); Échap does the same;
 * - the focus goes to the confirm button, then back to the first button when the panel closes
 *   (kept, or done). Every pending label is « En cours… » (PENDING_LABEL), « Enregistrement… » for a save.
 */
export function useConfirmStep() {
  const [open, setOpen] = useState(false);
  // Set by `close`: the first button, mounted again, takes the focus (a callback ref runs at commit, never in render).
  const returnFocus = useRef(false);
  const triggerRef = useCallback((node: HTMLButtonElement | null) => {
    if (node && returnFocus.current) {
      returnFocus.current = false;
      node.focus();
    }
  }, []);
  const ask = useCallback(() => setOpen(true), []);
  const close = useCallback(() => {
    returnFocus.current = true;
    setOpen(false);
  }, []);
  return { open, triggerRef, ask, close };
}

/** What a component asking for confirmation receives from useConfirmStep. */
export type ConfirmStep = ReturnType<typeof useConfirmStep>;

export type ConfirmTone = "danger" | "primary";

/**
 * The question panel. `onConfirm` for an action run by script; without it the confirm button submits
 * the enclosing form (`name` / `value` posted with it).
 */
export function ConfirmPanel({
  question,
  confirmLabel,
  keepLabel = "Retour",
  onKeep,
  onConfirm,
  tone = "danger",
  pending = false,
  pendingLabel = PENDING_LABEL,
  disabled = false,
  className,
}: {
  question: ReactNode;
  confirmLabel: string;
  keepLabel?: string;
  onKeep: () => void;
  onConfirm?: () => void;
  tone?: ConfirmTone;
  pending?: boolean;
  pendingLabel?: string;
  disabled?: boolean;
  className?: string;
}) {
  const questionId = useId();
  const confirmButton = useRef<HTMLButtonElement>(null);
  // The focus goes to the confirm button as soon as it can take it (shown while an action still finishes: once enabled).
  useEffect(() => {
    if (!pending) confirmButton.current?.focus();
  }, [pending]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onKeep();
  };
  const confirmProps = { ref: confirmButton, variant: tone, size: "sm" as const, "aria-describedby": questionId };
  return (
    <div
      role="group"
      aria-labelledby={questionId}
      onKeyDown={onKeyDown}
      className={cn(
        "space-y-3 rounded-md border p-3",
        tone === "danger" ? "border-red-200 bg-red-50" : "border-slate-200 bg-slate-50",
        className,
      )}
    >
      <div id={questionId} className={cn("text-sm", tone === "danger" ? "text-red-950" : "text-slate-800")}>
        {question}
      </div>
      {/* As in a form footer: renouncing first, the action last. */}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={onKeep} disabled={pending}>
          {keepLabel}
        </Button>
        {onConfirm ? (
          <Button {...confirmProps} onClick={onConfirm} disabled={pending || disabled} aria-busy={pending}>
            {pending ? pendingLabel : confirmLabel}
          </Button>
        ) : (
          <SubmitButton {...confirmProps} pendingLabel={pendingLabel} disabled={disabled}>
            {confirmLabel}
          </SubmitButton>
        )}
      </div>
    </div>
  );
}

type Action = (state: FormState, formData: FormData) => Promise<FormState>;

/**
 * Two-step button bound to a server action (lib/forms FormState): the first click shows the
 * question, the second runs the action. The result message stays visible after the page refreshes.
 */
export function ConfirmAction({
  action,
  label,
  confirmLabel,
  keepLabel,
  question,
  tone = "danger",
  triggerVariant = "secondary",
  ariaLabel,
}: {
  action: Action;
  label: string;
  /** Repeats the action: « Oui, supprimer l'échéance ». */
  confirmLabel: string;
  /** What is kept: « Garder l'échéance » (default « Retour »). */
  keepLabel?: string;
  question: ReactNode;
  /** `danger`: red confirm button (destructive); `primary` for a reactivation or a record. */
  tone?: ConfirmTone;
  /** Look of the first button: `ghost` in a list row. */
  triggerVariant?: ButtonVariant;
  /** Accessible name of the first button when `label` alone does not say what it acts on (a row of a list). */
  ariaLabel?: string;
}) {
  const [state, formAction] = useActionState(action, IDLE_STATE);
  const { open, triggerRef, ask, close } = useConfirmStep();

  const result = state.message ? (
    <FormMessage tone={state.status === "error" ? "error" : "success"}>{state.message}</FormMessage>
  ) : null;

  if (!open) {
    return (
      <div className="space-y-3">
        <Button
          ref={triggerRef}
          variant={triggerVariant}
          size="sm"
          aria-label={ariaLabel}
          className={cn(tone === "danger" && triggerVariant !== "primary" && "text-red-700 hover:bg-red-50")}
          onClick={ask}
        >
          {label}
        </Button>
        {result}
      </div>
    );
  }

  return (
    <form
      // Closing the panel is committed together with the action result; the focus returns to the first button.
      action={(formData) => {
        close();
        formAction(formData);
      }}
    >
      <ConfirmPanel question={question} confirmLabel={confirmLabel} keepLabel={keepLabel} onKeep={close} tone={tone} />
    </form>
  );
}
