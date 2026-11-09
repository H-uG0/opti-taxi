"use client";

import { useActionState, type FormEvent, type ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { INITIAL_ACTION_RESULT, type ActionResult } from "./trip-form";

/**
 * Form bound to a row server action: hidden fields, optional confirmation and
 * the action's one-line feedback under the controls.
 */
export function ActionForm({
  action,
  hidden,
  confirmMessage,
  className,
  children,
}: {
  action: (prev: ActionResult, formData: FormData) => Promise<ActionResult>;
  hidden?: Record<string, string>;
  confirmMessage?: string;
  className?: string;
  children: ReactNode;
}) {
  const [state, formAction] = useActionState(action, INITIAL_ACTION_RESULT);

  function confirmSubmit(event: FormEvent<HTMLFormElement>) {
    if (confirmMessage && !window.confirm(confirmMessage)) event.preventDefault();
  }

  return (
    <form action={formAction} onSubmit={confirmMessage ? confirmSubmit : undefined} className={cn("space-y-2", className)}>
      {hidden
        ? Object.entries(hidden).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)
        : null}
      {children}
      <ActionMessage result={state} />
    </form>
  );
}

/** The one-line feedback of a row action (a success as status, a refusal as alert). */
export function ActionMessage({ result }: { result: ActionResult }) {
  if (!result.message) return null;
  return (
    <p role={result.ok ? "status" : "alert"} className={cn("text-xs font-medium", result.ok ? "text-emerald-700" : "text-red-700")}>
      {result.message}
    </p>
  );
}
