"use client";

import { useActionState } from "react";
import Link from "next/link";
import { CalendarX2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { ConfirmPanel, useConfirmStep } from "@/components/ui/confirm-action";
import { INITIAL_ACTION_RESULT } from "@/lib/forms";
import { cancelClosedFacilityTrips } from "@/app/(regulator)/courses/closed-facility-actions";

export type ClosedFacilityLine = { facilityId: string; name: string; reason: string; count: number };

/**
 * « Jour férié (Armistice 1918) : N courses vers des établissements fermés » :
 * the day's open trips to a facility that does not work public holidays (or is
 * under a dated closure), by facility, each linked to its record (« ouvert les
 * jours fériés »), with « Annuler ces N courses ». Shown on Courses and on the
 * planning of that date.
 */
export function ClosedFacilitiesNote({
  date,
  title,
  lines,
  className,
}: {
  date: string;
  title: string;
  lines: ClosedFacilityLine[];
  className?: string;
}) {
  const [state, formAction] = useActionState(cancelClosedFacilityTrips, INITIAL_ACTION_RESULT);
  const { open, triggerRef, ask, close } = useConfirmStep();
  const total = lines.reduce((sum, l) => sum + l.count, 0);
  if (total === 0 && !state.message) return null;
  return (
    <div
      role="note"
      className={cn("flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950", className)}
    >
      <CalendarX2 aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-700" />
      <div className="min-w-0 flex-1 space-y-1.5">
        {total > 0 ? (
          <>
            <p className="font-semibold">{title}</p>
            <ul className="space-y-0.5">
              {lines.map((line) => (
                <li key={line.facilityId}>
                  <Link href={`/etablissements/${line.facilityId}#calendrier`} className="font-medium underline underline-offset-2">
                    {line.name}
                  </Link>{" "}
                  ({line.reason})&nbsp;: {line.count === 1 ? "1 course" : `${line.count} courses`}
                </li>
              ))}
            </ul>
            <p className="text-xs">
              Ouvert ce jour-là&#x202F;? Cochez «&#x202F;Ouvert les jours fériés&#x202F;» sur sa fiche&nbsp;: ses courses ne seront
              plus signalées.
            </p>
            <form
              action={(formData) => {
                close();
                formAction(formData);
              }}
              className="pt-1"
            >
              <input type="hidden" name="date" value={date} />
              {open ? (
                <ConfirmPanel
                  question={`Annuler ${total === 1 ? "cette course" : `ces ${total} courses`} (motif « Établissement fermé ») ? Celles déjà dans une tournée en seront retirées.`}
                  confirmLabel={total === 1 ? "Oui, annuler la course" : `Oui, annuler les ${total} courses`}
                  keepLabel="Garder les courses"
                  onKeep={close}
                  className="max-w-xl bg-white"
                />
              ) : (
                <Button ref={triggerRef} variant="secondary" size="sm" className="text-red-700 hover:bg-red-50" onClick={ask}>
                  {total === 1 ? "Annuler cette course" : `Annuler ces ${total} courses`}
                </Button>
              )}
            </form>
          </>
        ) : null}
        {state.message ? (
          <p role={state.ok ? "status" : "alert"} className={cn("text-xs font-medium", state.ok ? "text-emerald-800" : "text-red-700")}>
            {state.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}
