"use client";

import { useActionState, useState, type FormEvent } from "react";
import { Field, Fieldset, FormMessage, Input, Select, Textarea } from "@/components/ui/form";
import { formatEuros, VEHICLE_TYPE_LABELS } from "@/lib/labels";
import { ALL_ZONES, DEPARTMENT_NAMES } from "../vehicules/_lib/departments";
import { IDLE_STATE, parseDecimal, valueOf, type FieldErrors, type FormState, type FormValues } from "@/lib/forms";
import { FormFooter, UnitInput } from "../vehicules/_lib/ui";
import { patientFare, soloFare, type FareGrid } from "./fare";
import { percentToFraction, VEHICLE_TYPES } from "./schema";

type Action = (state: FormState, formData: FormData) => Promise<FormState>;

const PREVIEW_KM = 20;

export function TariffForm({ action, initial, submitLabel }: { action: Action; initial: FormValues; submitLabel: string }) {
  const [state, formAction] = useActionState(action, IDLE_STATE);
  const values = state.values ?? initial;

  return (
    // Remount on every response so uncontrolled inputs show the echoed values.
    <form key={state.submissionId} action={formAction} className="space-y-6">
      {state.status === "error" && state.message ? <FormMessage>{state.message}</FormMessage> : null}
      <TariffFields values={values} errors={state.fieldErrors} />
      <FormFooter cancelHref="/tarifs" submitLabel={submitLabel} />
    </form>
  );
}

/** Grid typed so far, or null while an amount is missing or invalid. */
function previewGrid(get: (name: string) => string): FareGrid | null {
  const baseFare = parseDecimal(get("baseFare"));
  const pricePerKm = parseDecimal(get("pricePerKm"));
  const includedKm = parseDecimal(get("includedKm")) ?? 0;
  const d2 = parseDecimal(get("sharedDiscount2")) ?? 0;
  const d3 = parseDecimal(get("sharedDiscount3")) ?? 0;
  const numbers = [baseFare, pricePerKm, includedKm, d2, d3];
  if (baseFare === undefined || pricePerKm === undefined || numbers.some((n) => n === undefined || !Number.isFinite(n))) {
    return null;
  }
  return {
    baseFare,
    pricePerKm,
    includedKm,
    sharedDiscount2: percentToFraction(d2),
    sharedDiscount3: percentToFraction(d3),
  };
}

