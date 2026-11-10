"use client";

import { useActionState } from "react";
import { AddressFields } from "@/components/address/address-fields";
import type { AddressFormValues } from "@/components/address/address-utils";
import { Field, Fieldset, FormMessage, Input, Select, Textarea } from "@/components/ui/form";
import { FACILITY_TYPE_LABELS } from "@/lib/labels";
import { submitWithoutReset } from "@/app/(regulator)/patients/_components/form-submit";
import { ErrorFocus } from "@/components/ui/error-focus";
import { FormFooter } from "@/components/ui/form-footer";
import { echoed, IDLE_STATE, refusalKey, type FormState } from "@/lib/forms";
import { FACILITY_TYPES } from "../_lib/options";

export type FacilityFormInitial = {
  name: string;
  type: string;
  phone: string;
  notes: string;
  /** Minutes added to the stop at the facility, "" or "0" for none. */
  extraServiceMin: string;
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
  const [state, formAction, isPending] = useActionState(action, IDLE_STATE);
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
        <Field
          label="Temps d'arrêt en plus (min)"
          htmlFor="extraServiceMin"
          error={errors.extraServiceMin}
          hint="Ajouté à la dépose d'un aller et à la prise en charge d'un retour ici : accueil éloigné, service à l'étage… 0 par défaut."
          className="sm:max-w-md"
        >
          <Input
            id="extraServiceMin"
            name="extraServiceMin"
            inputMode="numeric"
            defaultValue={value("extraServiceMin")}
            autoComplete="off"
            className="tabular sm:max-w-32"
            aria-invalid={errors.extraServiceMin ? true : undefined}
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
          label="Notes (facultatif)"
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

      <FormFooter cancelHref={cancelHref} submitLabel={submitLabel} pending={isPending} />
      <ErrorFocus refusal={refusalKey(state)} />
    </form>
  );
}
