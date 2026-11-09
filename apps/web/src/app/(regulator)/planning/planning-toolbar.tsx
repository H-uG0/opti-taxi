"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCheck, LockOpen, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { optimizeDay, reopenDay, validateDay } from "./actions";
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
};

const RUNNING_ELSEWHERE = "Une optimisation de cette date est en cours sur un autre poste : attendez la fin du calcul.";

export function PlanningToolbar({
  date,
  version,
  optimizeLabel,
  optimizeBlocked,
  runningReason,
  canValidate,
  canReopen,
}: ToolbarProps) {
  const { busy, run, remoteRunning, optimizerOffline } = usePlanningActivity();
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const validateRef = useRef<HTMLButtonElement>(null);

  /** « Annuler » or Escape: the question closes and the focus goes back to « Valider le planning » (not to the page's top). */
  const dismiss = () => {
    setConfirmation(null);
    validateRef.current?.focus();
  };

  // The question appears while the validation is still finishing (its button disabled, so not focusable):
  // the focus goes to « Valider quand même » once it is enabled.
  useEffect(() => {
    if (confirmation && !busy) confirmRef.current?.focus();
  }, [confirmation, busy]);

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
        title={optimizeOff ?? "Calcule les tournées ; les courses figées restent sur leur véhicule"}
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

      {canValidate ? (
        <div className="relative">
          <Button
            ref={validateRef}
            variant="secondary"
            onClick={() => validate(null)}
            disabled={busy || validateOff !== null}
            title={validateOff ?? "Les tournées passent en « Validée » : les chauffeurs les voient comme définitives"}
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
            <div
              role="alertdialog"
              aria-labelledby="validate-confirm-text"
              onKeyDown={(e) => {
                if (e.key === "Escape") dismiss();
              }}
              className="absolute right-0 top-full z-30 mt-2 w-80 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 shadow-lg"
            >
              <p id="validate-confirm-text">{confirmation}</p>
              <div className="mt-3 flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={dismiss}>
                  Annuler
                </Button>
                <Button ref={confirmRef} size="sm" onClick={() => validate(confirmation)} disabled={busy}>
                  Valider quand même
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {canReopen ? (
        <Button
          variant="secondary"
          onClick={() => run("Réouverture du planning…", () => reopenDay(date))}
          disabled={busy}
          title="Repasse les tournées en « Proposée » pour les ajuster ou les réoptimiser"
        >
          <LockOpen aria-hidden className="size-4" />
          Rouvrir
        </Button>
      ) : null}
    </div>
  );
}
