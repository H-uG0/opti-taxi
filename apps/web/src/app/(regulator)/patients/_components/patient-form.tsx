"use client";

import { startTransition, useActionState, type MouseEvent } from "react";
import { AddressFields } from "@/components/address/address-fields";
import type { AddressFormValues } from "@/components/address/address-utils";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Field, Fieldset, FormMessage, Input, Select, Textarea } from "@/components/ui/form";
import { MOBILITY_LABELS } from "@/lib/labels";
import { echoed, IDLE_STATE, refusalKey } from "@/lib/forms";
import { ErrorFocus } from "@/components/ui/error-focus";
import { FormFooter } from "@/components/ui/form-footer";
import type { PatientFormState } from "../_lib/patient-form-state";
import { MOBILITIES } from "../_lib/options";
import { submitWithoutReset } from "./form-submit";

export type PatientFormInitial = {
  lastName: string;
  firstName: string;
  phone: string;
  mobility: string;
  accessNotes: string;
  address: AddressFormValues;
};

export function PatientForm({
  action,
  initial,
  geocoderEnabled,
  submitLabel,
  cancelHref,
}: {
  action: (prev: PatientFormState, formData: FormData) => Promise<PatientFormState>;
  initial: PatientFormInitial;
  geocoderEnabled: boolean;
  submitLabel: string;
  cancelHref: string;
}) {
  const [state, formAction, isPending] = useActionState<PatientFormState, FormData>(action, IDLE_STATE);
  const errors = state.fieldErrors;
  const value = (key: keyof Omit<PatientFormInitial, "address">) => echoed(state, key, initial[key]);
  const similar = state.similar ?? [];

  function createAnyway(event: MouseEvent<HTMLButtonElement>) {
    const form = event.currentTarget.form;
    if (!form) return;
    const formData = new FormData(form);
    formData.set("confirmSimilar", "1");
    startTransition(() => formAction(formData));
  }

  return (
    <form action={formAction} onSubmit={submitWithoutReset(formAction)} className="max-w-3xl space-y-5" noValidate>
      {similar.length > 0 ? (
        // Not an error, and not a second alert: the list (announced once) sits by the buttons, where the save was asked.
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          {state.message}{" "}
          <a href="#fiches-proches" className="font-medium underline underline-offset-2">
            Voir les fiches proches
          </a>
        </p>
      ) : (
        <FormMessage>{state.message}</FormMessage>
      )}

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
          <Field label="Téléphone (facultatif)" htmlFor="phone" error={errors.phone} hint="Pour prévenir le patient">
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
            hint="Allongé&nbsp;: transport en ambulance&#x202F;; assis ou fauteuil&nbsp;: taxi ou VSL"
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

      <Fieldset legend="Accès">
        <Field
          label="Notes d'accès"
          htmlFor="accessNotes"
          error={errors.accessNotes}
          hint="Codes d'accès, étage, ascenseur, interphone… visibles par le chauffeur aux arrêts du domicile"
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
      </Fieldset>

      {similar.length > 0 ? (
        <div
          id="fiches-proches"
          role="alert"
          className="scroll-mt-6 space-y-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-950"
        >
          <p className="font-semibold">Fiches proches déjà enregistrées&nbsp;:</p>
          <ul className="space-y-1">
            {similar.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/patients/${p.id}`}
                  target="_blank"
                  className="font-medium underline underline-offset-2 hover:no-underline"
                >
                  {p.name}
                </Link>{" "}
                — {p.city}
                {p.active ? "" : " (désactivé)"} · <span className="text-amber-900">{p.reasons.join(", ")}</span>
              </li>
            ))}
          </ul>
          <p>
            S&apos;il s&apos;agit du même patient, ouvrez sa fiche (nouvel onglet) plutôt que d&apos;en créer une seconde.
            Sinon, enregistrez la nouvelle fiche.
          </p>
          {/* Not a submit button: Enter in a field must keep submitting the form normally, never « quand même ». */}
          <Button type="button" variant="secondary" size="sm" disabled={isPending} onClick={createAnyway}>
            Créer quand même
          </Button>
        </div>
      ) : null}

      <FormFooter cancelHref={cancelHref} submitLabel={submitLabel} pending={isPending} />
      <ErrorFocus refusal={similar.length > 0 ? null : refusalKey(state)} />
    </form>
  );
}