function TariffFields({ values, errors }: { values: FormValues; errors: FieldErrors }) {
  const [preview, setPreview] = useState<FareGrid | null>(() => previewGrid((name) => valueOf(values, name)));

  function refreshPreview(event: FormEvent<HTMLDivElement>) {
    const form = event.currentTarget.closest("form");
    if (!form) return;
    const data = new FormData(form);
    setPreview(previewGrid((name) => {
      const value = data.get(name);
      return typeof value === "string" ? value : "";
    }));
  }

  return (
    <div className="space-y-6" onChange={refreshPreview}>
      <Fieldset legend="Champ d'application">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Type de véhicule" htmlFor="vehicleType" error={errors.vehicleType}>
            <Select
              id="vehicleType"
              name="vehicleType"
              defaultValue={valueOf(values, "vehicleType")}
              aria-invalid={Boolean(errors.vehicleType)}
            >
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
            hint="Numéro (13, 04, 05, 38…) ou * pour toutes les zones (repli)."
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
            label="Libellé (facultatif)"
            htmlFor="label"
            hint="Ex. « Convention taxis 2025 — Bouches-du-Rhône »."
            error={errors.label}
            className="sm:col-span-2"
          >
            <Input
              id="label"
              name="label"
              maxLength={80}
              defaultValue={valueOf(values, "label")}
              aria-invalid={Boolean(errors.label)}
            />
          </Field>
        </div>
      </Fieldset>

      <Fieldset legend="Montants">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Forfait de prise en charge (€)"
            htmlFor="baseFare"
            error={errors.baseFare}
            hint="Facturé une fois par patient transporté."
          >
            <UnitInput
              id="baseFare"
              name="baseFare"
              required
              inputMode="decimal"
              autoComplete="off"
              unit="€"
              defaultValue={valueOf(values, "baseFare")}
              aria-invalid={Boolean(errors.baseFare)}
            />
          </Field>
          <Field label="Prix au kilomètre (€/km)" htmlFor="pricePerKm" error={errors.pricePerKm}>
            <UnitInput
              id="pricePerKm"
              name="pricePerKm"
              required
              inputMode="decimal"
              autoComplete="off"
              unit="€/km"
              defaultValue={valueOf(values, "pricePerKm")}
              aria-invalid={Boolean(errors.pricePerKm)}
            />
          </Field>
          <Field
            label="Km inclus dans le forfait"
            htmlFor="includedKm"
            error={errors.includedKm}
            hint="0 si chaque kilomètre est facturé."
          >
            <UnitInput
              id="includedKm"
              name="includedKm"
              inputMode="decimal"
              autoComplete="off"
              unit="km"
              defaultValue={valueOf(values, "includedKm")}
              aria-invalid={Boolean(errors.includedKm)}
            />
          </Field>
        </div>
      </Fieldset>

      <Fieldset legend="Transport partagé">
        <p className="text-xs text-slate-500">
          Abattement appliqué au tarif de chaque patient quand plusieurs patients voyagent ensemble. Saisissez un
          pourcentage (23 pour 23 %).
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Abattement à 2 patients (%)" htmlFor="sharedDiscount2" error={errors.sharedDiscount2}>
            <UnitInput
              id="sharedDiscount2"
              name="sharedDiscount2"
              required
              inputMode="decimal"
              autoComplete="off"
              unit="%"
              defaultValue={valueOf(values, "sharedDiscount2")}
              aria-invalid={Boolean(errors.sharedDiscount2)}
            />
          </Field>
          <Field label="Abattement à 3 patients ou plus (%)" htmlFor="sharedDiscount3" error={errors.sharedDiscount3}>
            <UnitInput
              id="sharedDiscount3"
              name="sharedDiscount3"
              required
              inputMode="decimal"
              autoComplete="off"
              unit="%"
              defaultValue={valueOf(values, "sharedDiscount3")}
              aria-invalid={Boolean(errors.sharedDiscount3)}
            />
          </Field>
          <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600" aria-live="polite">
            <p className="font-medium text-slate-800">Aperçu pour {PREVIEW_KM} km</p>
            {preview ? (
              <dl className="tabular mt-1 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
                <dt>Seul</dt>
                <dd className="text-right font-medium text-slate-900">{formatEuros(soloFare(preview, PREVIEW_KM))}</dd>
                <dt>Partagé à 2, par patient</dt>
                <dd className="text-right font-medium text-slate-900">{formatEuros(patientFare(preview, PREVIEW_KM, 2))}</dd>
                <dt>Partagé à 3, par patient</dt>
                <dd className="text-right font-medium text-slate-900">{formatEuros(patientFare(preview, PREVIEW_KM, 3))}</dd>
              </dl>
            ) : (
              <p className="mt-1">Renseignez le forfait et le prix au km.</p>
            )}
          </div>
        </div>
      </Fieldset>

      <Fieldset legend="Validité">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
          <Field
            label="Jusqu'au (facultatif)"
            htmlFor="validTo"
            error={errors.validTo}
            hint="Vide : jusqu'à la grille suivante."
          >
            <Input
              id="validTo"
              name="validTo"
              type="date"
              className="tabular"
              defaultValue={valueOf(values, "validTo")}
              aria-invalid={Boolean(errors.validTo)}
            />
          </Field>
          <Field
            label="Notes (facultatif)"
            htmlFor="notes"
            hint="Source : convention, avenant, date de publication…"
            error={errors.notes}
            className="sm:col-span-2"
          >
            <Textarea
              id="notes"
              name="notes"
              maxLength={500}
              rows={2}
              defaultValue={valueOf(values, "notes")}
              aria-invalid={Boolean(errors.notes)}
            />
          </Field>
        </div>
      </Fieldset>
    </div>
  );
}
