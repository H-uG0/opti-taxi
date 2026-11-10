"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import type { Payer, PrescribedMode, SharingScope, TripDirection } from "@prisma/client";
import { VehicleTypeBadge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { Field, Fieldset, FormMessage, Input, Select, Textarea } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { allowedVehicleTypesFor, sharingAllowedFor } from "@/lib/domain/rules";
import { formatShortDate } from "@/lib/time";
import { createTrip, type NewTripState } from "../actions";
import { prescriptionValidOn, timeFieldHint, timeFieldLabel } from "../trip-rules";
import { SAVING_LABEL } from "@/lib/forms";

export type PrescriptionOption = {
  id: string;
  mode: PrescribedMode;
  sharing: SharingScope;
  validFrom: string;
  validTo: string;
  label: string;
};

export type PatientOption = {
  id: string;
  label: string;
  mobilityLabel: string;
  prescriptions: PrescriptionOption[];
};

export type FacilityOption = { id: string; label: string };

type Props = {
  patients: PatientOption[];
  facilities: FacilityOption[];
  initialDate: string;
  today: string;
  geocoder: boolean;
};

export function NewTripForm(props: Props) {
  const initialState: NewTripState = {
    errors: {},
    message: null,
    values: { serviceDate: props.initialDate, payer: "CPAM", direction: "OUTBOUND" },
    attempt: 0,
  };
  const [state, action] = useActionState(createTrip, initialState);
  // A new key after each server answer remounts the fields with the submitted values.
  return <NewTripFields key={state.attempt} state={state} action={action} {...props} />;
}

function NewTripFields({
  state,
  action,
  patients,
  facilities,
  today,
  geocoder,
}: Props & { state: NewTripState; action: (formData: FormData) => void }) {
  const v = state.values;
  const errors = state.errors;
  const [patientId, setPatientId] = useState(v.patientId ?? "");
  const [payer, setPayer] = useState<Payer>(v.payer === "PRIVATE" ? "PRIVATE" : "CPAM");
  const [direction, setDirection] = useState<TripDirection>(v.direction === "RETURN" ? "RETURN" : "OUTBOUND");
  const [serviceDate, setServiceDate] = useState(v.serviceDate ?? "");
  const [prescriptionId, setPrescriptionId] = useState(v.prescriptionId ?? "");
  const [facilityId, setFacilityId] = useState(v.facilityId ?? "");

  const patient = patients.find((p) => p.id === patientId) ?? null;
  const validPrescriptions = patient?.prescriptions.filter((p) => prescriptionValidOn(p, serviceDate)) ?? [];
  // The chosen prescription while it stays valid on the date, otherwise the first valid one.
  const effectivePrescriptionId = validPrescriptions.some((p) => p.id === prescriptionId)
    ? prescriptionId
    : (validPrescriptions[0]?.id ?? "");
  const prescription = validPrescriptions.find((p) => p.id === effectivePrescriptionId) ?? null;
  const freeDestination = payer === "PRIVATE" && facilityId === "";

  const mode = payer === "CPAM" ? (prescription?.mode ?? null) : null;
  const vehicleTypes = allowedVehicleTypesFor(mode, payer);
  const shareable = sharingAllowedFor(payer === "CPAM" ? (prescription?.sharing ?? null) : null, direction, mode, payer);

  const invalid = (field: string) => (errors[field]?.length ? true : undefined);

  return (
    <form action={action} className="space-y-5" noValidate>
      <FormMessage>{state.message}</FormMessage>

      <Fieldset legend="Patient et prise en charge">
        <Field label="Patient" htmlFor="patientId" error={errors.patientId} hint={patient ? `Mobilité : ${patient.mobilityLabel}` : undefined}>
          <Select
            id="patientId"
            name="patientId"
            required
            value={patientId}
            onChange={(e) => setPatientId(e.target.value)}
            aria-invalid={invalid("patientId")}
          >
            <option value="">Choisissez un patient…</option>
            {patients.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <RadioGroup
            legend="Payeur"
            name="payer"
            value={payer}
            onChange={(value) => setPayer(value as Payer)}
            options={[
              { value: "CPAM", label: "CPAM (prescription)" },
              { value: "PRIVATE", label: "Client privé" },
            ]}
            error={errors.payer?.[0]}
          />
          <RadioGroup
            legend="Sens"
            name="direction"
            value={direction}
            onChange={(value) => setDirection(value as TripDirection)}
            options={[
              { value: "OUTBOUND", label: "Aller (domicile → soins)" },
              { value: "RETURN", label: "Retour (soins → domicile)" },
            ]}
            error={errors.direction?.[0]}
          />
        </div>

        {payer === "CPAM" ? (
          <Field
            label="Prescription médicale de transport"
            htmlFor="prescriptionId"
            error={errors.prescriptionId}
            hint={patient && validPrescriptions.length > 1 ? "Plusieurs prescriptions couvrent cette date." : undefined}
          >
            {patient && validPrescriptions.length === 0 ? (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                Aucune prescription valide le {serviceDate ? formatShortDate(serviceDate) : "jour choisi"} pour ce patient.
                Ajoutez-la depuis sa fiche (
                <Link href="/patients" className="font-medium underline underline-offset-2">
                  Patients
                </Link>
                ) ou facturez la course en client privé.
              </p>
            ) : (
              <Select
                id="prescriptionId"
                name="prescriptionId"
                required
                disabled={!patient}
                value={effectivePrescriptionId}
                onChange={(e) => setPrescriptionId(e.target.value)}
                aria-invalid={invalid("prescriptionId")}
              >
                {!patient ? <option value="">Choisissez d&apos;abord le patient</option> : null}
                {validPrescriptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
      </Fieldset>

      <Fieldset legend="Lieu de soins et horaire">
        <Field
          label={payer === "CPAM" ? "Établissement de soins" : "Établissement (facultatif)"}
          htmlFor="facilityId"
          error={errors.facilityId}
        >
          <Select
            id="facilityId"
            name="facilityId"
            required={payer === "CPAM"}
            value={facilityId}
            onChange={(e) => setFacilityId(e.target.value)}
            aria-invalid={invalid("facilityId")}
          >
            <option value="">{payer === "CPAM" ? "Choisissez un établissement…" : "Autre adresse (saisie libre)"}</option>
            {facilities.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </Select>
        </Field>

        {freeDestination ? (
          <div className="space-y-4 rounded-md border border-dashed border-slate-300 p-3">
            <Field
              label={direction === "OUTBOUND" ? "Adresse de destination" : "Adresse de prise en charge"}
              htmlFor="destinationAddress"
              error={errors.destinationAddress}
              hint="Numéro, rue, code postal et ville."
            >
              <Input
                id="destinationAddress"
                name="destinationAddress"
                required
                maxLength={200}
                autoComplete="off"
                placeholder="ex. 12 rue de Rome, 13001 Marseille"
                defaultValue={v.destinationAddress ?? ""}
                aria-invalid={invalid("destinationAddress")}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Latitude"
                htmlFor="destinationLat"
                error={errors.destinationLat}
                hint={geocoder ? "Laissez vide pour géocoder l'adresse." : "Obligatoire (géocodage non configuré)."}
              >
                <Input
                  id="destinationLat"
                  name="destinationLat"
                  inputMode="decimal"
                  placeholder="43.2965"
                  defaultValue={v.destinationLat ?? ""}
                  className="tabular"
                  aria-invalid={invalid("destinationLat")}
                />
              </Field>
              <Field label="Longitude" htmlFor="destinationLng" error={errors.destinationLng}>
                <Input
                  id="destinationLng"
                  name="destinationLng"
                  inputMode="decimal"
                  placeholder="5.3698"
                  defaultValue={v.destinationLng ?? ""}
                  className="tabular"
                  aria-invalid={invalid("destinationLng")}
                />
              </Field>
            </div>
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date" htmlFor="serviceDate" error={errors.serviceDate}>
            <Input
              id="serviceDate"
              name="serviceDate"
              type="date"
              required
              min={today}
              value={serviceDate}
              onChange={(e) => setServiceDate(e.target.value)}
              className="tabular"
              aria-invalid={invalid("serviceDate")}
            />
          </Field>
          <Field label={timeFieldLabel(direction)} htmlFor="time" error={errors.time} hint={timeFieldHint(direction)}>
            <Input
              id="time"
              name="time"
              type="time"
              required
              defaultValue={v.time ?? ""}
              className="tabular"
              aria-invalid={invalid("time")}
            />
          </Field>
        </div>

        <Field
          label="Notes (facultatif)"
          htmlFor="notes"
          error={errors.notes}
          hint="Visible du régulateur et sur la feuille de route du chauffeur. Aucune information médicale (diagnostic, traitement)."
        >
          <Textarea id="notes" name="notes" maxLength={500} rows={2} defaultValue={v.notes ?? ""} />
        </Field>
      </Fieldset>

      <section aria-label="Règles appliquées" className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm">
        <p className="flex flex-wrap items-center gap-1.5 text-slate-700">
          <span className="font-medium">Véhicules autorisés :</span>
          {payer === "CPAM" && !prescription ? (
            <span className="text-slate-500">selon la prescription</span>
          ) : (
            vehicleTypes.map((type) => <VehicleTypeBadge key={type} type={type} />)
          )}
        </p>
        <p className="mt-1 text-slate-700">
          <span className="font-medium">Transport partagé :</span>{" "}
          {payer === "PRIVATE"
            ? "non (client privé)"
            : !prescription
              ? "selon la prescription"
              : shareable
                ? "possible sur ce trajet (proposition à tracer sur la course)"
                : mode === "AMBULANCE"
                  ? "non (ambulance : un seul patient)"
                  : "non autorisé par la prescription sur ce trajet"}
        </p>
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton pendingLabel={SAVING_LABEL}>Créer la course</SubmitButton>
        <LinkButton href={`/courses?date=${serviceDate || today}`} variant="ghost">
          Annuler
        </LinkButton>
      </div>
    </form>
  );
}

function RadioGroup({
  legend,
  name,
  value,
  onChange,
  options,
  error,
}: {
  legend: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  error?: string;
}) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium text-slate-700">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <label
            key={option.value}
            className="flex cursor-pointer items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 has-checked:border-brand-500 has-checked:bg-brand-50 has-focus-visible:outline-2 has-focus-visible:outline-brand-600"
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="size-4 accent-brand-700"
            />
            {option.label}
          </label>
        ))}
      </div>
      {error ? <p className="text-xs font-medium text-red-600">{error}</p> : null}
    </fieldset>
  );
}
