import type { ReactNode } from "react";
import { LinkButton } from "./button";
import { SubmitButton } from "./submit-button";
import { SAVING_LABEL } from "@/lib/forms";

/**
 * Bottom row of every create or edit form, rendered inside the <form>: optional notes on the left,
 * then « Annuler » (back to where the user came from) and the submit button, on the right.
 * `pending`: the form is driven by useActionState's flag (a form submitted without React's reset).
 */
export function FormFooter({
  cancelHref,
  submitLabel,
  pendingLabel = SAVING_LABEL,
  pending,
  submitName,
  submitValue,
  children,
}: {
  cancelHref?: string;
  submitLabel: string;
  pendingLabel?: string;
  pending?: boolean;
  /** Posted with the submit button (« Créer quand même »). */
  submitName?: string;
  submitValue?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-3 border-t border-slate-200 pt-4">
      {children ? <div className="mr-auto text-sm">{children}</div> : null}
      {cancelHref ? (
        <LinkButton href={cancelHref} variant="secondary">
          Annuler
        </LinkButton>
      ) : null}
      <SubmitButton pendingLabel={pendingLabel} pending={pending} name={submitName} value={submitValue}>
        {submitLabel}
      </SubmitButton>
    </div>
  );
}
