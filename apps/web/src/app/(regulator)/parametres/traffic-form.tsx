"use client";

import { useActionState } from "react";
import { Checkbox, Field, Fieldset, FormMessage, Input, UnitInput } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { Table, TBody, Td, Th, THead } from "@/components/ui/table";
import { MIN_OBSERVED_LEGS, type ObservedCalibration, type ObservedFactor } from "@/lib/domain/traffic-observed";
import { MATRIX_SOURCE_LABELS } from "@/lib/labels";
import { TRAFFIC_BAND_LABELS, TRAFFIC_BANDS, type TrafficBandKey } from "@/lib/domain/traffic";
import { formatDecimalInput, IDLE_STATE, PENDING_LABEL, refusalKey, valueOf, type FieldErrors, type FormState, type FormValues } from "@/lib/forms";
import { factorField, radiusField, trafficFormView } from "./traffic-schema";
import { FormFooter } from "@/components/ui/form-footer";
import { ErrorFocus } from "@/components/ui/error-focus";

type Action = (state: FormState, formData: FormData) => Promise<FormState>;

type ZoneRow = { id: string; name: string; hasRadius: boolean };

export function TrafficForm({
  action,
  applyObserved,
  initial,
  zones,
  observed,
  calibration,
}: {
  action: Action;
  applyObserved: Action;
  initial: FormValues;
  zones: ZoneRow[];
  observed: ObservedFactor[];
  /** Distance source the observed values are measured on, and the routes left out for another one. */
  calibration: Pick<ObservedCalibration, "source" | "otherSourceRoutes">;
}) {
  const [state, formAction] = useActionState(action, IDLE_STATE);
  const [applied, applyAction] = useActionState(applyObserved, IDLE_STATE);
  const { response, values, errors } = trafficFormView(state, applied, initial);
  const applicable = observed.filter((cell) => cell.factor !== null).length;

  return (
    <div className="space-y-4">
      {response.message ? <FormMessage tone={response.status === "error" ? "error" : "success"}>{response.message}</FormMessage> : null}
      {/* Remount on every response so inputs show the echoed (error) or saved (success) values. */}
      <form key={`${state.submissionId}-${applied.submissionId}`} action={formAction} className="space-y-6">
      <ErrorFocus refusal={refusalKey(state)} />
        <Fieldset legend="Trafic">
          <p className="text-sm text-slate-600">
            Les temps de trajet viennent d&apos;un calcul à circulation fluide. Ils sont ici ralentis selon l&apos;heure et l&apos;endroit :
            un facteur de 1,5 veut dire qu&apos;un trajet de 20 min dans la zone en prend 30. Hors de la zone, seul le morceau du trajet
            qui y passe est ralenti. Le week-end, le facteur « Journée » vaut pour toute la journée. Ces valeurs sont un point de
            départ : ajustez-les avec ce que les chauffeurs observent.
          </p>
          <Checkbox name="trafficEnabled" label="Prendre en compte le trafic dans les temps de trajet" defaultChecked={valueOf(values, "trafficEnabled") === "on"} />
          <div className="grid gap-4 sm:grid-cols-2">
            <TimeRange label="Pointe du matin" startName="morningPeakStart" endName="morningPeakEnd" values={values} errors={errors} />
            <TimeRange label="Pointe du soir" startName="eveningPeakStart" endName="eveningPeakEnd" values={values} errors={errors} />
          </div>
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <tr>
                  <Th>Zone</Th>
                  <Th>Rayon</Th>
                  {TRAFFIC_BANDS.map((band) => (
                    <Th key={band}>{TRAFFIC_BAND_LABELS[band]}</Th>
                  ))}
                </tr>
              </THead>
              <TBody>
                {zones.map((zone) => (
                  <tr key={zone.id}>
                    <Td className="align-top font-medium text-slate-900">{zone.name}</Td>
                    <Td className="align-top">
                      {zone.hasRadius ? (
                        <ZoneNumber name={radiusField(zone.id)} label={`Rayon de la zone ${zone.name}`} unit="km" values={values} errors={errors} />
                      ) : (
                        <span className="text-sm text-slate-500">le reste du réseau</span>
                      )}
                    </Td>
                    {TRAFFIC_BANDS.map((band) => (
                      <Td key={band} className="align-top">
                        <ZoneNumber
                          name={factorField(zone.id, band)}
                          label={`${TRAFFIC_BAND_LABELS[band]}, ${zone.name}`}
                          unit="×"
                          values={values}
                          errors={errors}
                        />
                        <ObservedHint cell={observed.find((candidate) => candidate.zoneId === zone.id && candidate.band === band)} band={band} />
                      </Td>
                    ))}
                  </tr>
                ))}
              </TBody>
            </Table>
          </div>
        </Fieldset>
        <FormFooter submitLabel="Enregistrer le trafic" />
      </form>
      <form action={applyAction} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
        <div className="min-w-0 max-w-2xl space-y-1">
          <p>
            {applicable > 0
              ? `Les trajets réels donnent une valeur pour ${applicable} ${applicable > 1 ? "cases" : "case"} du tableau. Vous pouvez les appliquer d'un clic : les autres ne changent pas.`
              : `Une valeur observée apparaît sous un facteur à partir de ${MIN_OBSERVED_LEGS} trajets réels mesurés depuis le dernier changement de ce réglage.`}
          </p>
          <CalibrationSource {...calibration} />
        </div>
        <SubmitButton variant="secondary" disabled={applicable === 0} pendingLabel={PENDING_LABEL}>
          Appliquer les valeurs observées
        </SubmitButton>
      </form>
    </div>
  );
}

