"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import { WEEKDAY_LABELS } from "@/lib/time";
import { hoursCloseField, hoursOpenField } from "../_lib/hours-fields";

export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

type DayHours = { open: string; close: string };

/**
 * « Horaires d'accueil » : opening and closing time per weekday (both, or
 * neither: no hours that day), with « Recopier le lundi du mardi au vendredi ».
 */
export function OpeningHoursFields({ initial, errors }: { initial: Record<string, DayHours>; errors: Record<string, string> }) {
  const [hours, setHours] = useState<Record<string, DayHours>>(initial);
  const set = (day: number, part: keyof DayHours, value: string) =>
    setHours((previous) => ({ ...previous, [String(day)]: { ...(previous[String(day)] ?? { open: "", close: "" }), [part]: value } }));
  const monday = hours["1"] ?? { open: "", close: "" };
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 block text-sm font-medium text-slate-700">Horaires d&apos;accueil (facultatif)</legend>
      <p className="text-xs text-slate-600">
        L&apos;optimisation fait arriver les patients pendant l&apos;accueil et les reprend avant la fermeture. Un jour sans
        horaire n&apos;a pas de contrainte.
      </p>
      <div className="grid max-w-xl gap-x-3 gap-y-2 sm:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)]">
        <span className="hidden text-xs font-medium text-slate-500 sm:block" aria-hidden />
        <span className="hidden text-xs font-medium text-slate-500 sm:block" aria-hidden>
          Ouverture
        </span>
        <span className="hidden text-xs font-medium text-slate-500 sm:block" aria-hidden>
          Fermeture
        </span>
        {WEEKDAYS.map((day) => {
          const label = WEEKDAY_LABELS[day] ?? String(day);
          const openName = hoursOpenField(day);
          const closeName = hoursCloseField(day);
          const error = errors[openName] ?? errors[closeName];
          const errorId = `${openName}-error`;
          const value = hours[String(day)] ?? { open: "", close: "" };
          return (
            <div key={day} className="contents">
              <span className="pt-2 text-sm text-slate-800">{label}</span>
              <Input
                name={openName}
                type="time"
                value={value.open}
                onChange={(e) => set(day, "open", e.target.value)}
                aria-label={`Ouverture le ${label.toLowerCase()}`}
                aria-invalid={errors[openName] ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                className="tabular"
              />
              <Input
                name={closeName}
                type="time"
                value={value.close}
                onChange={(e) => set(day, "close", e.target.value)}
                aria-label={`Fermeture le ${label.toLowerCase()}`}
                aria-invalid={errors[closeName] ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                className="tabular"
              />
              {error ? (
                <p id={errorId} className="text-xs font-medium text-red-700 sm:col-span-3 sm:col-start-2">
                  {error}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      <Button
        variant="ghost"
        size="sm"
        disabled={monday.open === "" && monday.close === ""}
        onClick={() => setHours((previous) => ({ ...previous, ...Object.fromEntries([2, 3, 4, 5].map((d) => [String(d), { ...monday }])) }))}
      >
        Recopier le lundi du mardi au vendredi
      </Button>
    </fieldset>
  );
}
