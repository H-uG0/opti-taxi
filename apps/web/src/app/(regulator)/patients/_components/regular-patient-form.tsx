"use client";

import { useActionState, useState } from "react";
import type { FacilityType, Mobility, PrescribedMode } from "@prisma/client";
import { EMPTY_ADDRESS } from "@/components/address/address-utils";
import { ErrorFocus } from "@/components/ui/error-focus";
import { Checkbox, Field, Fieldset, FormMessage, Input, Select } from "@/components/ui/form";
import { FormFooter } from "@/components/ui/form-footer";
import { Notice } from "@/components/ui/notice";
import { echoed, echoedCheckbox, echoedList, IDLE_STATE, refusalKey } from "@/lib/forms";
import { MOBILITY_LABELS, PRESCRIBED_MODE_LABELS, RECURRENCE_LEGS_LABELS, SHARING_SCOPE_LABELS } from "@/lib/labels";
import { formatDuration, formatMinute, formatShortDate, isIsoDate, parseMinute } from "@/lib/time";
import { defaultMode, defaultSharing, VALIDITY_SHORTCUTS, validityEnd, withCareDefaults } from "../_lib/care-defaults";
import { MAX_SESSION_MINUTES, PRESCRIBED_MODES, RECURRENCE_LEGS, SHARING_SCOPES } from "../_lib/options";
import type { PatientFormState } from "../_lib/patient-form-state";
import { mobilityModeWarning } from "../_lib/status";
import { submitWithoutReset } from "./form-submit";
import { createAnywayHandler, PatientFields, SimilarMessage, SimilarPatients } from "./patient-form";
import { RecurrenceNotesField } from "./recurrence-form";
import { WeekdayPicker } from "./weekday-picker";

export type RegularFacilityOption = { id: string; name: string; city: string; type: FacilityType; typeLabel: string };

/**
 * « Nouveau patient régulier »: identity and home, the prescription and the
 * rhythm of care on one screen, saved together; the trips of the coming days
 * are created at once. The rhythm follows the facility chosen (dialysis:
 * Monday, Wednesday, Friday, 4 h; radiotherapy: Monday to Friday) as long as
 * the regulator has not typed it.
 */
