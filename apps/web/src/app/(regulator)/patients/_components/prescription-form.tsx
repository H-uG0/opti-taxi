"use client";

import { useActionState, useState } from "react";
import type { Mobility } from "@prisma/client";
import { Checkbox, Field, Fieldset, FormMessage, Input, Select, Textarea } from "@/components/ui/form";
import { MOBILITY_LABELS, PRESCRIBED_MODE_LABELS, SHARING_SCOPE_LABELS } from "@/lib/labels";
import { isIsoDate } from "@/lib/time";
import { echoed, echoedCheckbox, IDLE_STATE, refusalKey, type FormState } from "@/lib/forms";
import { PRESCRIBED_MODES, SHARING_SCOPES } from "../_lib/options";
import { mobilityModeWarning, prescriptionValidity, validityLabel } from "../_lib/status";
import { submitWithoutReset } from "./form-submit";
import { ErrorFocus } from "@/components/ui/error-focus";
import { FormFooter } from "@/components/ui/form-footer";
import { Notice } from "@/components/ui/notice";

export type PrescriptionFormInitial = {
  mode: string;
  sharing: string;
  validFrom: string;
  validTo: string;
  isSeries: boolean;
  prescriber: string;
  notes: string;
};

export function PrescriptionForm({
  action,
  initial,
  mobility,
  todayIso,
  submitLabel,
  cancelHref,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  initial: PrescriptionFormInitial;
  mobility: Mobility;
  todayIso: string;
  submitLabel: string;
  cancelHref: string;
}) {
  const [state, formAction, isPending] = useActionState(action, IDLE_STATE);
  const errors = state.fieldErrors;
  const value = (key: keyof Omit<PrescriptionFormInitial, "isSeries">) => echoed(state, key, initial[key]);

  const [mode, setMode] = useState(value("mode"));
  const [validFrom, setValidFrom] = useState(value("validFrom"));
  const [validTo, setValidTo] = useState(value("validTo"));

  const isAmbulance = mode === "AMBULANCE";
  const modeWarning = mode === "TAP" || mode === "AMBULANCE" ? mobilityModeWarning(mobility, mode) : null;
  const datesOk = isIsoDate(validFrom) && isIsoDate(validTo) && validFrom <= validTo;
  const validity = datesOk ? prescriptionValidity({ validFrom, validTo }, todayIso) : null;

  return (
    <form action={formAction} onSubmit={submitWithoutReset(formAction)} className="max-w-3xl space-y-5" noValidate>
      <FormMessage>{state.message}</FormMessage>

      <Fieldset legend="Prescription médicale de transport">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Mode prescrit"
            htmlFor="mode"
            error={errors.mode}
            hint={`Mobilité du patient\u00a0: ${MOBILITY_LABELS[mobility].toLowerCase()}`}
          >
            <Select
              id="mode"
              name="mode"
              defaultValue={value("mode")}
              onChange={(e) => setMode(e.target.value)}
              aria-invalid={errors.mode ? true : undefined}
            >
              {PRESCRIBED_MODES.map((m) => (
                <option key={m} value={m}>
                  {PRESCRIBED_MODE_LABELS[m]}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Transport partagé autorisé"
            htmlFor="sharing"
            error={errors.sharing}
            hint={
              isAmbulance
                ? "Sans objet en ambulance (un seul patient à bord)"
                : "Ce que la prescription autorise (décret 2025-202)"
            }
          >
            {isAmbulance ? <input type="hidden" name="sharing" value="NONE" /> : null}
            <Select
              id="sharing"
              name={isAmbulance ? undefined : "sharing"}
              defaultValue={value("sharing")}
              disabled={isAmbulance}
              aria-invalid={errors.sharing ? true : undefined}
            >
              {SHARING_SCOPES.map((s) => (
                <option key={s} value={s}>
                  {SHARING_SCOPE_LABELS[s]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {modeWarning ? <Notice size="sm">{modeWarning}</Notice> : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Début de validité" htmlFor="validFrom" error={errors.validFrom}>
            <Input
              id="validFrom"
              name="validFrom"
              type="date"
              defaultValue={value("validFrom")}
              onChange={(e) => setValidFrom(e.target.value)}
              className="tabular"
              aria-invalid={errors.validFrom ? true : undefined}
            />
          </Field>
          <Field label="Fin de validité" htmlFor="validTo" error={errors.validTo}>
            <Input
              id="validTo"
              name="validTo"
              type="date"
              min={isIsoDate(validFrom) ? validFrom : undefined}
              defaultValue={value("validTo")}
              onChange={(e) => setValidTo(e.target.value)}
              className="tabular"
              aria-invalid={errors.validTo ? true : undefined}
            />
          </Field>
        </div>
        {validity && (validity.state === "expired" || validity.state === "expiring") ? (
          <Notice size="sm" tone={validity.state === "expired" ? "danger" : "warning"}>
            {validityLabel({ validFrom, validTo }, todayIso)}&nbsp;: aucune course ne sera générée après la fin de validité.
          </Notice>
        ) : null}

        <Checkbox
          name="isSeries"
          defaultChecked={echoedCheckbox(state, "isSeries", initial.isSeries)}
          label="Prescription en série (transports répétés pour un même traitement)"
        />
      </Fieldset>

      <Fieldset legend="Compléments">
        <Field label="Prescripteur (facultatif)" htmlFor="prescriber" error={errors.prescriber} hint="Ex. Dr Martin, néphrologue">
          <Input
            id="prescriber"
            name="prescriber"
            defaultValue={value("prescriber")}
            maxLength={120}
            autoComplete="off"
            aria-invalid={errors.prescriber ? true : undefined}
          />
        </Field>
        <Field label="Notes (facultatif)" htmlFor="notes" error={errors.notes}>
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
