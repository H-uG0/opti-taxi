"use client";

import Link from "next/link";
import { useActionState, useCallback, useState, useTransition } from "react";
import type { Payer, PrescribedMode, SharingScope } from "@prisma/client";
import { VehicleTypeBadge } from "@/components/ui/badge";
import { ErrorFocus } from "@/components/ui/error-focus";
import { Field, fieldIds, Fieldset, FormMessage, Input, Select, Textarea } from "@/components/ui/form";
import { FormFooter } from "@/components/ui/form-footer";
import { SearchSelect } from "@/components/ui/search-select";
import { allowedVehicleTypesFor, sharingAllowedFor } from "@/lib/domain/rules";
import { formatMinute, formatShortDate, parseMinute } from "@/lib/time";
import { createTrip, type NewTripState } from "../actions";
import { PlaceFields, RadioGroup } from "../place-fields";
import type { NewTripDirection } from "../trip-form";
import { prescriptionValidOn, timeFieldHint, timeFieldLabel } from "../trip-rules";
import { IDLE_STATE, refusalKey, valueOf } from "@/lib/forms";
import { loadPatientForTrip, searchTripPatients } from "./actions";
import { newPrescriptionHref as prescriptionHref, type TripDraft } from "./trip-draft";
import { suggestedReturnMinute } from "./usual-facility";

export type PrescriptionOption = {
  id: string;
  mode: PrescribedMode;
  sharing: SharingScope;
  validFrom: string;
  validTo: string;
  label: string;
};

/** The patient chosen, as the form needs them (loaded on the server once chosen: never the whole list). */
export type PatientOption = {
  id: string;
  label: string;
  mobilityLabel: string;
  prescriptions: PrescriptionOption[];
  /** Facility of their regular care (or of their latest trip), proposed first. */
  usualFacilityId: string | null;
  /** Session length there, to suggest the end of session of « Aller et retour ». */
  usualSessionMinutes: number | null;
};

export type FacilityOption = { id: string; label: string };

type Props = {
  /** The patient of ?patient= (from their record), already loaded. */
  initialPatient: PatientOption | null;
  facilities: FacilityOption[];
  initialDate: string;
  today: string;
  geocoder: boolean;
  /** Choices carried back from « Nouvelle prescription » (trip-draft.ts). */
  draft?: TripDraft;
  /** Opened from the patient's record: « Annuler » leads back there (`cancelHref`). */
  fromRecord?: boolean;
  cancelHref?: string;
};

const DIRECTION_OPTIONS: { value: NewTripDirection; label: string }[] = [
  { value: "OUTBOUND", label: "Aller (domicile → soins)" },
  { value: "RETURN", label: "Retour (soins → domicile)" },
  { value: "BOTH", label: "Aller et retour" },
];

export function NewTripForm(props: Props) {
  const initialState: NewTripState = {
    ...IDLE_STATE,
    values: {
      serviceDate: props.initialDate,
      payer: "CPAM",
      direction: props.draft?.direction ?? "OUTBOUND",
      patientId: props.initialPatient?.id ?? "",
      facilityId: props.draft?.facilityId ?? props.initialPatient?.usualFacilityId ?? "",
      time: props.draft?.time ?? "",
      returnTime: props.draft?.returnTime ?? "",
    },
  };
  const [state, action] = useActionState(createTrip, initialState);
  // Held above the remounted fields: a refused save keeps the patient chosen and their prescriptions.
  const [patient, setPatient] = useState<PatientOption | null>(props.initialPatient);
  // A new key after each server answer remounts the fields with the submitted values.
  return <NewTripFields key={state.submissionId} state={state} action={action} patient={patient} onPatient={setPatient} {...props} />;
}

