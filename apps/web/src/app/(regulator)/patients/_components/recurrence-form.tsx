"use client";

import { useActionState, useState } from "react";
import { Field, Fieldset, FormMessage, Input, Select, Textarea } from "@/components/ui/form";
import { RECURRENCE_LEGS_LABELS } from "@/lib/labels";
import { formatDuration, formatMinute, isIsoDate, parseMinute } from "@/lib/time";
import { echoed, echoedList, IDLE_STATE, refusalKey, type FormState } from "@/lib/forms";
import { DATES_FREQUENCY, dayTimeField, daySessionField, MAX_SESSION_MINUTES, RECURRENCE_LEGS, RECURRENCE_NOTES_MAX } from "../_lib/options";
import { parseSessionDates, weekdaysOfDates } from "@/lib/domain/recurrence-rhythm";
import { WeekdayPicker } from "./weekday-picker";
import { DaySchedulesFields, FREQUENCY_OPTIONS, intervalPreview, SessionDatesField } from "./rhythm-fields";
import { recurrenceFormNotices, type FormPrescription } from "../_lib/status";
import { submitWithoutReset } from "./form-submit";
import { ErrorFocus } from "@/components/ui/error-focus";
import { FormFooter } from "@/components/ui/form-footer";
import { Notice } from "@/components/ui/notice";

export type RecurrenceFormInitial = {
  facilityId: string;
  prescriptionId: string;
  label: string;
  /** « Fréquence » : "1" … "8" (every N weeks) or "dates". */
  frequency: string;
  /** Explicit session dates, one per line (JJ/MM/AAAA). */
  sessionDates: string;
  weekdays: string[];
  appointmentTime: string;
  sessionMinutes: string;
  legs: string;
  startDate: string;
  endDate: string;
  notes: string;
  /** A weekday's own time ("HH:MM") and session length (minutes), keyed by ISO weekday; "" or absent: the common ones. */
  dayTimes: Record<string, string>;
  daySessions: Record<string, string>;
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
  const value = (key: keyof Omit<RecurrenceFormInitial, "weekdays" | "dayTimes" | "daySessions">) => echoed(state, key, initial[key]);

  const [weekdays, setWeekdays] = useState<Set<string>>(() => new Set(echoedList(state, "weekdays", initial.weekdays)));
  const [prescriptionId, setPrescriptionId] = useState(value("prescriptionId"));
  const [startDate, setStartDate] = useState(value("startDate"));
  const [endDate, setEndDate] = useState(value("endDate"));
  const [appointmentTime, setAppointmentTime] = useState(value("appointmentTime"));
  const [sessionMinutes, setSessionMinutes] = useState(value("sessionMinutes"));
  const [legs, setLegs] = useState(value("legs"));
  const [frequency, setFrequency] = useState(value("frequency") || "1");
  const [sessionDates, setSessionDates] = useState(value("sessionDates"));

  // Explicit dates: the weekdays and the period are theirs.
  const byDates = frequency === DATES_FREQUENCY;
  const typedDates = parseSessionDates(sessionDates);
  const datesPeriod =
    byDates && typedDates.invalid.length === 0 && typedDates.dates.length > 0
      ? { startDate: typedDates.dates[0] ?? "", endDate: typedDates.dates.at(-1) ?? "" }
      : null;
  const rhythmWeekdays = byDates ? weekdaysOfDates(typedDates.dates) : [...weekdays].map(Number).sort((a, b) => a - b);
  const period = byDates ? datesPeriod : { startDate, endDate };

  const prescription = prescriptions.find((p) => p.id === prescriptionId) ?? null;
  const validityNotices =
    prescription && period && isIsoDate(period.startDate) && (period.endDate === "" || isIsoDate(period.endDate))
      ? recurrenceFormNotices({ startDate: period.startDate, endDate: period.endDate === "" ? null : period.endDate }, prescription, todayIso)
      : [];
  const every = byDates ? null : intervalPreview(rhythmWeekdays, Number(frequency), startDate, todayIso);
  const ownValue = (field: (day: number) => string) =>
    Object.fromEntries(
      [1, 2, 3, 4, 5, 6, 7].map((day) => {
        const key = String(day);
        const initialValue = (field === dayTimeField ? initial.dayTimes : initial.daySessions)[key] ?? "";
        return [key, echoed(state, field(day), initialValue)];
      }),
    );

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
        <Field
          label="Fréquence"
          htmlFor="frequency"
          error={errors.frequency}
          hint={
            byDates
              ? "Les séances n'ont lieu qu'aux dates saisies (cure de chimiothérapie, série de séances)."
              : every
                ? `À partir de la semaine du début\u00a0; prochaines séances\u00a0: ${every}.`
                : frequency !== "1"
                  ? "Comptée à partir de la semaine de la date de début."
                  : undefined
          }
          className="sm:max-w-sm"
        >
          <Select
            id="frequency"
            name="frequency"
            value={frequency}
            onChange={(e) => setFrequency(e.target.value)}
            aria-invalid={errors.frequency ? true : undefined}
          >
            {FREQUENCY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        {byDates ? (
          <SessionDatesField value={sessionDates} onChange={setSessionDates} error={errors.sessionDates} todayIso={todayIso} />
        ) : (
          <WeekdayPicker value={weekdays} onChange={setWeekdays} error={errors.weekdays} />
        )}

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
        <DaySchedulesFields
          weekdays={rhythmWeekdays}
          dayTimes={ownValue(dayTimeField)}
          daySessions={ownValue(daySessionField)}
          errors={errors}
          commonTime={appointmentTime}
          commonSession={sessionMinutes}
        />
      </Fieldset>

      {byDates ? (
        validityNotices.length > 0 ? (
          <div className="space-y-2">
            {validityNotices.map((notice) => (
              <Notice size="sm" key={notice.text} tone={notice.tone}>
                {notice.text}
              </Notice>
            ))}
          </div>
        ) : null
      ) : (
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
      )}

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
