"use client";

import { useRef, useState } from "react";
import { CheckCheck, ListPlus, LockOpen, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmPanel } from "@/components/ui/confirm-action";
import { optimizeDay, placeUnassigned, reopenDay, validateDay } from "./actions";
import { usePlanningActivity } from "./planning-activity";

export type ToolbarProps = {
  date: string;
  /** Version of the plan shown (lib/planning/version.ts): validating a plan changed since is refused. */
  version: string;
  optimizeLabel: string;
  /** Why optimizing is not possible right now, or null. */
  optimizeBlocked: string | null;
  /** A computation of the date was running when the page was rendered, or null. */
  runningReason: string | null;
  canValidate: boolean;
  canReopen: boolean;
  /**
   * Trips without a vehicle on a planned day: « Placer les non affectées »
   * places them without moving the other trips to another vehicle. 0: no button.
   */
  unassignedCount?: number;
};

const RUNNING_ELSEWHERE = "Une optimisation de cette date est en cours sur un autre poste\u00a0: attendez la fin du calcul.";

export function PlanningToolbar({
  date,
  version,
  optimizeLabel,
  optimizeBlocked,
  runningReason,
  canValidate,
  canReopen,
  unassignedCount = 0,
}: ToolbarProps) {
  const { busy, run, remoteRunning, optimizerOffline } = usePlanningActivity();
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const validateRef = useRef<HTMLButtonElement>(null);

  /** « Revoir le planning » or Escape: the question closes and the focus goes back to « Valider le planning » (not to the page's top). */
  const dismiss = () => {
    setConfirmation(null);
    validateRef.current?.focus();
  };

  // Why each button is off right now (shown as its title and read by screen readers). A poll of the
  // version (remoteRunning) is more recent than the page's own render (runningReason).
  const computing = remoteRunning === null ? runningReason : remoteRunning ? (runningReason ?? RUNNING_ELSEWHERE) : null;
  const optimizeOff = optimizeBlocked ?? computing ?? optimizerOffline;
  const validateOff = computing;

  /** `confirmed`: the question answered « Valider quand même » (asked again if the issues changed since). */
  const validate = (confirmed: string | null) => {
    setConfirmation(null);
    run("Validation du planning…", () => validateDay(date, confirmed, version), {
      onResult: (result) => {
        if (!result.ok && result.needsConfirmation) setConfirmation(result.error);
      },
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        onClick={() => run("Optimisation en cours…", () => optimizeDay(date), { long: true })}
        disabled={busy || optimizeOff !== null}
        title={optimizeOff ?? "Calcule les tournées\u202f; les courses figées restent sur leur véhicule"}
        aria-describedby={optimizeOff ? "optimize-blocked" : undefined}
      >
        <Sparkles aria-hidden className="size-4" />
        {optimizeLabel}
      </Button>
      {optimizeOff ? (
        <span id="optimize-blocked" className="sr-only">
          {optimizeOff}
        </span>
      ) : null}

      {unassignedCount > 0 ? (
        <Button
          variant="secondary"
          onClick={() => run("Placement des courses non affectées…", () => placeUnassigned(date), { long: true })}
          disabled={busy || optimizeOff !== null}
          title={
            optimizeOff ??
            `Place ${unassignedCount > 1 ? `les ${unassignedCount} courses non affectées` : "la course non affectée"} dans les tournées en place\u00a0: les autres courses restent sur leur véhicule pour ce calcul (sans être figées), leurs horaires peuvent bouger`
          }
          aria-describedby={optimizeOff ? "optimize-blocked" : undefined}
        >
          <ListPlus aria-hidden className="size-4" />
          Placer les non affectées
          <span className="tabular rounded-full bg-amber-100 px-1.5 text-xs font-semibold text-amber-900">{unassignedCount}</span>
        </Button>
      ) : null}

      {canValidate ? (
        <>
          <Button
            ref={validateRef}
            variant="secondary"
            onClick={() => validate(null)}
            disabled={busy || validateOff !== null}
            title={validateOff ?? "Les tournées passent en «\u202fValidée\u202f»\u00a0: les chauffeurs les voient comme définitives"}
            aria-describedby={validateOff ? "validate-blocked" : undefined}
          >
            <CheckCheck aria-hidden className="size-4" />
            Valider le planning
          </Button>
          {validateOff ? (
            <span id="validate-blocked" className="sr-only">
              {validateOff}
            </span>
          ) : null}
          {confirmation ? (
            // The app's one confirmation, on its own line of the toolbar: never wider than the screen.
            <ConfirmPanel
              question={confirmation}
              confirmLabel="Oui, valider quand même"
              keepLabel="Revoir le planning"
              tone="primary"
              onKeep={dismiss}
              onConfirm={() => validate(confirmation)}
              pending={busy}
              className="basis-full border-amber-200 bg-amber-50 [&>div:first-child]:text-amber-950"
            />
          ) : null}
        </>
      ) : null}

      {canReopen ? (
        <Button
          variant="secondary"
          onClick={() => run("Réouverture du planning…", () => reopenDay(date))}
          disabled={busy}
          title="Repasse les tournées en «&#x202F;Proposée&#x202F;» pour les ajuster ou les réoptimiser"
        >
          <LockOpen aria-hidden className="size-4" />
          Rouvrir
        </Button>
      ) : null}
    </div>
  );
}
