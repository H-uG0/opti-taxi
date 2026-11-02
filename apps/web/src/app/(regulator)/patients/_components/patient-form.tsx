"use client";

import { useActionState } from "react";
import { AddressFields } from "@/components/address/address-fields";
import type { AddressFormValues } from "@/components/address/address-utils";
import { LinkButton } from "@/components/ui/button";
import { Checkbox, Field, Fieldset, FormMessage, Input, Select, Textarea } from "@/components/ui/form";
import { MOBILITY_LABELS } from "@/lib/labels";
import { echoed, echoedCheckbox, INITIAL_FORM_STATE, type FormState } from "../_lib/form-state";
import { MOBILITIES } from "../_lib/options";
import { FormSubmitButton, submitWithoutReset } from "./form-submit";

export type PatientFormInitial = {
  lastName: string;
  firstName: string;
  phone: string;
  mobility: string;
  accessNotes: string;
  active: boolean;
  address: AddressFormValues;
};

export function PatientForm({
  action,
  initial,
  geocoderEnabled,
  submitLabel,
  cancelHref,
  activeHint,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  initial: PatientFormInitial;
  geocoderEnabled: boolean;
  submitLabel: string;
  cancelHref: string;
  /** Shown under the « actif » box of an active patient: what unticking it does. */
  activeHint?: string;
}) {
  const [state, formAction, isPending] = useActionState(action, INITIAL_FORM_STATE);
  const errors = state.fieldErrors;
  const value = (key: keyof Omit<PatientFormInitial, "active" | "address">) => echoed(state, key, initial[key]);

  return (
    <form action={formAction} onSubmit={submitWithoutReset(formAction)} className="max-w-3xl space-y-5" noValidate>
      <FormMessage>{state.message}</FormMessage>

      <Fieldset legend="Identité">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nom" htmlFor="lastName" error={errors.lastName}>
            <Input
              id="lastName"
              name="lastName"
              defaultValue={value("lastName")}
              autoComplete="off"
              maxLength={80}
              required
              aria-invalid={errors.lastName ? true : undefined}
            />
          </Field>
          <Field label="Prénom" htmlFor="firstName" error={errors.firstName}>
            <Input
              id="firstName"
              name="firstName"
              defaultValue={value("firstName")}
              autoComplete="off"
              maxLength={80}
              required
              aria-invalid={errors.firstName ? true : undefined}
            />
          </Field>
          <Field label="Téléphone" htmlFor="phone" error={errors.phone} hint="Facultatif — pour prévenir le patient">
            <Input
              id="phone"
              name="phone"
              type="tel"
              defaultValue={value("phone")}
              autoComplete="off"
              maxLength={30}
              className="tabular"
              aria-invalid={errors.phone ? true : undefined}
            />
          </Field>
          <Field
            label="Mobilité"
            htmlFor="mobility"
            error={errors.mobility}
            hint="Allongé : transport en ambulance ; assis ou fauteuil : taxi ou VSL"
          >
            <Select
              id="mobility"
              name="mobility"
              defaultValue={value("mobility")}
              required
              aria-invalid={errors.mobility ? true : undefined}
            >
              {MOBILITIES.map((m) => (
                <option key={m} value={m}>
                  {MOBILITY_LABELS[m]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Fieldset>

      <AddressFields
        legend="Domicile (lieu de prise en charge)"
        defaultValues={initial.address}
        errors={errors}
        geocoderEnabled={geocoderEnabled}
      />

      <Fieldset legend="Accès et statut">
        <Field
          label="Notes d'accès"
          htmlFor="accessNotes"
          error={errors.accessNotes}
          hint="Codes d'accès, étage, ascenseur, interphone… visibles par le chauffeur"
        >
          <Textarea
            id="accessNotes"
            name="accessNotes"
            defaultValue={value("accessNotes")}
            maxLength={1000}
            rows={3}
            aria-invalid={errors.accessNotes ? true : undefined}
          />
        </Field>
        <div className="space-y-1">
          <Checkbox
            name="active"
            defaultChecked={echoedCheckbox(state, "active", initial.active)}
            label="Patient actif (ses récurrences génèrent des courses)"
          />
          {initial.active && activeHint ? <p className="text-xs text-slate-500">{activeHint}</p> : null}
        </div>
      </Fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <FormSubmitButton pending={isPending}>{submitLabel}</FormSubmitButton>
        <LinkButton href={cancelHref} variant="ghost">
          Annuler
        </LinkButton>
      </div>
    </form>
  );
}
