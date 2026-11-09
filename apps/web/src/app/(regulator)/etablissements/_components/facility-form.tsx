"use client";

import { useActionState } from "react";
import { AddressFields } from "@/components/address/address-fields";
import type { AddressFormValues } from "@/components/address/address-utils";
import { LinkButton } from "@/components/ui/button";
import { Field, Fieldset, FormMessage, Input, Select, Textarea } from "@/components/ui/form";
import { FACILITY_TYPE_LABELS } from "@/lib/labels";
import { FormSubmitButton, submitWithoutReset } from "@/app/(regulator)/patients/_components/form-submit";
import { echoed, INITIAL_FORM_STATE, type FormState } from "@/app/(regulator)/patients/_lib/form-state";
import { FACILITY_TYPES } from "../_lib/options";

export type FacilityFormInitial = {
  name: string;
  type: string;
  phone: string;
  notes: string;
  address: AddressFormValues;
};

export function FacilityForm({
  action,
  initial,
  geocoderEnabled,
  submitLabel,
  cancelHref,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  initial: FacilityFormInitial;
  geocoderEnabled: boolean;
  submitLabel: string;
  cancelHref: string;
}) {
  const [state, formAction, isPending] = useActionState(action, INITIAL_FORM_STATE);
  const errors = state.fieldErrors;
  const value = (key: keyof Omit<FacilityFormInitial, "address">) => echoed(state, key, initial[key]);

  return (
    <form action={formAction} onSubmit={submitWithoutReset(formAction)} className="max-w-3xl space-y-5" noValidate>
      <FormMessage>{state.message}</FormMessage>

      <Fieldset legend="Établissement">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Field label="Nom" htmlFor="name" error={errors.name}>
            <Input
              id="name"
              name="name"
              defaultValue={value("name")}
              maxLength={120}
              autoComplete="off"
              required
              aria-invalid={errors.name ? true : undefined}
            />
          </Field>
          <Field label="Type" htmlFor="type" error={errors.type}>
            <Select id="type" name="type" defaultValue={value("type")} aria-invalid={errors.type ? true : undefined}>
              {FACILITY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {FACILITY_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field
          label="Téléphone de l'accueil"
          htmlFor="phone"
          error={errors.phone}
          hint="Prévenu des arrivées en transport partagé (décret 2025-202)"
          className="sm:max-w-xs"
        >
          <Input
            id="phone"
            name="phone"
            type="tel"
            defaultValue={value("phone")}
            maxLength={30}
            autoComplete="off"
            className="tabular"
            aria-invalid={errors.phone ? true : undefined}
          />
        </Field>
      </Fieldset>

      <AddressFields
        legend="Adresse (lieu de dépose)"
        defaultValues={initial.address}
        errors={errors}
        geocoderEnabled={geocoderEnabled}
      />

      <Fieldset legend="Notes">
        <Field
          label="Notes"
          htmlFor="notes"
          error={errors.notes}
          hint="Entrée à utiliser, stationnement, service à l'étage… visibles par le chauffeur à la dépose et à la prise en charge"
        >
          <Textarea
            id="notes"
            name="notes"
            defaultValue={value("notes")}
            maxLength={1000}
            rows={3}
            aria-invalid={errors.notes ? true : undefined}
          />
        </Field>
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
