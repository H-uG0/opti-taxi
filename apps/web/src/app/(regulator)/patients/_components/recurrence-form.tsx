"use client";

import { useActionState, useState } from "react";
import { LinkButton } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Field, Fieldset, FormMessage, Input, Select } from "@/components/ui/form";
import { RECURRENCE_LEGS_LABELS } from "@/lib/labels";
import { formatDuration, formatMinute, isIsoDate, parseMinute, WEEKDAY_LABELS, WEEKDAY_SHORT } from "@/lib/time";
import { echoed, echoedList, INITIAL_FORM_STATE, type FormState } from "../_lib/form-state";
import { ISO_WEEKDAYS, MAX_SESSION_MINUTES, RECURRENCE_LEGS } from "../_lib/options";
import { recurrenceFormNotices } from "../_lib/status";
import { FormSubmitButton, submitWithoutReset } from "./form-submit";
import { Warning } from "./warning";

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
};

export type FacilityOption = { id: string; name: string; city: string; active: boolean };
export type PrescriptionOption = { id: string; label: string; validFrom: string; validTo: string };

const PRESETS: { label: string; days: number[] }[] = [
  { label: "Lun Mer Ven", days: [1, 3, 5] },
  { label: "Mar Jeu Sam", days: [2, 4, 6] },
  { label: "Lun → Ven", days: [1, 2, 3, 4, 5] },
];

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
  const [state, formAction, isPending] = useActionState(action, INITIAL_FORM_STATE);
  const errors = state.fieldErrors;
  const value = (key: keyof Omit<RecurrenceFormInitial, "weekdays">) => echoed(state, key, initial[key]);

  const [weekdays, setWeekdays] = useState<Set<string>>(() => new Set(echoedList(state, "weekdays", initial.weekdays)));
  const [prescriptionId, setPrescriptionId] = useState(value("prescriptionId"));
  const [startDate, setStartDate] = useState(value("startDate"));
  const [endDate, setEndDate] = useState(value("endDate"));
  const [appointmentTime, setAppointmentTime] = useState(value("appointmentTime"));
  const [sessionMinutes, setSessionMinutes] = useState(value("sessionMinutes"));
  const [legs, setLegs] = useState(value("legs"));

  const toggleDay = (day: string, checked: boolean) =>
    setWeekdays((current) => {
      const next = new Set(current);
      if (checked) next.add(day);
      else next.delete(day);
      return next;
    });

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
        <Field label="Libellé" htmlFor="label" error={errors.label} hint="Facultatif — ex. Dialyse, Radiothérapie">
          <Input
            id="label"
            name="label"
            defaultValue={value("label")}
            maxLength={80}
            autoComplete="off"
            aria-invalid={errors.label ? true : undefined}
          />
        </Field>
      </Fieldset>

      <Fieldset legend="Rythme et horaires">
        <fieldset aria-describedby={errors.weekdays ? "weekdays-error" : undefined}>
          <legend className="mb-2 block text-sm font-medium text-slate-700">Jours de séance</legend>
          <div className="flex flex-wrap gap-2">
            {ISO_WEEKDAYS.map((day) => {
              const key = String(day);
              const checked = weekdays.has(key);
              return (
                <label
                  key={day}
                  title={WEEKDAY_LABELS[day]}
                  className={cn(
                    "inline-flex h-9 min-w-14 cursor-pointer items-center justify-center gap-1.5 rounded-md border px-2.5 text-sm font-medium transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-brand-600",
                    checked
                      ? "border-brand-600 bg-brand-50 text-brand-800"
                      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
                  )}
                >
                  <input
                    type="checkbox"
                    name="weekdays"
                    value={key}
                    checked={checked}
                    onChange={(e) => toggleDay(key, e.target.checked)}
                    className="sr-only"
                  />
                  {WEEKDAY_SHORT[day]}
                  <span className="sr-only">{WEEKDAY_LABELS[day]}</span>
                </label>
              );
            })}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span>Raccourcis :</span>
            {PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => setWeekdays(new Set(preset.days.map(String)))}
                className="rounded px-1.5 py-0.5 font-medium text-brand-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600"
              >
                {preset.label}
              </button>
            ))}
          </div>
          {errors.weekdays ? (
            <p id="weekdays-error" className="mt-1 text-xs font-medium text-red-600">
              {errors.weekdays[0]}
            </p>
          ) : null}
        </fieldset>

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
                ? `Retour : prise en charge à partir de ${formatMinute(readyMinute)}`
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
          <Field label="Date de fin" htmlFor="endDate" error={errors.endDate} hint="Facultative — vide : sans fin prévue">
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
          <Warning key={notice.text} tone={notice.tone}>
            {notice.text}
          </Warning>
        ))}
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
