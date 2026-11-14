"use client";

import { useActionState, useId } from "react";
import { Field, FormMessage, Input, Select } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { ErrorFocus } from "@/components/ui/error-focus";
import { PATIENT_ABSENCE_KIND_LABELS, PATIENT_ABSENCE_KINDS, PATIENT_ABSENCE_NOTE_MAX } from "@/lib/domain/patient-absences";
import { IDLE_STATE, refusalKey, SAVING_LABEL, valueOf, type FormState } from "@/lib/forms";

type Action = (state: FormState, formData: FormData) => Promise<FormState>;

export type AbsenceFormInitial = { kind: string; startDate: string; endDate: string; note: string };

/**
 * A patient's absence: reason, first and last day (included), note. Saving
 * says what happened to the trips (cancelled, brought back). The note is for
 * the record only (never on a trip): no medical detail.
 */
export function PatientAbsenceForm({
  action,
  initial,
  submitLabel,
}: {
  action: Action;
  initial: AbsenceFormInitial;
  submitLabel: string;
}) {
  const [state, formAction] = useActionState(action, IDLE_STATE);
  const values = state.status === "error" ? (state.values ?? {}) : {};
  const errors = state.fieldErrors;
  const ids = useId();
  const value = (key: keyof AbsenceFormInitial) => valueOf(values, key) || initial[key];
  return (
    <form key={state.submissionId} action={formAction} className="space-y-3">
      <ErrorFocus refusal={refusalKey(state)} />
      {state.message ? <FormMessage tone={state.status === "error" ? "error" : "success"}>{state.message}</FormMessage> : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Motif" htmlFor={`${ids}-kind`} error={errors.kind}>
          <Select id={`${ids}-kind`} name="kind" defaultValue={value("kind")} aria-invalid={Boolean(errors.kind)}>
            {PATIENT_ABSENCE_KINDS.map((k) => (
              <option key={k} value={k}>
                {PATIENT_ABSENCE_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Du" htmlFor={`${ids}-start`} error={errors.startDate}>
          <Input
            id={`${ids}-start`}
            name="startDate"
            type="date"
            required
            defaultValue={value("startDate")}
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
            defaultValue={value("endDate")}
            className="tabular"
            aria-invalid={Boolean(errors.endDate)}
          />
        </Field>
      </div>
      <Field
        label="Précision (facultatif)"
        htmlFor={`${ids}-note`}
        hint="Visible sur cette fiche seulement. Aucune information médicale (ni diagnostic ni service)."
        error={errors.note}
      >
        <Input id={`${ids}-note`} name="note" maxLength={PATIENT_ABSENCE_NOTE_MAX} defaultValue={value("note")} />
      </Field>
      <div className="flex justify-end">
        <SubmitButton pendingLabel={SAVING_LABEL}>{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}
