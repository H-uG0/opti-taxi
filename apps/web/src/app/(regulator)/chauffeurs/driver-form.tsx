"use client";

import { useActionState } from "react";
import { Checkbox, Field, Fieldset, FormMessage, Input, Select, UnitInput } from "@/components/ui/form";
import type { DepotOption } from "@/app/(regulator)/depots/options";
import { QUALIFICATION_LABELS } from "@/lib/labels";
import { WEEKDAY_LABELS } from "@/lib/time";
import { qualificationScope } from "../vehicules/_lib/crew";
import { IDLE_STATE, listOf, refusalKey, valueOf, type FormState, type FormValues } from "@/lib/forms";
import { ISO_WEEKDAYS, MAX_BREAK_MINUTES, QUALIFICATIONS } from "./schema";
import { FormFooter } from "@/components/ui/form-footer";
import { ErrorFocus } from "@/components/ui/error-focus";

type Action = (state: FormState, formData: FormData) => Promise<FormState>;

export function DriverForm({
  action,
  initial,
  depots,
  submitLabel,
  cancelHref,
}: {
  action: Action;
  initial: FormValues;
  depots: DepotOption[];
  submitLabel: string;
  cancelHref?: string;
}) {
  const [state, formAction] = useActionState(action, IDLE_STATE);
  const values = state.values ?? initial;
  const errors = state.fieldErrors;
  const qualifications = listOf(values, "qualifications");
  const workDays = listOf(values, "workDays");

  return (
    // Remount on every response so uncontrolled inputs show the echoed values.
    <form key={state.submissionId} action={formAction} className="space-y-6">
      <ErrorFocus refusal={refusalKey(state)} />
      {state.status === "error" && state.message ? <FormMessage>{state.message}</FormMessage> : null}
      {state.status === "success" && state.message ? <FormMessage tone="success">{state.message}</FormMessage> : null}

      <Fieldset legend="Identité">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Nom" htmlFor="lastName" error={errors.lastName}>
            <Input
              id="lastName"
              name="lastName"
              required
              maxLength={60}
              autoComplete="off"
              defaultValue={valueOf(values, "lastName")}
              aria-invalid={Boolean(errors.lastName)}
            />
          </Field>
          <Field label="Prénom" htmlFor="firstName" error={errors.firstName}>
            <Input
              id="firstName"
              name="firstName"
              required
              maxLength={60}
              autoComplete="off"
              defaultValue={valueOf(values, "firstName")}
              aria-invalid={Boolean(errors.firstName)}
            />
          </Field>
          <Field label="Téléphone (facultatif)" htmlFor="phone" error={errors.phone}>
            <Input
              id="phone"
              name="phone"
              type="tel"
              maxLength={20}
              autoComplete="off"
              className="tabular"
              defaultValue={valueOf(values, "phone")}
              aria-invalid={Boolean(errors.phone)}
            />
          </Field>
        </div>
      </Fieldset>

      <fieldset
        className="space-y-3 rounded-lg border border-slate-200 bg-white p-4"
        aria-describedby={errors.qualifications ? "qualifications-error" : undefined}
      >
        <legend className="px-1 text-sm font-semibold text-slate-900">Qualifications</legend>
        <p className="text-xs text-slate-500">
          Elles déterminent les véhicules que le chauffeur peut conduire ou dans lesquels il peut être équipier.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          {QUALIFICATIONS.map((q) => (
            <div key={q} className="rounded-md border border-slate-200 px-3 py-2">
              <Checkbox
                name="qualifications"
                value={q}
                defaultChecked={qualifications.includes(q)}
                label={<span className="font-medium">{QUALIFICATION_LABELS[q]}</span>}
              />
              <p className="mt-1 pl-6 text-xs text-slate-500">{qualificationScope(q)}</p>
            </div>
          ))}
        </div>
        {errors.qualifications ? (
          <p id="qualifications-error" className="text-xs font-medium text-red-600">
            {errors.qualifications}
          </p>
        ) : null}
      </fieldset>

      <Fieldset legend="Rattachement">
        <Field
          label="Dépôt de rattachement (facultatif)"
          htmlFor="depotId"
          error={errors.depotId}
          hint="Le dépôt où la personne prend son service. Il servira à composer les équipages du jour."
        >
          <Select
            id="depotId"
            name="depotId"
            className="sm:max-w-80"
            defaultValue={valueOf(values, "depotId")}
            aria-invalid={Boolean(errors.depotId)}
          >
            <option value="">— Aucun dépôt —</option>
            {depots.map((d) => (
              <option key={d.id} value={d.id}>
                {d.active ? d.name : `${d.name} (désactivé)`}
              </option>
            ))}
          </Select>
        </Field>
      </Fieldset>

      <Fieldset legend="Disponibilités">
        <fieldset aria-describedby={errors.workDays ? "workDays-error" : undefined}>
          <legend className="mb-2 text-sm font-medium text-slate-700">Jours travaillés</legend>
          <div className="flex flex-wrap gap-2">
            {ISO_WEEKDAYS.map((day) => (
              <Checkbox
                key={day}
                name="workDays"
                value={String(day)}
                defaultChecked={workDays.includes(String(day))}
                label={WEEKDAY_LABELS[day]}
                className="rounded-md border border-slate-200 px-3 py-2 has-checked:border-brand-300 has-checked:bg-brand-50"
              />
            ))}
          </div>
          {errors.workDays ? (
            <p id="workDays-error" className="mt-1 text-xs font-medium text-red-600">
              {errors.workDays}
            </p>
          ) : null}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Début de service" htmlFor="shiftStart" error={errors.shiftStart} hint="Départ du dépôt au plus tôt.">
            <Input
              id="shiftStart"
              name="shiftStart"
              type="time"
              required
              className="tabular"
              defaultValue={valueOf(values, "shiftStart")}
              aria-invalid={Boolean(errors.shiftStart)}
            />
          </Field>
          <Field label="Fin de service" htmlFor="shiftEnd" error={errors.shiftEnd} hint="Retour au dépôt au plus tard.">
            <Input
              id="shiftEnd"
              name="shiftEnd"
              type="time"
              required
              className="tabular"
              defaultValue={valueOf(values, "shiftEnd")}
              aria-invalid={Boolean(errors.shiftEnd)}
            />
          </Field>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium text-slate-700">Pause</p>
          <p className="text-xs text-slate-500">
            L&apos;optimiseur place la pause n&apos;importe où dans la fenêtre. Obligatoire au-delà de 6 h d&apos;horaire :
            au moins 20 min (Code du travail, art. L. 3121-16). Laissez les trois champs vides seulement pour un horaire
            de 6 h ou moins.
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Fenêtre : à partir de" htmlFor="breakWindowStart" error={errors.breakWindowStart}>
              <Input
                id="breakWindowStart"
                name="breakWindowStart"
                type="time"
                className="tabular"
                defaultValue={valueOf(values, "breakWindowStart")}
                aria-invalid={Boolean(errors.breakWindowStart)}
              />
            </Field>
            <Field label="Fenêtre : jusqu'à" htmlFor="breakWindowEnd" error={errors.breakWindowEnd}>
              <Input
                id="breakWindowEnd"
                name="breakWindowEnd"
                type="time"
                className="tabular"
                defaultValue={valueOf(values, "breakWindowEnd")}
                aria-invalid={Boolean(errors.breakWindowEnd)}
              />
            </Field>
            <Field label="Durée de la pause (min)" htmlFor="breakMinutes" error={errors.breakMinutes}>
              <UnitInput
                id="breakMinutes"
                name="breakMinutes"
                inputMode="numeric"
                autoComplete="off"
                maxLength={3}
                unit="min"
                placeholder={`1 à ${MAX_BREAK_MINUTES}`}
                defaultValue={valueOf(values, "breakMinutes")}
                aria-invalid={Boolean(errors.breakMinutes)}
              />
            </Field>
          </div>
        </div>
      </Fieldset>

      <Fieldset legend="Coût">
        <Field
          label="Coût d'une heure de tournée (€/h)"
          htmlFor="hourlyCost"
          error={errors.hourlyCost}
          hint="L'optimiseur multiplie ce coût par toute la durée de la tournée, du départ au retour au dépôt, pause comprise. Saisissez le coût chargé (salaire, charges, congés, heures supplémentaires) ramené à cette durée : par exemple 17,50 € pour un salarié qui coûte 18,60 € par heure travaillée et dont 94 % de la tournée est payée."
        >
          <UnitInput
            id="hourlyCost"
            name="hourlyCost"
            required
            inputMode="decimal"
            autoComplete="off"
            placeholder="18"
            unit="€/h"
            className="sm:max-w-48"
            defaultValue={valueOf(values, "hourlyCost")}
            aria-invalid={Boolean(errors.hourlyCost)}
          />
        </Field>
      </Fieldset>

      <FormFooter cancelHref={cancelHref} submitLabel={submitLabel} />
    </form>
  );
}
