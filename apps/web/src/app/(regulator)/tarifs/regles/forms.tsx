"use client";

import { useActionState } from "react";
import type { EmptyLegRule, SharedPatientCount, SurchargeOrder } from "@prisma/client";
import { Field, FormMessage, Input, Select, Textarea } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { AREA_KIND_LABELS, AREA_RULE_LABELS } from "@/lib/domain/tariff-areas";
import { IDLE_STATE, valueOf, type FormState, type FormValues } from "@/lib/forms";
import { FormFooter } from "../../vehicules/_lib/ui";
import { EMPTY_LEG_LABELS, PATIENT_COUNT_LABELS, SURCHARGE_ORDER_LABELS } from "../billing-labels";
import { VERIFICATION_LABELS, VERIFICATIONS } from "../schema";

type Action = (state: FormState, formData: FormData) => Promise<FormState>;

function Result({ state }: { state: FormState }) {
  if (!state.message) return null;
  return <FormMessage tone={state.status === "error" ? "error" : "success"}>{state.message}</FormMessage>;
}

function Choice<K extends string>({
  name,
  label,
  options,
  values,
  error,
  hint,
}: {
  name: string;
  label: string;
  options: Record<K, string>;
  values: FormValues;
  error?: string;
  hint?: string;
}) {
  return (
    <Field label={label} htmlFor={name} error={error} hint={hint}>
      <Select id={name} name={name} defaultValue={valueOf(values, name)} aria-invalid={Boolean(error)}>
        {(Object.entries(options) as [K, string][]).map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** Head office and the readings of the conventions the PO has not settled. */
export function BillingSettingsForm({ action, initial }: { action: Action; initial: FormValues }) {
  const [state, formAction] = useActionState(action, IDLE_STATE);
  const values = state.values ?? initial;
  const errors = state.fieldErrors;
  return (
    <form key={state.submissionId} action={formAction} className="space-y-4">
      <Result state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Département du siège"
          htmlFor="hqDepartment"
          error={errors.hqDepartment}
          hint="Grille VSL d'une entreprise non certifiée (zone du siège)."
        >
          <Input id="hqDepartment" name="hqDepartment" maxLength={3} autoComplete="off" className="uppercase" defaultValue={valueOf(values, "hqDepartment")} />
        </Field>
        <Field label="Commune du siège" htmlFor="hqCity" error={errors.hqCity} hint="Forfait agglomération des ambulances.">
          <Input id="hqCity" name="hqCity" maxLength={80} autoComplete="off" defaultValue={valueOf(values, "hqCity")} />
        </Field>
      </div>
      <Choice<EmptyLegRule>
        name="emptyLegRule"
        label="Retour à vide d'un taxi (séance de dialyse, de chimiothérapie ou de radiothérapie)"
        options={EMPTY_LEG_LABELS}
        values={values}
        error={errors.emptyLegRule}
        hint="Compté pour les courses vers ou depuis un établissement de dialyse, de chimiothérapie ou de radiothérapie ; pas pour une entrée ou une sortie d'hospitalisation, dont le motif reste dans votre logiciel de facturation. À confirmer : faut-il le compter, et à partir de quand un retour est-il « à vide » ?"
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Choice<SurchargeOrder>
          name="surchargeOrder"
          label="Retour à vide et majoration de nuit ou de week-end"
          options={SURCHARGE_ORDER_LABELS}
          values={values}
          error={errors.surchargeOrder}
        />
        <Choice<SharedPatientCount>
          name="sharedPatientCount"
          label="Nombre de patients pour l'abattement de partage"
          options={PATIENT_COUNT_LABELS}
          values={values}
          error={errors.sharedPatientCount}
        />
      </div>
      <div className="flex justify-end">
        <SubmitButton>Enregistrer les règles</SubmitButton>
      </div>
    </form>
  );
}

/** A dated period (certification) or a day (public holiday) added from a table. */
export function AddRowForm({
  action,
  fields,
  submitLabel,
}: {
  action: Action;
  fields: { name: string; label: string; type?: "date" | "text"; required?: boolean; width?: string }[];
  submitLabel: string;
}) {
  const [state, formAction] = useActionState(action, IDLE_STATE);
  const values = state.status === "error" ? (state.values ?? {}) : {};
  return (
    <form key={state.submissionId} action={formAction} className="space-y-3">
      <Result state={state} />
      <div className="flex flex-wrap items-start gap-3">
        {fields.map((field) => (
          <Field key={field.name} label={field.label} htmlFor={`add-${field.name}`} error={state.fieldErrors[field.name]} className={field.width}>
            <Input
              id={`add-${field.name}`}
              name={field.name}
              type={field.type ?? "text"}
              required={field.required}
              className={field.type === "date" ? "tabular" : undefined}
              defaultValue={valueOf(values, field.name)}
            />
          </Field>
        ))}
        <SubmitButton variant="secondary" className="mt-6">
          {submitLabel}
        </SubmitButton>
      </div>
    </form>
  );
}

/** A one-click action of a table row (retirer un jour férié, ajouter les fériés légaux). */
export function RowAction({ action, label, pendingLabel }: { action: Action; label: string; pendingLabel?: string }) {
  const [state, formAction] = useActionState(action, IDLE_STATE);
  return (
    <form action={formAction} className="inline-flex flex-col items-end gap-1">
      <SubmitButton variant="ghost" size="sm" pendingLabel={pendingLabel ?? "…"}>
        {label}
      </SubmitButton>
      {state.status === "error" && state.message ? <span className="text-xs text-red-600">{state.message}</span> : null}
    </form>
  );
}

/** Create or edit a tariff area. */
export function AreaForm({ action, initial, submitLabel }: { action: Action; initial: FormValues; submitLabel: string }) {
  const [state, formAction] = useActionState(action, IDLE_STATE);
  const values = state.values ?? initial;
  const errors = state.fieldErrors;
  return (
    <form key={state.submissionId} action={formAction} className="space-y-6">
      {state.status === "error" && state.message ? <FormMessage>{state.message}</FormMessage> : null}
      <div className="grid gap-4 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Choice name="kind" label="Type de zone" options={AREA_KIND_LABELS} values={values} error={errors.kind} />
        <Field label="Nom" htmlFor="name" error={errors.name} className="lg:col-span-2">
          <Input id="name" name="name" required maxLength={80} defaultValue={valueOf(values, "name")} />
        </Field>
        <Field label="Département" htmlFor="department" error={errors.department} hint="Celui des communes, sauf mention « (30) ».">
          <Input id="department" name="department" required maxLength={3} className="uppercase" defaultValue={valueOf(values, "department")} />
        </Field>
        <Field
          label="Communes"
          htmlFor="communes"
          error={errors.communes}
          hint="Une par ligne. Une commune d'un autre département : « Les Angles (30) »."
          className="sm:col-span-2"
        >
          <Textarea id="communes" name="communes" rows={6} defaultValue={valueOf(values, "communes")} />
        </Field>
        <div className="space-y-4 sm:col-span-2">
          <Choice name="rule" label="Règle" options={AREA_RULE_LABELS} values={values} error={errors.rule} />
          <Field label="Commune centre (règle « vers la commune centre »)" htmlFor="hubCommune" error={errors.hubCommune}>
            <Input id="hubCommune" name="hubCommune" maxLength={80} defaultValue={valueOf(values, "hubCommune")} />
          </Field>
        </div>
        <Field label="Valable à partir du (facultatif)" htmlFor="validFrom" error={errors.validFrom}>
          <Input id="validFrom" name="validFrom" type="date" className="tabular" defaultValue={valueOf(values, "validFrom")} />
        </Field>
        <Field label="Jusqu'au (facultatif)" htmlFor="validTo" error={errors.validTo}>
          <Input id="validTo" name="validTo" type="date" className="tabular" defaultValue={valueOf(values, "validTo")} />
        </Field>
        <Choice name="verification" label="Vérification" options={Object.fromEntries(VERIFICATIONS.map((v) => [v, VERIFICATION_LABELS[v]]))} values={values} error={errors.verification} />
        <Field label="Source (facultatif)" htmlFor="sourceUrl" error={errors.sourceUrl}>
          <Input id="sourceUrl" name="sourceUrl" type="url" maxLength={500} defaultValue={valueOf(values, "sourceUrl")} />
        </Field>
        <Field label="Notes (facultatif)" htmlFor="notes" error={errors.notes} className="sm:col-span-2 lg:col-span-4">
          <Textarea id="notes" name="notes" rows={2} maxLength={500} defaultValue={valueOf(values, "notes")} />
        </Field>
      </div>
      <FormFooter cancelHref="/tarifs/regles" submitLabel={submitLabel} />
    </form>
  );
}
