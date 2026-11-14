"use client";

import { useActionState, useState } from "react";
import type { Payer, TripDirection } from "@prisma/client";
import { ErrorFocus } from "@/components/ui/error-focus";
import { Field, Fieldset, FormMessage, Input, Select, Textarea } from "@/components/ui/form";
import { FormFooter } from "@/components/ui/form-footer";
import { IDLE_STATE, refusalKey, valueOf } from "@/lib/forms";
import { updateTrip, type EditTripState } from "../../actions";
import { PlaceFields, RadioGroup } from "../../place-fields";
import { TRIP_NOTES_MAX, type EditTripField } from "../../trip-form";
import { timeFieldHint, timeFieldLabel } from "../../trip-rules";
import { submitWithoutReset } from "../../../patients/_components/form-submit";

export type EditFacilityOption = { id: string; label: string };

export type EditTripInitial = Record<EditTripField, string>;

type Props = {
  tripId: string;
  direction: TripDirection;
  payer: Payer;
  /** The patient's home, as the radio shows it. */
  homeAddress: string;
  facilities: EditFacilityOption[];
  initial: EditTripInitial;
  today: string;
  geocoder: boolean;
  cancelHref: string;
  /** Recurrence label when the trip comes from one (its notes are the recurrence's, copied). */
  recurrenceLabel: string | null;
};

/**
 * « Modifier la course »: date, time, the patient's address for this trip
 * (home or another address), the care place and the notes. Submitted without
 * React's form reset, so a refused save keeps every choice.
 */
export function EditTripForm(props: Props) {
  const [state, action, pending] = useActionState(updateTrip.bind(null, props.tripId), IDLE_STATE);
  // A new key after each server answer remounts the fields with the submitted values.
  return <EditTripFields key={state.submissionId} state={state} action={action} pending={pending} {...props} />;
}

function EditTripFields({
  state,
  action,
  pending,
  direction,
  payer,
  homeAddress,
  facilities,
  initial,
  today,
  geocoder,
  cancelHref,
  recurrenceLabel,
}: Props & { state: EditTripState; action: (formData: FormData) => void; pending: boolean }) {
  const v = (key: EditTripField) => (state.values ? valueOf(state.values, key) : initial[key]);
  const errors = state.fieldErrors;
  const [homeMode, setHomeMode] = useState(v("homeMode") === "other" ? "other" : "home");
  const [facilityId, setFacilityId] = useState(v("facilityId"));
  const invalid = (field: string) => (errors[field] ? true : undefined);
  const outbound = direction === "OUTBOUND";
  const freeCare = payer === "PRIVATE" && facilityId === "";

  return (
    <form action={action} onSubmit={submitWithoutReset(action)} className="space-y-5" noValidate>
      <FormMessage>{state.message}</FormMessage>

      <Fieldset legend="Date et horaire">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Date"
            htmlFor="serviceDate"
            error={errors.serviceDate}
            hint={recurrenceLabel ? "Une autre date ne vaut que pour cette séance : la récurrence ne change pas." : undefined}
          >
            <Input
              id="serviceDate"
              name="serviceDate"
              type="date"
              required
              min={today}
              defaultValue={v("serviceDate")}
              className="tabular"
              aria-invalid={invalid("serviceDate")}
            />
          </Field>
          <Field label={timeFieldLabel(direction)} htmlFor="time" error={errors.time} hint={timeFieldHint(direction)}>
            <Input id="time" name="time" type="time" required defaultValue={v("time")} className="tabular" aria-invalid={invalid("time")} />
          </Field>
        </div>
      </Fieldset>

      <Fieldset legend={outbound ? "Prise en charge du patient" : "Dépose du patient"}>
        <RadioGroup
          legend={outbound ? "Où prendre le patient" : "Où déposer le patient"}
          name="homeMode"
          value={homeMode}
          onChange={setHomeMode}
          options={[
            { value: "home", label: <span>Domicile&nbsp;: {homeAddress}</span> },
            { value: "other", label: "Autre adresse pour cette course" },
          ]}
          error={errors.homeMode}
        />
        {homeMode === "other" ? (
          <PlaceFields
            prefix="home"
            label={outbound ? "Adresse de prise en charge" : "Adresse de dépose"}
            hint="Pour cette course seulement (patient hébergé ailleurs)&nbsp;: le domicile de la fiche ne change pas."
            defaults={{ address: v("homeAddress"), lat: v("homeLat"), lng: v("homeLng") }}
            errors={errors}
            geocoder={geocoder}
          />
        ) : null}
      </Fieldset>

      <Fieldset legend="Lieu de soins">
        <Field label={payer === "CPAM" ? "Établissement de soins" : "Établissement (facultatif)"} htmlFor="facilityId" error={errors.facilityId}>
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
        {freeCare ? (
          <PlaceFields
            prefix="care"
            label={outbound ? "Adresse de destination" : "Adresse de prise en charge"}
            defaults={{ address: v("careAddress"), lat: v("careLat"), lng: v("careLng") }}
            errors={errors}
            geocoder={geocoder}
          />
        ) : null}
      </Fieldset>

      <Fieldset legend="Notes">
        <Field
          label="Notes pour le chauffeur (facultatif)"
          htmlFor="notes"
          error={errors.notes}
          hint={
            recurrenceLabel
              ? "Reprises des consignes de la récurrence, montrées sur la feuille de route. Changées ici, elles ne valent que pour cette course. Aucune information médicale."
              : "Visibles du régulateur et sur la feuille de route du chauffeur. Aucune information médicale (diagnostic, traitement)."
          }
        >
          <Textarea id="notes" name="notes" maxLength={TRIP_NOTES_MAX} rows={2} defaultValue={v("notes")} aria-invalid={invalid("notes")} />
        </Field>
      </Fieldset>

      <FormFooter cancelHref={cancelHref} submitLabel="Enregistrer la course" pending={pending} />
      <ErrorFocus refusal={refusalKey(state)} />
    </form>
  );
}
