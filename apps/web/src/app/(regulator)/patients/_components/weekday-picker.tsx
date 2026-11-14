"use client";

import { cn } from "@/components/ui/cn";
import { WEEKDAY_LABELS, WEEKDAY_SHORT } from "@/lib/time";
import { ISO_WEEKDAYS } from "../_lib/options";

/** Shortcuts under the days: the usual rhythms of dialysis and of daily treatments. */
export const WEEKDAY_PRESETS: readonly { label: string; days: readonly number[] }[] = [
  { label: "Lun Mer Ven", days: [1, 3, 5] },
  { label: "Mar Jeu Sam", days: [2, 4, 6] },
  { label: "Lun → Ven", days: [1, 2, 3, 4, 5] },
];

/**
 * « Jours de séance »: one checkbox per weekday (posted as `name`, ISO 1 = lundi), drawn as toggle chips, with
 * the usual rhythms as shortcuts. Controlled: `value` holds the ticked days as strings.
 */
export function WeekdayPicker({
  name = "weekdays",
  value,
  onChange,
  error,
  legend = "Jours de séance",
}: {
  name?: string;
  value: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  error?: string;
  legend?: string;
}) {
  const errorId = `${name}-error`;
  const toggle = (day: string, checked: boolean) => {
    const next = new Set(value);
    if (checked) next.add(day);
    else next.delete(day);
    onChange(next);
  };
  return (
    <fieldset aria-describedby={error ? errorId : undefined}>
      <legend className="mb-2 block text-sm font-medium text-slate-700">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {ISO_WEEKDAYS.map((day) => {
          const key = String(day);
          const checked = value.has(key);
          return (
            <label
              key={day}
              title={WEEKDAY_LABELS[day]}
              className={cn(
                "inline-flex h-9 min-w-14 cursor-pointer items-center justify-center gap-1.5 rounded-md border px-2.5 text-sm font-medium transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-brand-600",
                checked ? "border-brand-600 bg-brand-50 text-brand-800" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
              )}
            >
              <input
                type="checkbox"
                name={name}
                value={key}
                checked={checked}
                onChange={(e) => toggle(key, e.target.checked)}
                className="sr-only"
              />
              {WEEKDAY_SHORT[day]}
              <span className="sr-only">{WEEKDAY_LABELS[day]}</span>
            </label>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <span>Raccourcis&nbsp;:</span>
        {WEEKDAY_PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => onChange(new Set(preset.days.map(String)))}
            className="rounded px-1.5 py-0.5 font-medium text-brand-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600"
          >
            {preset.label}
          </button>
        ))}
      </div>
      {error ? (
        <p id={errorId} className="mt-1 text-xs font-medium text-red-600">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
