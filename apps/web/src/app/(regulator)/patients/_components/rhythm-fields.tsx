"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/form";
import {
  intervalLabel,
  MAX_INTERVAL_WEEKS,
  MAX_SESSION_DATES,
  nextSessionDates,
  parseSessionDates,
  seriesDates,
  weekdaysOfDates,
} from "@/lib/domain/recurrence-rhythm";
import { formatDayDate, formatDuration, formatShortDate, isIsoDate, WEEKDAY_LABELS } from "@/lib/time";
import { DATES_FREQUENCY, dayTimeField, daySessionField, MAX_SESSION_MINUTES } from "../_lib/options";

/** « Fréquence » choices: every week to every MAX_INTERVAL_WEEKS weeks, then explicit dates. */
export const FREQUENCY_OPTIONS: readonly { value: string; label: string }[] = [
  { value: "1", label: "Chaque semaine" },
  ...Array.from({ length: MAX_INTERVAL_WEEKS - 1 }, (_, i) => {
    const label = intervalLabel(i + 2);
    return { value: String(i + 2), label: label.charAt(0).toUpperCase() + label.slice(1) };
  }),
  { value: DATES_FREQUENCY, label: "Dates précises (cycles)" },
];

/** Next sessions of a rhythm every N weeks, as the hint under « Fréquence » says them: "16/11, 30/11, 14/12". */
export function intervalPreview(weekdays: readonly number[], intervalWeeks: number, startDate: string, todayIso: string): string | null {
  if (intervalWeeks <= 1 || weekdays.length === 0 || !isIsoDate(startDate)) return null;
  const next = nextSessionDates({ weekdays, intervalWeeks, startDate, endDate: null }, todayIso, 4);
  return next.length > 0 ? next.map((d) => formatDayDate(d)).join(", ") : null;
}

/**
 * « Dates des séances » (one or more per line, JJ/MM/AAAA) and « Ajouter une
 * série » : a first session, every N days (21 for a 21-day cycle), M times. The
 * weekdays and the period of the recurrence are those of the dates.
 */
export function SessionDatesField({
  value,
  onChange,
  error,
  todayIso,
}: {
  value: string;
  onChange: (text: string) => void;
  error?: string;
  todayIso: string;
}) {
  const ids = useId();
  const [first, setFirst] = useState(todayIso);
  const [every, setEvery] = useState("21");
  const [count, setCount] = useState("6");
  const { dates, invalid } = parseSessionDates(value);
  // Why « Ajouter ces dates » added nothing (a series that cannot be built), until the series is changed.
  const [seriesError, setSeriesError] = useState<string | null>(null);
  const addSeries = () => {
    const added = seriesDates(first, Number(every), Number(count));
    if (added.length === 0) {
      setSeriesError(
        !isIsoDate(first)
          ? "Saisissez la date de la première séance."
          : "«\u202fTous les (jours)\u202f» et «\u202fNombre de séances\u202f» attendent un nombre entier, 1 au moins.",
      );
      return;
    }
    setSeriesError(null);
    const merged = [...new Set([...dates, ...added])].sort();
    onChange(merged.map(formatShortDate).join("\n"));
  };
  const changeSeries = (set: (value: string) => void) => (value: string) => {
    setSeriesError(null);
    set(value);
  };
  const seriesErrorId = seriesError ? `${ids}-series-error` : undefined;
  return (
    <div className="space-y-3">
      <Field
        label="Dates des séances"
        htmlFor="sessionDates"
        error={error}
        hint={`Une date par ligne (JJ/MM/AAAA), ${MAX_SESSION_DATES} au plus. Les jours et la période de la récurrence en découlent.`}
      >
        <Textarea
          id="sessionDates"
          name="sessionDates"
          rows={5}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="tabular max-w-xs"
          placeholder={"16/11/2026\n07/12/2026"}
          aria-invalid={error ? true : undefined}
        />
      </Field>
      {dates.length > 0 && invalid.length === 0 ? (
        <p className="tabular text-xs text-slate-600" aria-live="polite">
          {dates.length === 1
            ? `1 séance, le ${formatShortDate(dates[0] ?? "")}`
            : `${dates.length} séances, du ${formatShortDate(dates[0] ?? "")} au ${formatShortDate(dates.at(-1) ?? "")}`}{" "}
          ({weekdaysOfDates(dates)
            .map((d) => WEEKDAY_LABELS[d]?.toLowerCase())
            .join(", ")}
          )
        </p>
      ) : null}
      <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
        <p className="mb-2 text-sm font-medium text-slate-700">Ajouter une série</p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label htmlFor={`${ids}-first`} className="block text-xs font-medium text-slate-600">
              Première séance
            </label>
            <Input
              id={`${ids}-first`}
              type="date"
              value={first}
              onChange={(e) => changeSeries(setFirst)(e.target.value)}
              className="tabular"
              aria-describedby={seriesErrorId}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor={`${ids}-every`} className="block text-xs font-medium text-slate-600">
              Tous les (jours)
            </label>
            <Input
              id={`${ids}-every`}
              inputMode="numeric"
              value={every}
              onChange={(e) => changeSeries(setEvery)(e.target.value)}
              className="tabular w-24"
              aria-describedby={seriesErrorId}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor={`${ids}-count`} className="block text-xs font-medium text-slate-600">
              Nombre de séances
            </label>
            <Input
              id={`${ids}-count`}
              inputMode="numeric"
              value={count}
              onChange={(e) => changeSeries(setCount)(e.target.value)}
              className="tabular w-24"
              aria-describedby={seriesErrorId}
            />
          </div>
          <Button type="button" variant="secondary" size="sm" onClick={addSeries}>
            Ajouter ces dates
          </Button>
        </div>
        {seriesError ? (
          <p id={seriesErrorId} role="alert" className="mt-2 text-xs font-medium text-red-700">
            {seriesError}
          </p>
        ) : null}
        <p className="mt-2 text-xs text-slate-600">
          Ex. cycle de 21&nbsp;jours avec séances à J1 et J8&nbsp;: une série à partir du J1 tous les 21&nbsp;jours, puis une
          autre à partir du J8.
        </p>
      </div>
    </div>
  );
}

