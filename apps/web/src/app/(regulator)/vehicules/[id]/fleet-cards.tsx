"use client";

import { useActionState } from "react";
import { Checkbox, Field, FormMessage, Input, Select, UnitInput } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { IDLE_STATE, refusalKey, SAVING_LABEL, valueOf, type FormState, type FormValues } from "@/lib/forms";
import { MAINTENANCE_KIND_LABELS, VEHICLE_UNAVAILABILITY_LABELS } from "@/lib/labels";
import { MAINTENANCE_KINDS, UNAVAILABILITY_KINDS } from "../fleet-schema";
import { ErrorFocus } from "@/components/ui/error-focus";

type Action = (state: FormState, formData: FormData) => Promise<FormState>;

function Result({ state }: { state: FormState }) {
  if (!state.message) return null;
  return <FormMessage tone={state.status === "error" ? "error" : "success"}>{state.message}</FormMessage>;
}

/** Echoed values after an error, nothing otherwise (the form starts from its defaults again). */
function echoed(state: FormState): FormValues {
  return state.status === "error" ? (state.values ?? {}) : {};
}

/** Out of service from … to … (included): maintenance, repair, inspection, on-call duty, other. */
export function UnavailabilityForm({ action, defaultDate }: { action: Action; defaultDate: string }) {
  const [state, formAction] = useActionState(action, IDLE_STATE);
  const values = echoed(state);
  const errors = state.fieldErrors;
  return (
    <form key={state.submissionId} action={formAction} className="space-y-3">
      <ErrorFocus refusal={refusalKey(state)} />
      <Result state={state} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Motif" htmlFor="out-kind" error={errors.kind}>
          <Select id="out-kind" name="kind" defaultValue={valueOf(values, "kind") || "MAINTENANCE"}>
            {UNAVAILABILITY_KINDS.map((k) => (
              <option key={k} value={k}>
                {VEHICLE_UNAVAILABILITY_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Du" htmlFor="out-start" error={errors.startDate}>
          <Input id="out-start" name="startDate" type="date" required defaultValue={valueOf(values, "startDate") || defaultDate} />
        </Field>
        <Field label="Au (inclus)" htmlFor="out-end" error={errors.endDate}>
          <Input id="out-end" name="endDate" type="date" required defaultValue={valueOf(values, "endDate") || defaultDate} />
        </Field>
      </div>
      <Field label="Note (facultatif)" htmlFor="out-note" hint="Garage, rendez-vous…" error={errors.note}>
        <Input id="out-note" name="note" maxLength={200} defaultValue={valueOf(values, "note")} />
      </Field>
      <div className="flex justify-end">
        <SubmitButton pendingLabel={SAVING_LABEL}>Ajouter l&apos;indisponibilité</SubmitButton>
      </div>
    </form>
  );
}

/** Next inspection, service, tyres, insurance…: due at a date, a mileage, or both. */
export function DeadlineForm({ action }: { action: Action }) {
  const [state, formAction] = useActionState(action, IDLE_STATE);
  const values = echoed(state);
  const errors = state.fieldErrors;
  return (
    <form key={state.submissionId} action={formAction} className="space-y-3">
      <ErrorFocus refusal={refusalKey(state)} />
      <Result state={state} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Type" htmlFor="due-kind" error={errors.kind}>
          <Select id="due-kind" name="kind" defaultValue={valueOf(values, "kind") || "INSPECTION"}>
            {MAINTENANCE_KINDS.map((k) => (
              <option key={k} value={k}>
                {MAINTENANCE_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Précision (facultatif)" htmlFor="due-label" hint="Ex. «&#x202F;Vidange + filtres&#x202F;»." error={errors.label}>
          <Input id="due-label" name="label" maxLength={60} defaultValue={valueOf(values, "label")} />
        </Field>
        <Field label="Échéance (date)" htmlFor="due-date" error={errors.dueDate}>
          <Input id="due-date" name="dueDate" type="date" defaultValue={valueOf(values, "dueDate")} />
        </Field>
        <Field label="Échéance (km au compteur)" htmlFor="due-km" error={errors.dueKm}>
          <UnitInput id="due-km" name="dueKm" inputMode="numeric" unit="km" defaultValue={valueOf(values, "dueKm")} />
        </Field>
      </div>
      <p className="text-xs text-slate-500">Date, kilométrage ou les deux&nbsp;: l&apos;alerte part au premier atteint.</p>
      <div className="flex justify-end">
        <SubmitButton pendingLabel={SAVING_LABEL} variant="secondary">
          Ajouter l&apos;échéance
        </SubmitButton>
      </div>
    </form>
  );
}

/** A fill-up or a charge: date, odometer, quantity, amount, full tank or not. */
export function FuelForm({ action, defaultDate, unit }: { action: Action; defaultDate: string; unit: string }) {
  const [state, formAction] = useActionState(action, IDLE_STATE);
  const values = echoed(state);
  const errors = state.fieldErrors;
  const full = state.status === "error" ? valueOf(values, "fullTank") === "on" : true;
  return (
    <form key={state.submissionId} action={formAction} className="space-y-3">
      <ErrorFocus refusal={refusalKey(state)} />
      <Result state={state} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Date" htmlFor="fuel-date" error={errors.date}>
          <Input id="fuel-date" name="date" type="date" required defaultValue={valueOf(values, "date") || defaultDate} />
        </Field>
        <Field label="Compteur (km)" htmlFor="fuel-km" error={errors.odometerKm}>
          <UnitInput id="fuel-km" name="odometerKm" inputMode="numeric" required unit="km" defaultValue={valueOf(values, "odometerKm")} />
        </Field>
        <Field label={`Quantité (${unit})`} htmlFor="fuel-qty" error={errors.quantity}>
          <UnitInput id="fuel-qty" name="quantity" inputMode="decimal" required unit={unit} defaultValue={valueOf(values, "quantity")} />
        </Field>
        <Field label="Montant (€)" htmlFor="fuel-cost" error={errors.cost}>
          <UnitInput id="fuel-cost" name="cost" inputMode="decimal" required unit="€" defaultValue={valueOf(values, "cost")} />
        </Field>
      </div>
      <Checkbox
        name="fullTank"
        defaultChecked={full}
        label={unit === "kWh" ? "Charge complète" : "Plein complet (sert au calcul de la consommation)"}
      />
      <div className="flex justify-end">
        <SubmitButton pendingLabel={SAVING_LABEL} variant="secondary">
          Ajouter le {unit === "kWh" ? "relevé de charge" : "plein"}
        </SubmitButton>
      </div>
    </form>
  );
}