function TimeRange({
  label,
  startName,
  endName,
  values,
  errors,
}: {
  label: string;
  startName: string;
  endName: string;
  values: FormValues;
  errors: FieldErrors;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <Field label={`${label} : début`} htmlFor={startName} error={errors[startName]}>
        <Input id={startName} name={startName} type="time" required defaultValue={valueOf(values, startName)} aria-invalid={Boolean(errors[startName])} />
      </Field>
      <Field label="fin" htmlFor={endName} error={errors[endName]}>
        <Input id={endName} name={endName} type="time" required defaultValue={valueOf(values, endName)} aria-invalid={Boolean(errors[endName])} />
      </Field>
    </div>
  );
}

function ZoneNumber({
  name,
  label,
  unit,
  values,
  errors,
}: {
  name: string;
  label: string;
  unit: string;
  values: FormValues;
  errors: FieldErrors;
}) {
  return (
    <>
      <UnitInput
        name={name}
        aria-label={label}
        required
        inputMode="decimal"
        autoComplete="off"
        unit={unit}
        className="w-24"
        defaultValue={valueOf(values, name)}
        aria-invalid={Boolean(errors[name])}
      />
      {errors[name] ? <p className="mt-1 max-w-32 text-xs text-red-700">{errors[name]}</p> : null}
    </>
  );
}

/** Which distances the measured times are compared with (only one source counts: lib/domain/traffic-observed.ts). */
function CalibrationSource({ source, otherSourceRoutes }: Pick<ObservedCalibration, "source" | "otherSourceRoutes">) {
  if (source === null) return <p className="text-xs text-slate-500">Aucun calcul de tournées encore : rien à mesurer.</p>;
  const label = MATRIX_SOURCE_LABELS[source] ?? source;
  return (
    <p className="text-xs text-slate-500" data-testid="calibration-source">
      Valeurs mesurées sur les tournées calculées avec la même source de distances que le dernier calcul : {label}.
      {otherSourceRoutes > 0 ? (
        <span className="text-amber-800">
          {" "}
          {otherSourceRoutes} {otherSourceRoutes > 1 ? "tournées calculées" : "tournée calculée"} avec une autre source ne{" "}
          {otherSourceRoutes > 1 ? "comptent" : "compte"} pas :{" "}
          {source === "osrm"
            ? "leurs écarts viendraient de l'estimation à vol d'oiseau, pas du trafic."
            : "leurs temps viennent d'une autre base de calcul, leurs écarts ne se comparent pas à ceux du dernier calcul."}
        </span>
      ) : null}
    </p>
  );
}

function ObservedHint({ cell, band }: { cell: ObservedFactor | undefined; band: TrafficBandKey }) {
  if (!cell || cell.legs === 0) return null;
  const legs = `${cell.legs} trajet${cell.legs > 1 ? "s" : ""}`;
  return (
    <p className="mt-1 text-xs text-slate-500" data-band={band}>
      {cell.factor !== null ? `observé : ${formatDecimalInput(cell.factor)} (${legs})` : `${legs} mesuré${cell.legs > 1 ? "s" : ""}`}
    </p>
  );
}