export function RegularPatientForm({
  action,
  facilities,
  todayIso,
  geocoderEnabled,
  horizonEnd,
}: {
  action: (prev: PatientFormState, formData: FormData) => Promise<PatientFormState>;
  facilities: RegularFacilityOption[];
  todayIso: string;
  geocoderEnabled: boolean;
  /** Last day whose trips are created at once (tomorrow to D+N). */
  horizonEnd: string;
}) {
  const [state, formAction, isPending] = useActionState<PatientFormState, FormData>(action, IDLE_STATE);
  const errors = state.fieldErrors;
  const similar = state.similar ?? [];
  const value = (key: string, initial = "") => echoed(state, key, initial);

  const [mobility, setMobility] = useState<Mobility>(() => (value("mobility", "SEATED") as Mobility) || "SEATED");
  const [mode, setMode] = useState<PrescribedMode>(() => (value("mode") as PrescribedMode) || defaultMode(mobility));
  const [modeTouched, setModeTouched] = useState(value("mode") !== "");
  const [sharing, setSharing] = useState(() => value("sharing") || defaultSharing(mode));
  const [validFrom, setValidFrom] = useState(value("validFrom", todayIso));
  const [validTo, setValidTo] = useState(value("validTo"));
  const [startDate, setStartDate] = useState(value("startDate", todayIso));
  const [startTouched, setStartTouched] = useState(value("startDate") !== "");
  const [facilityId, setFacilityId] = useState(value("facilityId"));
  const [label, setLabel] = useState(value("label"));
  const [weekdays, setWeekdays] = useState<Set<string>>(() => new Set(echoedList(state, "weekdays", [])));
  const [appointmentTime, setAppointmentTime] = useState(value("appointmentTime"));
  const [sessionMinutes, setSessionMinutes] = useState(value("sessionMinutes"));
  const [legs, setLegs] = useState(value("legs", "BOTH"));

  const facility = facilities.find((f) => f.id === facilityId) ?? null;
  const chooseFacility = (id: string) => {
    const next = facilities.find((f) => f.id === id) ?? null;
    const rhythm = withCareDefaults({ label, weekdays: [...weekdays], sessionMinutes }, next?.type ?? null, facility?.type ?? null);
    setFacilityId(id);
    setLabel(rhythm.label);
    setWeekdays(new Set(rhythm.weekdays));
    setSessionMinutes(rhythm.sessionMinutes);
  };
  const changeMobility = (next: string) => {
    const m = next as Mobility;
    setMobility(m);
    // The prescribed mode follows the mobility until chosen by hand (a lying patient goes by ambulance).
    if (!modeTouched) {
      setMode(defaultMode(m));
      setSharing(defaultSharing(defaultMode(m)));
    }
  };
  const changeValidFrom = (next: string) => {
    setValidFrom(next);
    if (!startTouched && isIsoDate(next)) setStartDate(next > todayIso ? next : todayIso);
  };

  const isAmbulance = mode === "AMBULANCE";
  const modeWarning = mobilityModeWarning(mobility, mode);
  const appointment = parseMinute(appointmentTime);
  const session = /^\d+$/.test(sessionMinutes.trim()) ? Number(sessionMinutes) : null;
  const readyMinute = appointment !== null && session !== null ? appointment + session : null;
  const createAnyway = createAnywayHandler(formAction);

  return (
    <form action={formAction} onSubmit={submitWithoutReset(formAction)} className="max-w-3xl space-y-5" noValidate>
      {similar.length > 0 ? <SimilarMessage message={state.message} /> : <FormMessage>{state.message}</FormMessage>}

      <PatientFields
        value={(key) => value(key, key === "mobility" ? "SEATED" : "")}
        address={EMPTY_ADDRESS}
        errors={errors}
        geocoderEnabled={geocoderEnabled}
        onMobilityChange={changeMobility}
      />

      <Fieldset legend="Prescription médicale de transport">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Mode prescrit" htmlFor="mode" error={errors.mode} hint={`Mobilité : ${MOBILITY_LABELS[mobility].toLowerCase()}`}>
            <Select
              id="mode"
              name="mode"
              value={mode}
              onChange={(e) => {
                const next = e.target.value as PrescribedMode;
                setMode(next);
                setModeTouched(true);
                if (next === "AMBULANCE") setSharing("NONE");
              }}
              aria-invalid={errors.mode ? true : undefined}
            >
              {PRESCRIBED_MODES.map((m) => (
                <option key={m} value={m}>
                  {PRESCRIBED_MODE_LABELS[m]}
                </option>
              ))}
            </Select>
          </Field>
          {/* Outside the Field: its only child is the Select, which it links to the hint and the error. */}
          {isAmbulance ? <input type="hidden" name="sharing" value="NONE" /> : null}
          <Field
            label="Transport partagé autorisé"
            htmlFor="sharing"
            error={errors.sharing}
            hint={isAmbulance ? "Sans objet en ambulance (un seul patient à bord)" : "Ce que la prescription autorise (décret 2025-202)"}
          >
            <Select
              id="sharing"
              name={isAmbulance ? undefined : "sharing"}
              value={isAmbulance ? "NONE" : sharing}
              onChange={(e) => setSharing(e.target.value)}
              disabled={isAmbulance}
              aria-invalid={errors.sharing ? true : undefined}
            >
              {SHARING_SCOPES.map((scope) => (
                <option key={scope} value={scope}>
                  {SHARING_SCOPE_LABELS[scope]}
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
              value={validFrom}
              onChange={(e) => changeValidFrom(e.target.value)}
              className="tabular"
              aria-invalid={errors.validFrom ? true : undefined}
            />
          </Field>
          <div className="space-y-1">
            <Field label="Fin de validité" htmlFor="validTo" error={errors.validTo}>
              <Input
                id="validTo"
                name="validTo"
                type="date"
                min={isIsoDate(validFrom) ? validFrom : undefined}
                value={validTo}
                onChange={(e) => setValidTo(e.target.value)}
                className="tabular"
                aria-invalid={errors.validTo ? true : undefined}
              />
            </Field>
            {isIsoDate(validFrom) ? (
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span>Durée&nbsp;:</span>
                {VALIDITY_SHORTCUTS.map((shortcut) => (
                  <button
                    key={shortcut.label}
                    type="button"
                    onClick={() => setValidTo(validityEnd(validFrom, shortcut.months))}
                    className="rounded px-1.5 py-0.5 font-medium text-brand-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600"
                  >
                    {shortcut.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
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
          <div className="sm:pt-7">
            <Checkbox
              name="isSeries"
              defaultChecked={echoedCheckbox(state, "isSeries", true)}
              label="Prescription en série (transports répétés pour un même traitement)"
            />
          </div>
        </div>
      </Fieldset>

      <Fieldset legend="Lieu de soins et rythme">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Établissement"
            htmlFor="facilityId"
            error={errors.facilityId}
            hint={facility ? facility.typeLabel : "Le rythme habituel est proposé selon le type (dialyse, radiothérapie)."}
          >
            <Select
              id="facilityId"
              name="facilityId"
              value={facilityId}
              onChange={(e) => chooseFacility(e.target.value)}
              aria-invalid={errors.facilityId ? true : undefined}
            >
              <option value="">— Choisir —</option>
              {facilities.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name} ({f.city})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Libellé (facultatif)" htmlFor="label" error={errors.label} hint="Ex. Dialyse, Radiothérapie">
            <Input
              id="label"
              name="label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={80}
              autoComplete="off"
              aria-invalid={errors.label ? true : undefined}
            />
          </Field>
        </div>

        <WeekdayPicker value={weekdays} onChange={setWeekdays} error={errors.weekdays} />

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Heure du rendez-vous" htmlFor="appointmentTime" error={errors.appointmentTime}>
            <Input
              id="appointmentTime"
              name="appointmentTime"
              type="time"
              value={appointmentTime}
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
              value={sessionMinutes}
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
                ? `Retour : prise en charge à partir de ${formatMinute(readyMinute)}`
                : undefined
            }
          >
            <Select id="legs" name="legs" value={legs} onChange={(e) => setLegs(e.target.value)} aria-invalid={errors.legs ? true : undefined}>
              {RECURRENCE_LEGS.map((l) => (
                <option key={l} value={l}>
                  {RECURRENCE_LEGS_LABELS[l]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Début des séances" htmlFor="startDate" error={errors.startDate} hint="Pendant la validité de la prescription.">
            <Input
              id="startDate"
              name="startDate"
              type="date"
              value={startDate}
              onChange={(e) => {
                setStartDate(e.target.value);
                setStartTouched(true);
              }}
              className="tabular"
              aria-invalid={errors.startDate ? true : undefined}
            />
          </Field>
          <Field label="Fin des séances" htmlFor="endDate" error={errors.endDate} hint="Facultative — vide&nbsp;: sans fin prévue">
            <Input
              id="endDate"
              name="endDate"
              type="date"
              min={isIsoDate(startDate) ? startDate : undefined}
              defaultValue={value("endDate")}
              className="tabular"
              aria-invalid={errors.endDate ? true : undefined}
            />
          </Field>
        </div>
        <RecurrenceNotesField defaultValue={value("notes")} error={errors.notes} />
      </Fieldset>

      <Notice size="sm" tone="info">
        À l&apos;enregistrement, les courses sont créées de demain au {formatShortDate(horizonEnd)} (une séance d&apos;aujourd&apos;hui se
        crée avec «&#x202F;Nouvelle course&#x202F;»)&#x202F;; la fiche dit si une journée concernée est déjà planifiée.
      </Notice>

      {similar.length > 0 ? <SimilarPatients similar={similar} pending={isPending} onCreateAnyway={createAnyway} /> : null}

      <FormFooter cancelHref="/patients" submitLabel="Créer le patient et ses courses" pending={isPending} />
      <ErrorFocus refusal={similar.length > 0 ? null : refusalKey(state)} />
    </form>
  );
}
