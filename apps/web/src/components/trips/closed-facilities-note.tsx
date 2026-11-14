"use client";

import { useActionState } from "react";
import Link from "next/link";
import { CalendarX2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { ConfirmPanel, useConfirmStep } from "@/components/ui/confirm-action";
import { INITIAL_ACTION_RESULT } from "@/lib/forms";
import type { ClosedFacilityLine } from "@/lib/trips/closed-facilities";
import { cancelClosedFacilityTrips } from "@/app/(regulator)/courses/closed-facility-actions";

export type { ClosedFacilityLine };

const courses = (count: number) => (count === 1 ? "1 course" : `${count} courses`);

/** A cancel button and its question, posting the date and the trips shown (`tripIds`): never one the page did not show. */
function CancelTripsForm({
  date,
  tripIds,
  label,
  ariaLabel,
  question,
  confirmLabel,
  formAction,
  pending,
}: {
  date: string;
  tripIds: readonly string[];
  label: string;
  ariaLabel?: string;
  question: string;
  confirmLabel: string;
  formAction: (formData: FormData) => void;
  pending: boolean;
}) {
  const { open, triggerRef, ask, close } = useConfirmStep();
  return (
    <form
      action={(formData) => {
        close();
        formAction(formData);
      }}
    >
      <input type="hidden" name="date" value={date} />
      {tripIds.map((id) => (
        <input key={id} type="hidden" name="tripId" value={id} />
      ))}
      {open ? (
        <ConfirmPanel
          question={question}
          confirmLabel={confirmLabel}
          keepLabel="Garder les courses"
          onKeep={close}
          className="max-w-xl bg-white"
        />
      ) : (
        <Button
          ref={triggerRef}
          variant="secondary"
          size="sm"
          className="text-red-700 hover:bg-red-50"
          onClick={ask}
          disabled={pending}
          aria-label={ariaLabel}
        >
          {label}
        </Button>
      )}
    </form>
  );
}

/**
 * « Jour férié (Armistice 1918) : N courses vers des établissements fermés » :
 * the day's open trips to a facility that does not work public holidays (or is
 * under a dated closure), by facility, each linked to its record, with
 * « Annuler ces N courses » — and, with several facilities, the trips of one
 * facility only (one that works that holiday keeps its trips). Only the trips
 * shown are cancelled. Shown on Courses and on the planning of that date.
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
  const [state, formAction, pending] = useActionState(cancelClosedFacilityTrips, INITIAL_ACTION_RESULT);
  const total = lines.reduce((sum, l) => sum + l.count, 0);
  if (total === 0 && !state.message) return null;
  const holidayLines = lines.filter((l) => l.holiday);
  const question = (count: number, where: string) =>
    `Annuler ${count === 1 ? "cette course" : `ces ${count} courses`}${where} (motif «\u202fÉtablissement fermé\u202f»)\u202f? Celles déjà dans une tournée en seront retirées.`;
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
            <ul className="space-y-1">
              {lines.map((line) => (
                <li key={line.facilityId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span>
                    <Link href={`/etablissements/${line.facilityId}#calendrier`} className="font-medium underline underline-offset-2">
                      {line.name}
                    </Link>{" "}
                    ({line.reason})&nbsp;: {courses(line.count)}
                  </span>
                  {lines.length > 1 ? (
                    <CancelTripsForm
                      date={date}
                      tripIds={line.tripIds}
                      label={line.count === 1 ? "Annuler sa course" : `Annuler ses ${line.count} courses`}
                      ariaLabel={`Annuler ${line.count === 1 ? "la course" : `les ${line.count} courses`} vers ${line.name}`}
                      question={question(line.count, ` vers ${line.name}`)}
                      confirmLabel={line.count === 1 ? "Oui, annuler la course" : `Oui, annuler les ${line.count} courses`}
                      formAction={formAction}
                      pending={pending}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
            {holidayLines.length > 0 ? (
              <p className="text-xs">
                {lines.length === 1
                  ? "Ouvert ce jour-là ? Gardez ses courses. Ouvert tous les jours fériés ? Cochez « Ouvert les jours fériés » sur sa fiche : ses courses ne seront plus signalées."
                  : "Un établissement travaille ce jour férié ? Annulez seulement les courses des autres. Ouvert tous les jours fériés ? Cochez « Ouvert les jours fériés » sur sa fiche : ses courses ne seront plus signalées."}
              </p>
            ) : null}
            <div className="pt-1">
              <CancelTripsForm
                date={date}
                tripIds={lines.flatMap((l) => l.tripIds)}
                label={total === 1 ? "Annuler cette course" : `Annuler ces ${total} courses`}
                question={question(total, "")}
                confirmLabel={total === 1 ? "Oui, annuler la course" : `Oui, annuler les ${total} courses`}
                formAction={formAction}
                pending={pending}
              />
            </div>
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
