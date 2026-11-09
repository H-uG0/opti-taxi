"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { CalendarPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { formatShortDate } from "@/lib/time";
import { generateWeekTrips, type GenerationResult } from "./actions";

const INITIAL: GenerationResult = { ok: false, message: null, skipped: [] };

/**
 * "Générer les courses" for the week of the selected date, or the next one,
 * from tomorrow at the earliest. Idempotent on the server. The trips of the
 * coming days are completed on their own (horizon): the button is for a week
 * beyond it, or to see which recurrences have no valid prescription.
 */
export function GenerateTripsForm({
  weekStart,
  nextWeekStart,
  weekLabel,
  horizonEnd,
}: {
  weekStart: string;
  nextWeekStart: string;
  weekLabel: string;
  /** Last day completed on its own (D+N). */
  horizonEnd: string;
}) {
  const [state, action] = useActionState(generateWeekTrips, INITIAL);

  return (
    <form action={action} className="flex max-w-xl flex-col items-start gap-1.5 sm:items-end">
      <div className="flex flex-wrap items-center gap-2">
        <WeekButton value={weekStart} variant="secondary" title={`Créer les courses régulières de la semaine du ${weekLabel}, à partir de demain`}>
          <CalendarPlus aria-hidden className="size-4" />
          Générer les courses de la semaine
        </WeekButton>
        <WeekButton value={nextWeekStart} variant="secondary" title="Créer les courses régulières de la semaine suivante">
          Semaine suivante
        </WeekButton>
      </div>
      <p className="text-xs text-slate-500 sm:text-right">
        Les courses régulières sont créées d&apos;office jusqu&apos;au {formatShortDate(horizonEnd)} ; sans doublon, jamais
        avant demain.
      </p>
      {state.message ? (
        <div
          role={state.ok ? "status" : "alert"}
          className={cn(
            "w-full rounded-md border px-2.5 py-1.5 text-sm",
            !state.ok
              ? "border-red-200 bg-red-50 text-red-800"
              : state.skipped.length > 0
                ? "border-amber-200 bg-amber-50 text-amber-900"
                : "border-emerald-200 bg-emerald-50 text-emerald-800",
          )}
        >
          <p>{state.message}</p>
          {state.skipped.length > 0 ? <SkippedList skipped={state.skipped} /> : null}
        </div>
      ) : null}
    </form>
  );
}

/** Recurrences skipped for want of a valid prescription, each with a link to the patient's prescriptions. */
function SkippedList({ skipped }: { skipped: GenerationResult["skipped"] }) {
  return (
    <div className="mt-1">
      <p className="font-medium">
        {skipped.length > 1
          ? `${skipped.length} récurrences sans prescription valide (aucune course créée) :`
          : "1 récurrence sans prescription valide (aucune course créée) :"}
      </p>
      <ul className="mt-0.5 list-disc space-y-0.5 pl-5">
        {skipped.map((r) => (
          <li key={r.recurrenceId}>
            <Link href={`/patients/${r.patientId}#prescriptions`} className="font-medium underline underline-offset-2">
              {r.patientName}
            </Link>{" "}
            — {r.label} :{" "}
            <span className="tabular">{r.dates.map((d) => formatShortDate(d).slice(0, 5)).join(", ")}</span>
          </li>
        ))}
      </ul>
    </div>
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
