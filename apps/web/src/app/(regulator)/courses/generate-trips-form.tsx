"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { CalendarPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { generateWeekTrips } from "./actions";
import { INITIAL_ACTION_RESULT } from "./trip-form";

/** "Générer les courses" for the week of the selected date, or the next one. Idempotent on the server. */
export function GenerateTripsForm({
  weekStart,
  nextWeekStart,
  weekLabel,
}: {
  weekStart: string;
  nextWeekStart: string;
  weekLabel: string;
}) {
  const [state, action] = useActionState(generateWeekTrips, INITIAL_ACTION_RESULT);

  return (
    <form action={action} className="flex flex-col items-start gap-1.5 sm:items-end">
      <div className="flex flex-wrap items-center gap-2">
        <WeekButton value={weekStart} variant="primary" title={`Créer les courses régulières de la semaine du ${weekLabel}`}>
          <CalendarPlus aria-hidden className="size-4" />
          Générer les courses de la semaine
        </WeekButton>
        <WeekButton value={nextWeekStart} variant="secondary" title="Créer les courses régulières de la semaine suivante">
          Semaine suivante
        </WeekButton>
      </div>
      <p className="text-xs text-slate-500">
        Semaine du {weekLabel} — sans doublon : les courses déjà créées ne sont pas modifiées.
      </p>
      {state.message ? (
        <p
          role={state.ok ? "status" : "alert"}
          className={cn(
            "rounded-md border px-2.5 py-1.5 text-sm",
            state.ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800",
          )}
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

function WeekButton({
  value,
  variant,
  title,
  children,
}: {
  value: string;
  variant: "primary" | "secondary";
  title: string;
  children: React.ReactNode;
}) {
  const { pending, data } = useFormStatus();
  const mine = pending && data?.get("weekStart") === value;
  return (
    <Button type="submit" name="weekStart" value={value} variant={variant} disabled={pending} aria-busy={mine} title={title}>
      {mine ? "Génération…" : children}
    </Button>
  );
}
