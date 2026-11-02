"use client";

import { useActionState, type FormEvent, type ReactNode } from "react";
import { SubmitButton } from "@/components/ui/submit-button";
import type { ButtonSize, ButtonVariant } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { INITIAL_ACTION_RESULT, type ActionResult } from "../_lib/form-state";

/**
 * A one-button form (deactivate, delete…) bound to a server action. Hidden
 * `fields` identify the record; the server action re-checks them. Shows the
 * message returned by the action next to the button: the refusal, or what
 * the change did (e.g. the trips cancelled by a deactivation).
 */
export function ActionButton({
  action,
  fields,
  children,
  pendingLabel,
  confirmMessage,
  variant = "secondary",
  size = "sm",
  className,
  align = "end",
}: {
  action: (prev: ActionResult, formData: FormData) => Promise<ActionResult>;
  fields: Record<string, string>;
  children: ReactNode;
  pendingLabel?: string;
  confirmMessage?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  align?: "start" | "end";
}) {
  const [state, formAction] = useActionState(action, INITIAL_ACTION_RESULT);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    if (confirmMessage && !window.confirm(confirmMessage)) event.preventDefault();
  }

  return (
    <form
      action={formAction}
      onSubmit={onSubmit}
      className={cn("flex flex-col gap-1", align === "end" ? "items-end" : "items-start", className)}
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <SubmitButton variant={variant} size={size} pendingLabel={pendingLabel ?? "Patientez…"}>
        {children}
      </SubmitButton>
      {state.message ? (
        <p
          role={state.ok ? "status" : "alert"}
          className={cn(
            "max-w-xs text-xs font-medium",
            state.ok ? "text-emerald-800" : "text-red-700",
            align === "end" && "text-right",
          )}
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
