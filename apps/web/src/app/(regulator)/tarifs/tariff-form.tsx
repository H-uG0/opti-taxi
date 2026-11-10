"use client";

import { useActionState, useState, type FormEvent, type ReactNode } from "react";
import { Checkbox, Field, Fieldset, FormMessage, Input, Select, Textarea, UnitInput } from "@/components/ui/form";
import { DEFAULT_FARE_RULES, fareEuros, NO_TRIP_FLAGS, sameRide, type FareGrid } from "@/lib/domain/fare";
import { formatEuros, VEHICLE_TYPE_LABELS } from "@/lib/labels";
import { ALL_ZONES, DEPARTMENT_NAMES } from "../vehicules/_lib/departments";
import { IDLE_STATE, refusalKey, valueOf, type FieldErrors, type FormState, type FormValues } from "@/lib/forms";
import { CERTIFICATION_OPTIONS, previewFareGrid, VEHICLE_TYPES, VERIFICATION_LABELS, VERIFICATIONS } from "./schema";
import { FormFooter } from "@/components/ui/form-footer";
import { ErrorFocus } from "@/components/ui/error-focus";

type Action = (state: FormState, formData: FormData) => Promise<FormState>;

const PREVIEW_KM = 20;
/** A Tuesday that is no public holiday: the preview's « jour de semaine ». */
const PREVIEW_WEEKDAY = { date: "2026-11-10", holidays: new Set<string>() };

export function TariffForm({ action, initial, submitLabel }: { action: Action; initial: FormValues; submitLabel: string }) {
  const [state, formAction] = useActionState(action, IDLE_STATE);
  const values = state.values ?? initial;

  return (
    // Remount on every response so uncontrolled inputs show the echoed values.
    <form key={state.submissionId} action={formAction} className="space-y-6">
      <ErrorFocus refusal={refusalKey(state)} />
      {state.status === "error" && state.message ? <FormMessage>{state.message}</FormMessage> : null}
      {state.status === "success" && state.message ? <FormMessage tone="success">{state.message}</FormMessage> : null}
      <TariffFields values={values} errors={state.fieldErrors} />
      <FormFooter cancelHref="/tarifs" submitLabel={submitLabel} />
    </form>
  );
}

/** A number input with its unit, as every amount of the form. */
function Amount({
  name,
  label,
  unit,
  values,
  errors,
  hint,
  required = false,
}: {
  name: string;
  label: string;
  unit: string;
  values: FormValues;
  errors: FieldErrors;
  hint?: ReactNode;
  required?: boolean;
}) {
  return (
    <Field label={label} htmlFor={name} error={errors[name]} hint={hint}>
      <UnitInput
        id={name}
        name={name}
        required={required}
        inputMode="decimal"
        autoComplete="off"
        unit={unit}
        defaultValue={valueOf(values, name)}
        aria-invalid={Boolean(errors[name])}
      />
    </Field>
  );
}

function TimeInput({ name, label, values, errors }: { name: string; label: string; values: FormValues; errors: FieldErrors }) {
  return (
    <Field label={label} htmlFor={name} error={errors[name]}>
      <Input
        id={name}
        name={name}
        required
        inputMode="numeric"
        autoComplete="off"
        className="tabular"
        placeholder="HH:MM"
        defaultValue={valueOf(values, name)}
        aria-invalid={Boolean(errors[name])}
      />
    </Field>
  );
}