/**
 * « Horaire différent selon le jour » : for each day of the rhythm, its own
 * appointment time and/or session length (empty: the common ones).
 */
export function DaySchedulesFields({
  weekdays,
  dayTimes,
  daySessions,
  errors,
  commonTime,
  commonSession,
}: {
  weekdays: readonly number[];
  dayTimes: Record<string, string>;
  daySessions: Record<string, string>;
  errors: Record<string, string>;
  commonTime: string;
  commonSession: string;
}) {
  const anyOwn = weekdays.some((d) => (dayTimes[String(d)] ?? "") !== "" || (daySessions[String(d)] ?? "") !== "");
  // The common length as the rest of the form says it (« 4 h 00 »).
  const commonMinutes = /^\d+$/.test(commonSession.trim()) ? Number(commonSession.trim()) : null;
  const commonDuration = commonMinutes !== null && commonMinutes > 0 ? formatDuration(commonMinutes) : "";
  const anyError = weekdays.some((d) => errors[dayTimeField(d)] || errors[daySessionField(d)]);
  if (weekdays.length === 0) return null;
  return (
    <details className="rounded-md border border-slate-200 p-3" open={anyOwn || anyError}>
      <summary className="cursor-pointer text-sm font-medium text-slate-700">Horaire différent selon le jour (facultatif)</summary>
      <p className="mt-2 text-xs text-slate-600">
        Laissez vide pour garder l&apos;heure et la durée communes ({commonTime || "—"}
        {commonDuration ? `, ${commonDuration}` : ""}).
      </p>
      <div className="mt-3 space-y-2">
        {/* Column headings (each field keeps its own label for screen readers). */}
        <div aria-hidden className="hidden gap-3 text-xs font-medium text-slate-500 sm:grid sm:grid-cols-[6rem_minmax(0,10rem)_minmax(0,10rem)]">
          <span />
          <span>Heure du RDV</span>
          <span>Durée de séance (min)</span>
        </div>
        {weekdays.map((day) => {
          const timeName = dayTimeField(day);
          const sessionName = daySessionField(day);
          return (
            <div key={day} className="grid items-start gap-3 sm:grid-cols-[6rem_minmax(0,10rem)_minmax(0,10rem)]">
              <span className="pt-2 text-sm font-medium text-slate-800" title={WEEKDAY_LABELS[day]}>
                {WEEKDAY_LABELS[day]}
              </span>
              <Field label={<span className="sr-only">Heure du rendez-vous le {WEEKDAY_LABELS[day]?.toLowerCase()}</span>} htmlFor={timeName} error={errors[timeName]}>
                <Input
                  id={timeName}
                  name={timeName}
                  type="time"
                  defaultValue={dayTimes[String(day)] ?? ""}
                  className="tabular"
                  aria-invalid={errors[timeName] ? true : undefined}
                />
              </Field>
              <Field label={<span className="sr-only">Durée de séance le {WEEKDAY_LABELS[day]?.toLowerCase()}</span>} htmlFor={sessionName} error={errors[sessionName]}>
                <Input
                  id={sessionName}
                  name={sessionName}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={MAX_SESSION_MINUTES}
                  step={5}
                  placeholder={commonSession ? `${commonSession}\u00a0min` : "min"}
                  defaultValue={daySessions[String(day)] ?? ""}
                  className="tabular"
                  aria-invalid={errors[sessionName] ? true : undefined}
                />
              </Field>
            </div>
          );
        })}
      </div>
    </details>
  );
}
