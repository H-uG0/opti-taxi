"use client";

import { useActionState, useState, type ChangeEvent, type ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { Field, Fieldset, FormMessage, Input, UnitInput } from "@/components/ui/form";
import { formatMinute } from "@/lib/time";
import { IDLE_STATE, parseDecimal, refusalKey, valueOf, type FieldErrors, type FormState, type FormValues } from "@/lib/forms";
import { CONTRACT_MAX_TIME_LIMIT_SEC, TRIPS_PER_SOLVER_SECOND } from "@/lib/optimizer/build-request";
import { TRIP_HORIZON_DAYS } from "@/lib/trips/horizon";
import { DECREE_LIMITS, MAX_SOLVER_TIME_LIMIT_SEC } from "./schema";
import { FormFooter } from "@/components/ui/form-footer";
import { ErrorFocus } from "@/components/ui/error-focus";

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
      <ErrorFocus refusal={refusalKey(state)} />
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
  optional = false,
  placeholder,
  value,
  onChange,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
}: {
  name: string;
  unit: string;
  values: FormValues;
  errors: FieldErrors;
  integer?: boolean;
  /** Blank allowed (the field then falls back on another one). */
  optional?: boolean;
  placeholder?: string;
  value?: string;
  onChange?: (value: string) => void;
  /** Given by Field: the hint or the error of the field. */
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  const binding =
    value !== undefined
      ? { value, onChange: (event: ChangeEvent<HTMLInputElement>) => onChange?.(event.target.value) }
      : { defaultValue: valueOf(values, name) };
  return (
    <UnitInput
      id={name}
      name={name}
      required={!optional}
      placeholder={placeholder}
      inputMode={integer ? "numeric" : "decimal"}
      autoComplete="off"
      unit={unit}
      className="sm:max-w-44"
      aria-invalid={invalid ?? Boolean(errors[name])}
      aria-describedby={describedBy}
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
          Décret 2025-202 (art. R. 322-11-6)&nbsp;: en transport partagé, l&apos;attente du patient au lieu de soins ne
          dépasse pas {DECREE_LIMITS.maxTotalWaitMin}&nbsp;min au total, avant le rendez-vous et après la séance. Ce budget
          est découpé en deux marges dont la somme ne peut pas dépasser l&apos;attente maximale.
        </Explanation>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Marge avant le rendez-vous (min)"
            htmlFor="waitBeforeAppointmentMin"
            error={errors.waitBeforeAppointmentMin}
            hint="Aller&nbsp;: le patient arrive au plus tôt RDV − marge, au plus tard à l'heure du RDV."
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
            hint="Retour&nbsp;: prise en charge entre la fin de séance et fin de séance + marge."
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
            hint={`Aller + retour d'un même patient dans la journée, attente à bord du véhicule garé comprise. ${DECREE_LIMITS.maxTotalWaitMin}\u00a0min au plus (décret).`}
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
        <Explanation>
          L&apos;attente d&apos;un patient dans le véhicule arrêté devant son lieu de soins (le véhicule attend
          l&apos;heure d&apos;un autre patient) compte dans son attente au lieu de soins&nbsp;: l&apos;optimiseur ne la
          laisse pas dépasser la marge avant le rendez-vous (aller) ni la marge après la séance (retour).
        </Explanation>
        {waitsKnown && total !== null ? (
          <div
            className={cn(
              "rounded-md border px-3 py-2 text-xs",
              overBudget ? "border-amber-200 bg-amber-50 text-amber-900" : "border-slate-200 bg-slate-50 text-slate-700",
            )}
            aria-live="polite"
          >
            <p className="tabular font-medium">
              Marges cumulées&nbsp;: {total}&nbsp;min sur {maxMin}&nbsp;min autorisées
              {overBudget ? " — à réduire avant d'enregistrer." : "."}
            </p>
            <p className="tabular mt-0.5">
              Exemple&nbsp;: RDV à {formatMinute(EXAMPLE_APPOINTMENT)} → arrivée entre{" "}
              {formatMinute(EXAMPLE_APPOINTMENT - beforeMin)} et {formatMinute(EXAMPLE_APPOINTMENT)}. Fin de séance à{" "}
              {formatMinute(EXAMPLE_SESSION_END)} → reprise entre {formatMinute(EXAMPLE_SESSION_END)} et{" "}
              {formatMinute(EXAMPLE_SESSION_END + afterMin)}.
            </p>
          </div>
        ) : null}
      </Fieldset>

      <Fieldset legend="Détour en transport partagé">
        <Explanation>
          Décret 2025-202 (art. R. 322-11-5)&nbsp;: le détour imposé à un patient ne dépasse pas{" "}
          {DECREE_LIMITS.maxDetourKmPerExtraPatient}&nbsp;km par patient supplémentaire pris en charge, dans la limite de{" "}
          {DECREE_LIMITS.maxDetourKmTotal}&nbsp;km. Vous pouvez être plus strict que le décret, pas plus souple.
        </Explanation>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Détour par patient ajouté (km)"
            htmlFor="maxDetourKmPerExtraPatient"
            error={errors.maxDetourKmPerExtraPatient}
            hint={`${DECREE_LIMITS.maxDetourKmPerExtraPatient}\u00a0km au plus.`}
          >
            <NumberInput name="maxDetourKmPerExtraPatient" unit="km" values={values} errors={errors} />
          </Field>
          <Field
            label="Détour total maximal (km)"
            htmlFor="maxDetourKmTotal"
            error={errors.maxDetourKmTotal}
            hint={`${DECREE_LIMITS.maxDetourKmTotal}\u00a0km au plus, quel que soit le nombre de co-passagers.`}
          >
            <NumberInput name="maxDetourKmTotal" unit="km" values={values} errors={errors} />
          </Field>
          <Field
            label="Temps à bord en plus du trajet direct (min)"
            htmlFor="maxRideExtraMin"
            error={errors.maxRideExtraMin}
            hint="De la fin de la prise en charge au début de la dépose (attente à bord comprise), un patient ne reste pas à bord plus longtemps que le trajet direct + cette durée, détours et autres arrêts compris. 30&nbsp;min par défaut&nbsp;: règle de l'entreprise, pas un plafond du décret."
          >
            <NumberInput name="maxRideExtraMin" unit="min" integer values={values} errors={errors} />
          </Field>
        </div>
      </Fieldset>

      <Fieldset legend="Temps d'arrêt">
        <Explanation>
          Temps passé à chaque arrêt (aide à la montée, installation, accueil) ajouté aux temps de trajet. Une valeur
          trop faible produit des horaires intenables&#x202F;; trop forte, elle réduit le nombre de courses par tournée. Les
          courses assises partent en taxi ou en VSL&nbsp;: elles ont les mêmes temps d&apos;arrêt. Un établissement peut
          ajouter son propre temps (fiche de l&apos;établissement) à l&apos;arrêt chez lui.
        </Explanation>
        <div className="grid gap-4 sm:grid-cols-4">
          <Field
            label="Prise en charge, taxi et VSL (min)"
            htmlFor="pickupServiceMin"
            error={errors.pickupServiceMin}
            hint="Entre 0 et 60&nbsp;min."
          >
            <NumberInput name="pickupServiceMin" unit="min" integer values={values} errors={errors} />
          </Field>
          <Field
            label="Dépose, taxi et VSL (min)"
            htmlFor="dropoffServiceMin"
            error={errors.dropoffServiceMin}
            hint="Entre 0 et 60&nbsp;min."
          >
            <NumberInput name="dropoffServiceMin" unit="min" integer values={values} errors={errors} />
          </Field>
          <Field
            label="Prise en charge, ambulance (min)"
            htmlFor="ambulancePickupServiceMin"
            error={errors.ambulancePickupServiceMin}
            hint="Brancard, étages. Vide&nbsp;: comme le taxi et le VSL."
          >
            <NumberInput
              name="ambulancePickupServiceMin"
              unit="min"
              integer
              optional
              placeholder={valueOf(values, "pickupServiceMin")}
              values={values}
              errors={errors}
            />
          </Field>
          <Field
            label="Dépose, ambulance (min)"
            htmlFor="ambulanceDropoffServiceMin"
            error={errors.ambulanceDropoffServiceMin}
            hint="Vide&nbsp;: comme le taxi et le VSL."
          >
            <NumberInput
              name="ambulanceDropoffServiceMin"
              unit="min"
              integer
              optional
              placeholder={valueOf(values, "dropoffServiceMin")}
              values={values}
              errors={errors}
            />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-4">
          <Field
            label="En plus, patient en fauteuil (min)"
            htmlFor="wheelchairExtraServiceMin"
            error={errors.wheelchairExtraServiceMin}
            hint="Ajouté à la prise en charge et à la dépose. 0 par défaut."
          >
            <NumberInput name="wheelchairExtraServiceMin" unit="min" integer values={values} errors={errors} />
          </Field>
          <Field
            label="En plus, patient allongé (min)"
            htmlFor="lyingExtraServiceMin"
            error={errors.lyingExtraServiceMin}
            hint="Ajouté à la prise en charge et à la dépose. 0 par défaut."
          >
            <NumberInput name="lyingExtraServiceMin" unit="min" integer values={values} errors={errors} />
          </Field>
        </div>
      </Fieldset>

      <Fieldset legend="Optimiseur">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Pénalité par course non affectée (€)"
            htmlFor="unassignedPenalty"
            error={errors.unassignedPenalty}
            hint="Coût fictif ajouté pour chaque course laissée sans véhicule. Il doit dépasser largement la marge d'une course pour que l'optimiseur serve toutes les courses possibles plutôt que d'écarter les moins rentables. 10 000&nbsp;€ par défaut."
          >
            <NumberInput name="unassignedPenalty" unit="€" values={values} errors={errors} />
          </Field>
          <Field
            label="Temps de calcul de base (s)"
            htmlFor="solverTimeLimitSec"
            error={errors.solverTimeLimitSec}
            hint={`Entre 1 et ${MAX_SOLVER_TIME_LIMIT_SEC}\u00a0s. Relevé automatiquement à 1\u00a0s par tranche de ${TRIPS_PER_SOLVER_SECOND} courses pour les grosses journées (${CONTRACT_MAX_TIME_LIMIT_SEC}\u00a0s au plus). Plus long\u00a0: meilleures tournées possibles, mais attente plus longue après «\u202fOptimiser demain\u202f».`}
          >
            <NumberInput name="solverTimeLimitSec" unit="s" integer values={values} errors={errors} />
          </Field>
        </div>
      </Fieldset>

      <Fieldset legend="Remplacement du planning en place">
        <Explanation>
          Un nouveau calcul («&#x202F;Réoptimiser&#x202F;», «&#x202F;Déplacer vers…&#x202F;») remplace toutes les tournées du jour. Il n&apos;est
          enregistré d&apos;office que s&apos;il ne comporte pas plus de violations de contraintes que le planning en
          place, et dans les limites ci-dessous&#x202F;; sinon le planning affiche le comparatif et vous choisissez de remplacer
          ou de garder les tournées actuelles. Un déplacement qui laisserait d&apos;autres courses sans véhicule
          demande toujours confirmation, en nommant ces courses.
        </Explanation>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Courses servies en moins acceptées"
            htmlFor="replanMaxServedLoss"
            error={errors.replanMaxServedLoss}
            hint="0 par défaut&nbsp;: un calcul qui sert moins de courses que le planning en place demande toujours votre accord."
          >
            <NumberInput name="replanMaxServedLoss" unit="courses" integer values={values} errors={errors} />
          </Field>
          <Field
            label="Baisse de marge acceptée (% du CA en place)"
            htmlFor="replanMaxMarginLoss"
            error={errors.replanMaxMarginLoss}
            hint="10&nbsp;% par défaut&nbsp;: au-delà, la baisse de marge estimée par rapport au planning en place demande votre accord."
          >
            <NumberInput name="replanMaxMarginLoss" unit="%" values={values} errors={errors} />
          </Field>
        </div>
      </Fieldset>

      <Fieldset legend="Courses">
        <Explanation>
          Les courses des récurrences sont créées d&apos;office, jamais avant demain&nbsp;: à la création, la modification ou la
          réactivation d&apos;une récurrence, d&apos;une prescription ou d&apos;un patient, à l&apos;ouverture du planning ou
          des courses d&apos;une date, et avant chaque optimisation.
        </Explanation>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Horizon des courses régulières (jours)"
            htmlFor="tripHorizonDays"
            error={errors.tripHorizonDays}
            hint={`14 par défaut\u00a0: les courses sont créées de demain à J+14. Entre ${TRIP_HORIZON_DAYS.min} et ${TRIP_HORIZON_DAYS.max} jours.`}
          >
            <NumberInput name="tripHorizonDays" unit="jours" integer values={values} errors={errors} />
          </Field>
          <Field
            label="Annulation tardive (h avant la prise en charge)"
            htmlFor="lateCancellationHours"
            error={errors.lateCancellationHours}
            hint="2&nbsp;h par défaut&nbsp;: une course annulée moins de 2&nbsp;h avant sa prise en charge prévue est comptée comme annulation tardive sur la fiche du patient."
          >
            <NumberInput name="lateCancellationHours" unit="h" integer values={values} errors={errors} />
          </Field>
        </div>
      </Fieldset>

      <Fieldset legend="Équipages">
        <Explanation>
          Équipages proposés chaque jour (page Équipages) quand l&apos;équipage attitré d&apos;un véhicule est absent, ou
          pour un véhicule de réserve&nbsp;: un remplaçant qualifié du même dépôt d&apos;abord, puis du dépôt le plus proche,
          celui qui couvre l&apos;horaire du titulaire, et la personne la moins polyvalente (les ambulanciers DE restent
          pour les ambulances). Une ambulance part avec au moins un ambulancier DE, au volant ou auprès du patient (art.
          R. 6312-10 du code de la santé publique).
        </Explanation>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Distance maximale d'un remplaçant (km)"
            htmlFor="crewMaxReplacementKm"
            error={errors.crewMaxReplacementKm}
            hint="60&nbsp;km par défaut, à vol d'oiseau entre les dépôts&nbsp;: au-delà, personne d'un autre dépôt n'est proposé."
          >
            <NumberInput name="crewMaxReplacementKm" unit="km" values={values} errors={errors} />
          </Field>
          <Field
            label="Horaire commun d'un équipage d'ambulance (min)"
            htmlFor="crewMinPairOverlapMin"
            error={errors.crewMinPairOverlapMin}
            hint="240&nbsp;min (4&nbsp;h) par défaut&nbsp;: le chauffeur et l'équipier doivent avoir au moins ce temps de service en commun."
          >
            <NumberInput name="crewMinPairOverlapMin" unit="min" integer values={values} errors={errors} />
          </Field>
          <Field
            label="Réserve par dépôt (personnes)"
            htmlFor="crewReservePerDepot"
            error={errors.crewReservePerDepot}
            hint="0 par défaut&nbsp;: nombre de personnes de chaque dépôt laissées sans véhicule (imprévus du jour) avant d'équiper un véhicule de réserve."
          >
            <NumberInput name="crewReservePerDepot" unit="pers." integer values={values} errors={errors} />
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
