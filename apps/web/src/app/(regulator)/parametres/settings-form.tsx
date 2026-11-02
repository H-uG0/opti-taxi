"use client";

import { useActionState, useState, type ChangeEvent, type ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { Field, Fieldset, FormMessage, Input } from "@/components/ui/form";
import { formatMinute } from "@/lib/time";
import { IDLE_STATE, parseDecimal, valueOf, type FieldErrors, type FormState, type FormValues } from "@/lib/forms";
import { FormFooter, UnitInput } from "../vehicules/_lib/ui";
import { DECREE_LIMITS, MAX_SOLVER_TIME_LIMIT_SEC } from "./schema";

type Action = (state: FormState, formData: FormData) => Promise<FormState>;

/** Example appointment and end of session used to illustrate the wait windows. */
const EXAMPLE_APPOINTMENT = 8 * 60;
const EXAMPLE_SESSION_END = 11 * 60 + 30;

export function SettingsForm({ action, initial }: { action: Action; initial: FormValues }) {
  const [state, formAction] = useActionState(action, IDLE_STATE);
  const values = state.values ?? initial;

  return (
    // Remount on every response so inputs show the echoed (error) or saved (success) values.
    <form key={state.submissionId} action={formAction} className="space-y-6">
      {state.message ? (
        <FormMessage tone={state.status === "error" ? "error" : "success"}>{state.message}</FormMessage>
      ) : null}
      <SettingsFields values={values} errors={state.fieldErrors} />
      <FormFooter submitLabel="Enregistrer les paramètres" />
    </form>
  );
}

/** Number input bound to a settings field; controlled when `value` is given. */
function NumberInput({
  name,
  unit,
  values,
  errors,
  integer = false,
  value,
  onChange,
}: {
  name: string;
  unit: string;
  values: FormValues;
  errors: FieldErrors;
  integer?: boolean;
  value?: string;
  onChange?: (value: string) => void;
}) {
  const binding =
    value !== undefined
      ? { value, onChange: (event: ChangeEvent<HTMLInputElement>) => onChange?.(event.target.value) }
      : { defaultValue: valueOf(values, name) };
  return (
    <UnitInput
      id={name}
      name={name}
      required
      inputMode={integer ? "numeric" : "decimal"}
      autoComplete="off"
      unit={unit}
      className="sm:max-w-44"
      aria-invalid={Boolean(errors[name])}
      {...binding}
    />
  );
}

function Explanation({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-relaxed text-slate-500">{children}</p>;
}

function SettingsFields({ values, errors }: { values: FormValues; errors: FieldErrors }) {
  const [before, setBefore] = useState(valueOf(values, "waitBeforeAppointmentMin"));
  const [after, setAfter] = useState(valueOf(values, "waitAfterSessionMin"));
  const [maxWait, setMaxWait] = useState(valueOf(values, "maxTotalWaitMin"));

  const beforeMin = parseDecimal(before);
  const afterMin = parseDecimal(after);
  const maxMin = parseDecimal(maxWait);
  const waitsKnown =
    beforeMin !== undefined &&
    afterMin !== undefined &&
    maxMin !== undefined &&
    [beforeMin, afterMin, maxMin].every((n) => Number.isInteger(n) && n >= 0);
  const total = waitsKnown ? beforeMin + afterMin : null;
  const overBudget = waitsKnown && total !== null && total > maxMin;

  return (
    <>
      <Fieldset legend="Attente au lieu de soins">
        <Explanation>
          Décret 2025-202 (art. R. 322-11-6) : en transport partagé, l&apos;attente du patient au lieu de soins ne
          dépasse pas {DECREE_LIMITS.maxTotalWaitMin} min au total, avant le rendez-vous et après la séance. Ce budget
          est découpé en deux marges dont la somme ne peut pas dépasser l&apos;attente maximale.
        </Explanation>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Marge avant le rendez-vous (min)"
            htmlFor="waitBeforeAppointmentMin"
            error={errors.waitBeforeAppointmentMin}
            hint="Aller : le patient arrive au plus tôt RDV − marge, au plus tard à l'heure du RDV."
          >
            <NumberInput
              name="waitBeforeAppointmentMin"
              unit="min"
              integer
              values={values}
              errors={errors}
              value={before}
              onChange={setBefore}
            />
          </Field>
          <Field
            label="Marge après la séance (min)"
            htmlFor="waitAfterSessionMin"
            error={errors.waitAfterSessionMin}
            hint="Retour : prise en charge entre la fin de séance et fin de séance + marge."
          >
            <NumberInput
              name="waitAfterSessionMin"
              unit="min"
              integer
              values={values}
              errors={errors}
              value={after}
              onChange={setAfter}
            />
          </Field>
          <Field
            label="Attente maximale cumulée (min)"
            htmlFor="maxTotalWaitMin"
            error={errors.maxTotalWaitMin}
            hint={`Aller + retour d'un même patient dans la journée. ${DECREE_LIMITS.maxTotalWaitMin} min au plus (décret).`}
          >
            <NumberInput
              name="maxTotalWaitMin"
              unit="min"
              integer
              values={values}
              errors={errors}
              value={maxWait}
              onChange={setMaxWait}
            />
          </Field>
        </div>
        {waitsKnown && total !== null ? (
          <div
            className={cn(
              "rounded-md border px-3 py-2 text-xs",
              overBudget ? "border-amber-200 bg-amber-50 text-amber-900" : "border-slate-200 bg-slate-50 text-slate-700",
            )}
            aria-live="polite"
          >
            <p className="tabular font-medium">
              Marges cumulées : {total} min sur {maxMin} min autorisées
              {overBudget ? " — à réduire avant d'enregistrer." : "."}
            </p>
            <p className="tabular mt-0.5">
              Exemple : RDV à {formatMinute(EXAMPLE_APPOINTMENT)} → arrivée entre{" "}
              {formatMinute(EXAMPLE_APPOINTMENT - beforeMin)} et {formatMinute(EXAMPLE_APPOINTMENT)}. Fin de séance à{" "}
              {formatMinute(EXAMPLE_SESSION_END)} → reprise entre {formatMinute(EXAMPLE_SESSION_END)} et{" "}
              {formatMinute(EXAMPLE_SESSION_END + afterMin)}.
            </p>
          </div>
        ) : null}
      </Fieldset>

      <Fieldset legend="Détour en transport partagé">
        <Explanation>
          Décret 2025-202 (art. R. 322-11-5) : le détour imposé à un patient ne dépasse pas{" "}
          {DECREE_LIMITS.maxDetourKmPerExtraPatient} km par patient supplémentaire pris en charge, dans la limite de{" "}
          {DECREE_LIMITS.maxDetourKmTotal} km. Vous pouvez être plus strict que le décret, pas plus souple.
        </Explanation>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Détour par patient ajouté (km)"
            htmlFor="maxDetourKmPerExtraPatient"
            error={errors.maxDetourKmPerExtraPatient}
            hint={`${DECREE_LIMITS.maxDetourKmPerExtraPatient} km au plus.`}
          >
            <NumberInput name="maxDetourKmPerExtraPatient" unit="km" values={values} errors={errors} />
          </Field>
          <Field
            label="Détour total maximal (km)"
            htmlFor="maxDetourKmTotal"
            error={errors.maxDetourKmTotal}
            hint={`${DECREE_LIMITS.maxDetourKmTotal} km au plus, quel que soit le nombre de co-passagers.`}
          >
            <NumberInput name="maxDetourKmTotal" unit="km" values={values} errors={errors} />
          </Field>
        </div>
      </Fieldset>

      <Fieldset legend="Temps d'arrêt">
        <Explanation>
          Temps passé à chaque arrêt (aide à la montée, installation, accueil) ajouté aux temps de trajet. Une valeur
          trop faible produit des horaires intenables ; trop forte, elle réduit le nombre de courses par tournée.
        </Explanation>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Prise en charge (min)"
            htmlFor="pickupServiceMin"
            error={errors.pickupServiceMin}
            hint="Entre 0 et 60 min."
          >
            <NumberInput name="pickupServiceMin" unit="min" integer values={values} errors={errors} />
          </Field>
          <Field label="Dépose (min)" htmlFor="dropoffServiceMin" error={errors.dropoffServiceMin} hint="Entre 0 et 60 min.">
            <NumberInput name="dropoffServiceMin" unit="min" integer values={values} errors={errors} />
          </Field>
        </div>
      </Fieldset>

      <Fieldset legend="Optimiseur">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Pénalité par course non affectée (€)"
            htmlFor="unassignedPenalty"
            error={errors.unassignedPenalty}
            hint="Coût fictif ajouté pour chaque course laissée sans véhicule. Il doit dépasser largement la marge d'une course pour que l'optimiseur serve toutes les courses possibles plutôt que d'écarter les moins rentables. 10 000 € par défaut."
          >
            <NumberInput name="unassignedPenalty" unit="€" values={values} errors={errors} />
          </Field>
          <Field
            label="Temps de calcul maximal (s)"
            htmlFor="solverTimeLimitSec"
            error={errors.solverTimeLimitSec}
            hint={`Entre 1 et ${MAX_SOLVER_TIME_LIMIT_SEC} s. Plus long : meilleures tournées possibles, mais attente plus longue après « Optimiser demain ».`}
          >
            <NumberInput name="solverTimeLimitSec" unit="s" integer values={values} errors={errors} />
          </Field>
        </div>
      </Fieldset>

      <Fieldset legend="Régulation">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Téléphone de la régulation"
            htmlFor="regulatorPhone"
            error={errors.regulatorPhone}
            hint="Proposé en appel direct sur la feuille de route des chauffeurs (ex. 04 65 71 00 00). Laissez vide pour n'afficher aucun numéro."
          >
            <Input
              id="regulatorPhone"
              name="regulatorPhone"
              type="tel"
              inputMode="tel"
              maxLength={25}
              autoComplete="off"
              className="tabular sm:max-w-56"
              defaultValue={valueOf(values, "regulatorPhone")}
              aria-invalid={Boolean(errors.regulatorPhone)}
            />
          </Field>
        </div>
      </Fieldset>
    </>
  );
}