function NewTripFields({
  state,
  action,
  patient,
  onPatient,
  facilities,
  today,
  geocoder,
  fromRecord = false,
  cancelHref,
}: Props & {
  state: NewTripState;
  action: (formData: FormData) => void;
  patient: PatientOption | null;
  onPatient: (patient: PatientOption | null) => void;
}) {
  const v = (key: string) => valueOf(state.values ?? {}, key);
  const errors = state.fieldErrors;
  const [loading, startLoading] = useTransition();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [payer, setPayer] = useState<Payer>(v("payer") === "PRIVATE" ? "PRIVATE" : "CPAM");
  const [direction, setDirection] = useState<NewTripDirection>(
    v("direction") === "RETURN" ? "RETURN" : v("direction") === "BOTH" ? "BOTH" : "OUTBOUND",
  );
  const [serviceDate, setServiceDate] = useState(v("serviceDate"));
  const [prescriptionId, setPrescriptionId] = useState(v("prescriptionId"));
  const [facilityId, setFacilityId] = useState(v("facilityId"));
  const [time, setTime] = useState(v("time"));
  const [returnTime, setReturnTime] = useState(v("returnTime"));
  const [returnTouched, setReturnTouched] = useState(v("returnTime") !== "");

  const choosePatient = (id: string) => {
    setLoadError(null);
    startLoading(async () => {
      const loaded = await loadPatientForTrip(id).catch(() => null);
      if (!loaded) {
        setLoadError("Ce patient n'a pas pu être chargé (désactivé entre-temps ?) : cherchez-le à nouveau.");
        return;
      }
      const previousUsual = patient?.usualFacilityId ?? null;
      onPatient(loaded);
      setPrescriptionId("");
      // The usual facility is proposed; a facility chosen by hand stays (one proposed for the previous patient follows).
      setFacilityId((current) => (current === "" || current === previousUsual ? (loaded.usualFacilityId ?? "") : current));
    });
  };
  const search = useCallback((query: string) => searchTripPatients(query), []);

  const validPrescriptions = patient?.prescriptions.filter((p) => prescriptionValidOn(p, serviceDate)) ?? [];
  // The chosen prescription while it stays valid on the date, otherwise the first valid one.
  const effectivePrescriptionId = validPrescriptions.some((p) => p.id === prescriptionId)
    ? prescriptionId
    : (validPrescriptions[0]?.id ?? "");
  const prescription = validPrescriptions.find((p) => p.id === effectivePrescriptionId) ?? null;
  const freeDestination = payer === "PRIVATE" && facilityId === "";

  const mode = payer === "CPAM" ? (prescription?.mode ?? null) : null;
  const vehicleTypes = allowedVehicleTypesFor(mode, payer);
  const legs = direction === "BOTH" ? (["OUTBOUND", "RETURN"] as const) : ([direction] as const);
  const shareableLegs = legs.filter((leg) => sharingAllowedFor(payer === "CPAM" ? (prescription?.sharing ?? null) : null, leg, mode, payer));
  const usual = patient?.usualFacilityId ? facilities.find((f) => f.id === patient.usualFacilityId) : undefined;
  const sessionMinutes = facilityId !== "" && facilityId === patient?.usualFacilityId ? patient.usualSessionMinutes : null;

  const changeTime = (next: string) => {
    setTime(next);
    // « Aller et retour »: the end of session follows the appointment (usual session length) until typed by hand.
    if (!returnTouched) {
      const suggested = suggestedReturnMinute(parseMinute(next), sessionMinutes);
      setReturnTime(suggested !== null ? formatMinute(suggested) : "");
    }
  };

  const invalid = (field: string) => (errors[field] ? true : undefined);
  // Back from the new prescription with what was already chosen (never the notes).
  const newPrescriptionHref = patient
    ? prescriptionHref(patient.id, serviceDate || today, {
        direction,
        time,
        returnTime: direction === "BOTH" ? returnTime : undefined,
        facilityId: facilityId || undefined,
        fromCourses: !fromRecord,
      })
    : null;

  return (
    <form action={action} className="space-y-5" noValidate>
      <FormMessage>{state.message}</FormMessage>

      <Fieldset legend="Patient et prise en charge">
        <Field
          label="Patient"
          htmlFor="patientId-search"
          error={errors.patientId ?? loadError ?? undefined}
          hint={
            loading
              ? "Chargement des prescriptions…"
              : patient
                ? `Mobilité : ${patient.mobilityLabel}`
                : "Nom, prénom, ville, code postal ou numéro de téléphone."
          }
        >
          <SearchSelect
            id="patientId-search"
            label="Patient"
            value={patient?.id ?? ""}
            selectedLabel={patient?.label ?? "Choisissez un patient…"}
            onChange={choosePatient}
            search={search}
            searchHint="Tapez au moins 2 lettres du nom, ou les chiffres du téléphone."
            placeholder="Nom, ville ou téléphone…"
            emptyText="Aucun patient actif ne correspond."
            invalid={Boolean(errors.patientId ?? loadError)}
            describedBy={errors.patientId || loadError ? fieldIds("patientId-search").error : fieldIds("patientId-search").hint}
          />
        </Field>
        <input type="hidden" name="patientId" value={patient?.id ?? ""} />

        {/* The payer at its width, the three directions on one line beside it. */}
        <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-6">
          <RadioGroup
            legend="Payeur"
            name="payer"
            value={payer}
            onChange={(value) => setPayer(value as Payer)}
            options={[
              { value: "CPAM", label: "CPAM (prescription)" },
              { value: "PRIVATE", label: "Client privé" },
            ]}
            error={errors.payer}
          />
          <RadioGroup
            legend="Sens"
            name="direction"
            value={direction}
            onChange={(value) => setDirection(value as NewTripDirection)}
            options={DIRECTION_OPTIONS}
            error={errors.direction}
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
                Aucune prescription valide le {serviceDate ? formatShortDate(serviceDate) : "jour choisi"} pour ce patient.{" "}
                {newPrescriptionHref ? (
                  <Link href={newPrescriptionHref} className="font-medium underline underline-offset-2">
                    Nouvelle prescription
                  </Link>
                ) : null}{" "}
                (retour ensuite à cette course), ou facturer la course en client privé.
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
          hint={usual ? (facilityId === usual.id ? "Établissement habituel du patient." : `Habituel : ${usual.label}`) : undefined}
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
                {f.id === patient?.usualFacilityId ? `${f.label} — habituel` : f.label}
              </option>
            ))}
          </Select>
        </Field>

        {freeDestination ? (
          <PlaceFields
            prefix="destination"
            label={direction === "RETURN" ? "Adresse de prise en charge" : "Adresse de destination"}
            defaults={{ address: v("destinationAddress"), lat: v("destinationLat"), lng: v("destinationLng") }}
            errors={errors}
            geocoder={geocoder}
          />
        ) : null}

        <div className={direction === "BOTH" ? "grid gap-4 sm:grid-cols-3" : "grid gap-4 sm:grid-cols-2"}>
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
          <Field
            label={timeFieldLabel(direction === "RETURN" ? "RETURN" : "OUTBOUND")}
            htmlFor="time"
            error={errors.time}
            hint={timeFieldHint(direction === "RETURN" ? "RETURN" : "OUTBOUND")}
          >
            <Input
              id="time"
              name="time"
              type="time"
              required
              value={time}
              onChange={(e) => changeTime(e.target.value)}
              className="tabular"
              aria-invalid={invalid("time")}
            />
          </Field>
          {direction === "BOTH" ? (
            <Field
              label="Fin de séance (retour)"
              htmlFor="returnTime"
              error={errors.returnTime}
              hint={
                sessionMinutes !== null && !returnTouched
                  ? `Rendez-vous + séance habituelle (${sessionMinutes} min) : modifiable.`
                  : timeFieldHint("RETURN")
              }
            >
              <Input
                id="returnTime"
                name="returnTime"
                type="time"
                required
                value={returnTime}
                onChange={(e) => {
                  setReturnTime(e.target.value);
                  setReturnTouched(true);
                }}
                className="tabular"
                aria-invalid={invalid("returnTime")}
              />
            </Field>
          ) : null}
        </div>

        <Field
          label="Notes (facultatif)"
          htmlFor="notes"
          error={errors.notes}
          hint="Visible du régulateur et sur la feuille de route du chauffeur. Aucune information médicale (diagnostic, traitement)."
        >
          <Textarea id="notes" name="notes" maxLength={500} rows={2} defaultValue={v("notes")} />
        </Field>
      </Fieldset>

      <section aria-label="Règles appliquées" className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm">
        <p className="flex flex-wrap items-center gap-1.5 text-slate-700">
          <span className="font-medium">Véhicules autorisés&nbsp;:</span>
          {payer === "CPAM" && !prescription ? (
            <span className="text-slate-500">selon la prescription</span>
          ) : (
            vehicleTypes.map((type) => <VehicleTypeBadge key={type} type={type} />)
          )}
        </p>
        <p className="mt-1 text-slate-700">
          <span className="font-medium">Transport partagé&nbsp;:</span>{" "}
          {payer === "PRIVATE"
            ? "non (client privé)"
            : !prescription
              ? "selon la prescription"
              : mode === "AMBULANCE"
                ? "non (ambulance : un seul patient)"
                : shareableLegs.length === legs.length
                  ? `possible sur ${legs.length > 1 ? "les deux trajets" : "ce trajet"} (proposition à tracer sur la course)`
                  : shareableLegs.length > 0
                    ? `possible sur ${shareableLegs[0] === "OUTBOUND" ? "l'aller" : "le retour"} seulement (prescription)`
                    : `non autorisé par la prescription sur ${legs.length > 1 ? "ces trajets" : "ce trajet"}`}
        </p>
      </section>

      <FormFooter
        cancelHref={cancelHref ?? `/courses?date=${serviceDate || today}`}
        submitLabel={direction === "BOTH" ? "Créer l'aller et le retour" : "Créer la course"}
      />
      <ErrorFocus refusal={refusalKey(state)} />
    </form>
  );
}