function Preview({ grid }: { grid: FareGrid | null }) {
  if (!grid) {
    return (
      <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600" aria-live="polite">
        <p className="font-medium text-slate-800">Aperçu pour {PREVIEW_KM} km</p>
        <p className="mt-1">Renseignez le forfait, le prix au km et les majorations.</p>
      </div>
    );
  }
  // The company's readings (Règles de facturation) do not change these rows: no empty leg, and every patient on
  // board for the whole ride, so both patient counts agree. The simulator of /tarifs applies them.
  const fare = (patients: number, pickupMin: number) =>
    fareEuros(grid, NO_TRIP_FLAGS, { tpmrEquipped: false }, sameRide(PREVIEW_KM, patients, pickupMin, 40), DEFAULT_FARE_RULES, PREVIEW_WEEKDAY);
  const shared = Array.from({ length: Math.max(0, Math.min(grid.maxSharedPatients, 4) - 1) }, (_, i) => i + 2);
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600" aria-live="polite">
      <p className="font-medium text-slate-800">Aperçu pour {PREVIEW_KM} km, un mardi</p>
      <dl className="tabular mt-1 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
        <dt>Seul, de jour</dt>
        <dd className="text-right font-medium text-slate-900">{formatEuros(fare(1, 600))}</dd>
        <dt>Seul, de nuit</dt>
        <dd className="text-right font-medium text-slate-900">{formatEuros(fare(1, 1290))}</dd>
        {shared.map((patients) => (
          <div key={patients} className="contents">
            <dt>
              Partagé à {patients}
              {patients === 4 && grid.maxSharedPatients > 4 ? " et plus" : ""}, par patient
            </dt>
            <dd className="text-right font-medium text-slate-900">{formatEuros(fare(patients, 600))}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function TariffFields({ values, errors }: { values: FormValues; errors: FieldErrors }) {
  const [preview, setPreview] = useState<FareGrid | null>(() => previewFareGrid((name) => valueOf(values, name)));

  function refreshPreview(event: FormEvent<HTMLDivElement>) {
    const form = event.currentTarget.closest("form");
    if (!form) return;
    const data = new FormData(form);
    setPreview(
      previewFareGrid((name) => {
        const value = data.get(name);
        return typeof value === "string" ? value : "";
      }),
    );
  }

  return (
    <div className="space-y-6" onChange={refreshPreview}>
      <Fieldset legend="Champ d'application">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Type de véhicule" htmlFor="vehicleType" error={errors.vehicleType}>
            <Select id="vehicleType" name="vehicleType" defaultValue={valueOf(values, "vehicleType")} aria-invalid={Boolean(errors.vehicleType)}>
              {VEHICLE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {VEHICLE_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Département"
            htmlFor="department"
            hint="Taxi : département de l'ADS. VSL non certifié : celui du siège. * pour toutes les zones."
            error={errors.department}
          >
            <Input
              id="department"
              name="department"
              required
              maxLength={3}
              list="tariff-department-options"
              autoComplete="off"
              className="uppercase"
              defaultValue={valueOf(values, "department")}
              aria-invalid={Boolean(errors.department)}
            />
            <datalist id="tariff-department-options">
              {Object.entries(DEPARTMENT_NAMES).map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
              <option value={ALL_ZONES}>Toutes zones</option>
            </datalist>
          </Field>
          <Field
            label="Certification de l'entreprise"
            htmlFor="certified"
            hint="Géolocalisation certifiée sur tous les véhicules et facturation SEFi (VSL et ambulance)."
            error={errors.certified}
          >
            <Select id="certified" name="certified" defaultValue={valueOf(values, "certified")} aria-invalid={Boolean(errors.certified)}>
              {CERTIFICATION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Zone VSL (facultatif)" htmlFor="zone" hint="A, B, C ou D : pour l'affichage." error={errors.zone}>
            <Input
              id="zone"
              name="zone"
              maxLength={1}
              autoComplete="off"
              className="uppercase"
              defaultValue={valueOf(values, "zone")}
              aria-invalid={Boolean(errors.zone)}
            />
          </Field>
          <Field
            label="Libellé (facultatif)"
            htmlFor="label"
            hint="Ex. « Taxi conventionné — Bouches-du-Rhône »."
            error={errors.label}
            className="sm:col-span-2 lg:col-span-4"
          >
            <Input id="label" name="label" maxLength={80} defaultValue={valueOf(values, "label")} aria-invalid={Boolean(errors.label)} />
          </Field>
        </div>
      </Fieldset>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="space-y-6">
          <Fieldset legend="Forfaits et kilomètres">
            <div className="grid gap-4 sm:grid-cols-3">
              <Amount name="baseFare" label="Forfait départemental" unit="€" values={values} errors={errors} required hint="Facturé une fois par patient et par trajet." />
              <Amount name="includedKm" label="Km inclus dans le forfait" unit="km" values={values} errors={errors} hint="Taxi : 4 ; VSL et ambulance : 3." />
              <Amount name="pricePerKm" label="Prix au kilomètre" unit="€/km" values={values} errors={errors} required />
              <Amount name="bigCityFare" label="Forfait « Grande ville » (facultatif)" unit="€" values={values} errors={errors} hint="Taxi : ajouté au forfait (zones Grande ville)." />
              <Amount
                name="aggloFare"
                label="Forfait agglomération (facultatif)"
                unit="€"
                values={values}
                errors={errors}
                hint="Ambulance : remplace le forfait dans l'agglomération du siège."
              />
              <Amount name="tpmrFare" label="Supplément TPMR (facultatif)" unit="€" values={values} errors={errors} hint="Patient dans son fauteuil, véhicule équipé." />
            </div>
          </Fieldset>

          <Fieldset legend="Trajet court">
            <Field
              label="Tranches (facultatif)"
              htmlFor="shortTripBands"
              hint="Une tranche par ligne (50 au plus), « km au plus : montant », ex. « 7 : 8,54 », jusqu'à 1 000 km et 1 000 €. Ajoutée au forfait selon les km facturés."
              error={errors.shortTripBands}
            >
              <Textarea
                id="shortTripBands"
                name="shortTripBands"
                rows={4}
                className="tabular"
                defaultValue={valueOf(values, "shortTripBands")}
                aria-invalid={Boolean(errors.shortTripBands)}
              />
            </Field>
          </Fieldset>

          <Fieldset legend="Majorations">
            <p className="text-xs text-slate-500">
              Jamais cumulées : la plus forte s&apos;applique. Nuit : plus de la moitié du temps en charge dans la plage. Week-end : prise
              en charge le samedi à partir de l&apos;heure indiquée, le dimanche ou un jour férié.
            </p>
            <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
              <Amount name="nightRate" label="Nuit" unit="%" values={values} errors={errors} required />
              <TimeInput name="nightStart" label="Nuit à partir de" values={values} errors={errors} />
              <TimeInput name="nightEnd" label="Nuit jusqu'à" values={values} errors={errors} />
              <Amount name="weekendRate" label="Dimanche et férié" unit="%" values={values} errors={errors} required />
              <TimeInput name="saturdayFrom" label="Samedi à partir de" values={values} errors={errors} />
            </div>
            <Checkbox
              name="surchargeShortTrip"
              defaultChecked={valueOf(values, "surchargeShortTrip") === "on"}
              label="Majorer aussi le trajet court"
            />
          </Fieldset>

          <Fieldset legend="Retour à vide (taxi : dialyse, chimiothérapie, radiothérapie)">
            <p className="text-xs text-slate-500">
              Majoration du prix au km pour une course vers ou depuis un établissement de dialyse, de chimiothérapie ou de
              radiothérapie, dont l&apos;aller ou le retour du véhicule se fait à vide. Une entrée ou une sortie d&apos;hospitalisation
              n&apos;est pas reconnue : son motif reste dans votre logiciel de facturation. Laissez vide pour un VSL ou une ambulance.
            </p>
            <div className="grid gap-4 sm:grid-cols-3">
              <Amount name="emptyLegRateShort" label="Sous le seuil" unit="%" values={values} errors={errors} />
              <Amount name="emptyLegRateLong" label="À partir du seuil" unit="%" values={values} errors={errors} />
              <Amount name="emptyLegThresholdKm" label="Seuil" unit="km" values={values} errors={errors} />
            </div>
          </Fieldset>

          <Fieldset legend="Transport partagé">
            <p className="text-xs text-slate-500">
              Abattement de la facture de chaque patient selon le nombre de patients (23 pour 23 %) ; le dernier taux saisi vaut aussi
              au-delà. Péages et TPMR n&apos;y sont pas soumis.
            </p>
            <div className="grid gap-4 sm:grid-cols-4">
              <Amount name="discount2" label="À 2 patients" unit="%" values={values} errors={errors} />
              <Amount name="discount3" label="À 3 patients" unit="%" values={values} errors={errors} />
              <Amount name="discount4" label="À 4 patients et plus" unit="%" values={values} errors={errors} />
              <Field label="Patients au plus" htmlFor="maxSharedPatients" error={errors.maxSharedPatients} hint="Taxi 8, VSL 3, ambulance 1.">
                <Input
                  id="maxSharedPatients"
                  name="maxSharedPatients"
                  required
                  inputMode="numeric"
                  autoComplete="off"
                  className="tabular"
                  defaultValue={valueOf(values, "maxSharedPatients")}
                  aria-invalid={Boolean(errors.maxSharedPatients)}
                />
              </Field>
              <Amount name="aloneDiscount" label="Patient seul à bord (facultatif)" unit="%" values={values} errors={errors} hint="Taxi : 5 % au lieu du taux de partage." />
              <Amount
                name="aloneThresholdKm"
                label="Seuil du patient seul à bord"
                unit="km"
                values={values}
                errors={errors}
                hint="Taux ci-contre à partir de cette distance. Seuil local, 30 km au minimum."
              />
              <Field
                label="Détours facturables (facultatif)"
                htmlFor="billableDetourKm"
                hint="Km par prise en charge ajoutée (7 au plus), ex. « 10 ; 10 » en VSL. Vide : distance directe seulement."
                error={errors.billableDetourKm}
                className="sm:col-span-2"
              >
                <Input
                  id="billableDetourKm"
                  name="billableDetourKm"
                  autoComplete="off"
                  className="tabular"
                  defaultValue={valueOf(values, "billableDetourKm")}
                  aria-invalid={Boolean(errors.billableDetourKm)}
                />
              </Field>
            </div>
          </Fieldset>
        </div>
        <div className="lg:sticky lg:top-[calc(1.5rem+var(--demo-banner-h))]">
          <Preview grid={preview} />
        </div>
      </div>

      <Fieldset legend="Source et validité">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field
            label="Vérification"
            htmlFor="verification"
            error={errors.verification}
            hint="« Officiel » une fois les montants vérifiés sur le texte publié."
          >
            <Select id="verification" name="verification" defaultValue={valueOf(values, "verification")} aria-invalid={Boolean(errors.verification)}>
              {VERIFICATIONS.map((v) => (
                <option key={v} value={v}>
                  {VERIFICATION_LABELS[v]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Source (facultatif)" htmlFor="sourceUrl" hint="Adresse du texte : Légifrance, ameli…" error={errors.sourceUrl} className="lg:col-span-3">
            <Input id="sourceUrl" name="sourceUrl" type="url" maxLength={500} defaultValue={valueOf(values, "sourceUrl")} aria-invalid={Boolean(errors.sourceUrl)} />
          </Field>
          <Field label="En vigueur à partir du" htmlFor="validFrom" error={errors.validFrom}>
            <Input
              id="validFrom"
              name="validFrom"
              type="date"
              required
              className="tabular"
              defaultValue={valueOf(values, "validFrom")}
              aria-invalid={Boolean(errors.validFrom)}
            />
          </Field>
          <Field label="Jusqu'au (facultatif)" htmlFor="validTo" error={errors.validTo} hint="Vide : jusqu'à la grille suivante.">
            <Input id="validTo" name="validTo" type="date" className="tabular" defaultValue={valueOf(values, "validTo")} aria-invalid={Boolean(errors.validTo)} />
          </Field>
          <Field label="Notes (facultatif)" htmlFor="notes" hint="Convention, avenant, date de publication, point à vérifier…" error={errors.notes} className="sm:col-span-2">
            <Textarea id="notes" name="notes" maxLength={500} rows={2} defaultValue={valueOf(values, "notes")} aria-invalid={Boolean(errors.notes)} />
          </Field>
        </div>
      </Fieldset>
    </div>
  );
}
