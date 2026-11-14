"use client";

import { useActionState, useState } from "react";
import { Field, Fieldset, FormMessage, Input, Select, Textarea } from "@/components/ui/form";
import { RECURRENCE_LEGS_LABELS } from "@/lib/labels";
import { formatDuration, formatMinute, isIsoDate, parseMinute } from "@/lib/time";
import { echoed, echoedList, IDLE_STATE, refusalKey, type FormState } from "@/lib/forms";
import { MAX_SESSION_MINUTES, RECURRENCE_LEGS, RECURRENCE_NOTES_MAX } from "../_lib/options";
import { WeekdayPicker } from "./weekday-picker";
import { recurrenceFormNotices, type FormPrescription } from "../_lib/status";
import { submitWithoutReset } from "./form-submit";
import { ErrorFocus } from "@/components/ui/error-focus";
import { FormFooter } from "@/components/ui/form-footer";
import { Notice } from "@/components/ui/notice";

export type RecurrenceFormInitial = {
  facilityId: string;
  prescriptionId: string;
  label: string;
  weekdays: string[];
  appointmentTime: string;
  sessionMinutes: string;
  legs: string;
  startDate: string;
  endDate: string;
  notes: string;
};

export type FacilityOption = { id: string; name: string; city: string; active: boolean };
export type PrescriptionOption = FormPrescription & { id: string; label: string };

