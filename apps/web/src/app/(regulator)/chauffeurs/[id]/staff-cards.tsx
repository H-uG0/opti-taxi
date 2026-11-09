"use client";

import { useActionState } from "react";
import { Field, FormMessage, Input, Select } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { IDLE_STATE, valueOf, type FormState } from "@/lib/forms";
import { ABSENCE_KIND_LABELS } from "@/lib/labels";
import { ABSENCE_KINDS } from "../staff-schema";

type Action = (state: FormState, formData: FormData) => Promise<FormState>;

function Result({ state }: { state: FormState }) {
  if (!state.message) return null;
  return <FormMessage tone={state.status === "error" ? "error" : "success"}>{state.message}</FormMessage>;
}

/** Adds an absence or an on-call duty: reason, first and last day (included), note. */
export function AbsenceForm({ action, defaultDate }: { action: Action; defaultDate: string }) {
  const [state, formAction] = useActionState(action, IDLE_STATE);
  const values = state.status === "error" ? (state.values ?? {}) : {};
  const errors = state.fieldErrors;
  return (
    <form key={state.submissionId} action={formAction} className="space-y-3">
      <Result state={state} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Motif" htmlFor="absence-kind" error={errors.kind}>
          <Select id="absence-kind" name="kind" defaultValue={valueOf(values, "kind") || "LEAVE"} aria-invalid={Boolean(errors.kind)}>
            {ABSENCE_KINDS.map((k) => (
              <option key={k} value={k}>
                {ABSENCE_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Du" htmlFor="absence-start" error={errors.startDate}>
          <Input
            id="absence-start"
            name="startDate"
            type="date"
            required
            defaultValue={valueOf(values, "startDate") || defaultDate}
            aria-invalid={Boolean(errors.startDate)}
          />
        </Field>
        <Field label="Au (inclus)" htmlFor="absence-end" error={errors.endDate}>
          <Input
            id="absence-end"
            name="endDate"
            type="date"
            required
            defaultValue={valueOf(values, "endDate") || defaultDate}
            aria-invalid={Boolean(errors.endDate)}
          />
        </Field>
      </div>
      <Field
        label="Note"
        htmlFor="absence-note"
        hint="Facultatif. Aucune information médicale (ni diagnostic ni détail de l'arrêt)."
        error={errors.note}
      >
        <Input id="absence-note" name="note" maxLength={200} defaultValue={valueOf(values, "note")} />
      </Field>
      <div className="flex justify-end">
        <SubmitButton pendingLabel="Enregistrement…">Ajouter l&apos;absence</SubmitButton>
      </div>
    </form>
  );
}

/** Adds a person this one must not work with in a crew. */
export function IncompatibilityForm({ action, people }: { action: Action; people: { id: string; name: string }[] }) {
  const [state, formAction] = useActionState(action, IDLE_STATE);
  const values = state.status === "error" ? (state.values ?? {}) : {};
  const errors = state.fieldErrors;
  return (
    <form key={state.submissionId} action={formAction} className="space-y-3">
      <Result state={state} />
      <Field label="Ne pas faire travailler avec" htmlFor="pair-other" error={errors.otherId}>
        <Select id="pair-other" name="otherId" required defaultValue={valueOf(values, "otherId")} aria-invalid={Boolean(errors.otherId)}>
          <option value="">— Choisir une personne —</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label="Note"
        htmlFor="pair-note"
        hint="Facultatif, visible des régulateurs seulement. Aucune information médicale ni jugement sur la personne."
        error={errors.note}
      >
        <Input id="pair-note" name="note" maxLength={200} defaultValue={valueOf(values, "note")} />
      </Field>
      <div className="flex justify-end">
        <SubmitButton pendingLabel="Enregistrement…" variant="secondary">
          Ajouter la paire
        </SubmitButton>
      </div>
    </form>
  );
}
