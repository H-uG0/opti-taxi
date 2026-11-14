"use client";

import { useActionState, useId } from "react";
import { Field, FormMessage, Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { ErrorFocus } from "@/components/ui/error-focus";
import { IDLE_STATE, refusalKey, SAVING_LABEL, valueOf, type FormState } from "@/lib/forms";

type Action = (state: FormState, formData: FormData) => Promise<FormState>;

/** Adds a dated closure (first and last day included, note); the answer says which trips it cancelled. */
export function ClosureForm({ action, defaultDate }: { action: Action; defaultDate: string }) {
  const [state, formAction] = useActionState(action, IDLE_STATE);
  const values = state.status === "error" ? (state.values ?? {}) : {};
  const errors = state.fieldErrors;
  const ids = useId();
  return (
    <form key={state.submissionId} action={formAction} className="space-y-3">
      <ErrorFocus refusal={refusalKey(state)} />
      {state.message ? <FormMessage tone={state.status === "error" ? "error" : "success"}>{state.message}</FormMessage> : null}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,12rem)_minmax(0,1fr)]">
        <Field label="Du" htmlFor={`${ids}-start`} error={errors.startDate}>
          <Input
            id={`${ids}-start`}
            name="startDate"
            type="date"
            required
            defaultValue={valueOf(values, "startDate") || defaultDate}
            className="tabular"
            aria-invalid={Boolean(errors.startDate)}
          />
        </Field>
        <Field label="Au (inclus)" htmlFor={`${ids}-end`} error={errors.endDate}>
          <Input
            id={`${ids}-end`}
            name="endDate"
            type="date"
            required
            defaultValue={valueOf(values, "endDate") || defaultDate}
            className="tabular"
            aria-invalid={Boolean(errors.endDate)}
          />
        </Field>
        <Field label="Note (facultatif)" htmlFor={`${ids}-note`} error={errors.note}>
          <Input id={`${ids}-note`} name="note" maxLength={200} defaultValue={valueOf(values, "note")} placeholder="Ex. congés annuels, travaux" />
        </Field>
      </div>
      <div className="flex justify-end">
        <SubmitButton pendingLabel={SAVING_LABEL}>Ajouter la fermeture</SubmitButton>
      </div>
    </form>
  );
}