export function RecurrenceForm({
  action,
  initial,
  facilities,
  prescriptions,
  todayIso,
  submitLabel,
  cancelHref,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  initial: RecurrenceFormInitial;
  facilities: FacilityOption[];
  prescriptions: PrescriptionOption[];
  todayIso: string;
  submitLabel: string;
  cancelHref: string;
}) {
  const [state, formAction, isPending] = useActionState(action, IDLE_STATE);
  const errors = state.fieldErrors;
  const value = (key: keyof Omit<RecurrenceFormInitial, "weekdays">) => echoed(state, key, initial[key]);

  const [weekdays, setWeekdays] = useState<Set<string>>(() => new Set(echoedList(state, "weekdays", initial.weekdays)));
  const [prescriptionId, setPrescriptionId] = useState(value("prescriptionId"));
  const [startDate, setStartDate] = useState(value("startDate"));
  const [endDate, setEndDate] = useState(value("endDate"));
  const [appointmentTime, setAppointmentTime] = useState(value("appointmentTime"));
  const [sessionMinutes, setSessionMinutes] = useState(value("sessionMinutes"));
  const [legs, setLegs] = useState(value("legs"));

  const prescription = prescriptions.find((p) => p.id === prescriptionId) ?? null;
  const validityNotices =
    prescription && isIsoDate(startDate) && (endDate === "" || isIsoDate(endDate))
      ? recurrenceFormNotices({ startDate, endDate: endDate === "" ? null : endDate }, prescription, todayIso)
      : [];

  const appointment = parseMinute(appointmentTime);
  const session = /^\d+$/.test(sessionMinutes.trim()) ? Number(sessionMinutes) : null;
  const readyMinute = appointment !== null && session !== null ? appointment + session : null;

  return (
    <form action={formAction} onSubmit={submitWithoutReset(formAction)} className="max-w-3xl space-y-5" noValidate>
      <FormMessage>{state.message}</FormMessage>

      <Fieldset legend="Lieu de soins et prescription">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Établissement" htmlFor="facilityId" error={errors.facilityId}>
            <Select
              id="facilityId"
              name="facilityId"
              defaultValue={value("facilityId")}
              aria-invalid={errors.facilityId ? true : undefined}
            >
              <option value="">— Choisir —</option>
              {facilities.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name} ({f.city}){f.active ? "" : " — désactivé"}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Prescription" htmlFor="prescriptionId" error={errors.prescriptionId}>
            <Select
              id="prescriptionId"
              name="prescriptionId"
              defaultValue={value("prescriptionId")}
              onChange={(e) => setPrescriptionId(e.target.value)}
              aria-invalid={errors.prescriptionId ? true : undefined}
            >
              <option value="">— Choisir —</option>
              {prescriptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Libellé (facultatif)" htmlFor="label" error={errors.label} hint="Ex. Dialyse, Radiothérapie">
          <Input
            id="label"
            name="label"
            defaultValue={value("label")}
            maxLength={80}
            autoComplete="off"
            aria-invalid={errors.label ? true : undefined}
          />
        </Field>
        <RecurrenceNotesField defaultValue={value("notes")} error={errors.notes} />
      </Fieldset>

      <Fieldset legend="Rythme et horaires">
        <WeekdayPicker value={weekdays} onChange={setWeekdays} error={errors.weekdays} />

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Heure du rendez-vous" htmlFor="appointmentTime" error={errors.appointmentTime}>
            <Input
              id="appointmentTime"
              name="appointmentTime"
              type="time"
              defaultValue={value("appointmentTime")}
              onChange={(e) => setAppointmentTime(e.target.value)}
              className="tabular"
              aria-invalid={errors.appointmentTime ? true : undefined}
            />
          </Field>
          <Field
            label="Durée de séance (min)"
            htmlFor="sessionMinutes"
            error={errors.sessionMinutes}
            hint={session !== null ? formatDuration(session) : "Ex. 240 pour une dialyse"}
          >
            <Input
              id="sessionMinutes"
              name="sessionMinutes"
              type="number"
              inputMode="numeric"
              min={0}
              max={MAX_SESSION_MINUTES}
              step={5}
              defaultValue={value("sessionMinutes")}
              onChange={(e) => setSessionMinutes(e.target.value)}
              className="tabular"
              aria-invalid={errors.sessionMinutes ? true : undefined}
            />
          </Field>
          <Field
            label="Trajets"
            htmlFor="legs"
            error={errors.legs}
            hint={
              readyMinute !== null && legs !== "OUTBOUND" && readyMinute < 1440
                ? `Retour\u00a0: prise en charge à partir de ${formatMinute(readyMinute)}`
                : undefined
            }
          >
            <Select
              id="legs"
              name="legs"
              defaultValue={value("legs")}
              onChange={(e) => setLegs(e.target.value)}
              aria-invalid={errors.legs ? true : undefined}
            >
              {RECURRENCE_LEGS.map((l) => (
                <option key={l} value={l}>
                  {RECURRENCE_LEGS_LABELS[l]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Fieldset>

      <Fieldset legend="Période">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date de début" htmlFor="startDate" error={errors.startDate}>
            <Input
              id="startDate"
              name="startDate"
              type="date"
              defaultValue={value("startDate")}
              onChange={(e) => setStartDate(e.target.value)}
              className="tabular"
              aria-invalid={errors.startDate ? true : undefined}
            />
          </Field>
          <Field label="Date de fin" htmlFor="endDate" error={errors.endDate} hint="Facultative — vide&nbsp;: sans fin prévue">
            <Input
              id="endDate"
              name="endDate"
              type="date"
              min={isIsoDate(startDate) ? startDate : undefined}
              defaultValue={value("endDate")}
              onChange={(e) => setEndDate(e.target.value)}
              className="tabular"
              aria-invalid={errors.endDate ? true : undefined}
            />
          </Field>
        </div>
        {validityNotices.map((notice) => (
          <Notice size="sm" key={notice.text} tone={notice.tone}>
            {notice.text}
          </Notice>
        ))}
      </Fieldset>

      <FormFooter cancelHref={cancelHref} submitLabel={submitLabel} pending={isPending} />
      <ErrorFocus refusal={refusalKey(state)} />
    </form>
  );
}

/** Hint of the recurrence's notes: where they go, and what never goes there. */
export const RECURRENCE_NOTES_HINT =
  "Recopiées sur chaque course et montrées au chauffeur (salle, matériel à prévoir…). Aucune information médicale\u00a0: le motif des soins reste sur la prescription.";

/** « Consignes pour le chauffeur » of a recurrence (form field `notes`). */
export function RecurrenceNotesField({
  name = "notes",
  defaultValue,
  error,
}: {
  name?: string;
  defaultValue: string;
  error?: string;
}) {
  return (
    <Field label="Consignes pour le chauffeur (facultatif)" htmlFor={name} error={error} hint={RECURRENCE_NOTES_HINT}>
      <Textarea
        id={name}
        name={name}
        defaultValue={defaultValue}
        maxLength={RECURRENCE_NOTES_MAX}
        rows={2}
        placeholder="Ex. salle 3, apporter le coussin"
        aria-invalid={error ? true : undefined}
      />
    </Field>
  );
}
