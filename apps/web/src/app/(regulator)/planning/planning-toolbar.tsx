"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCheck, LockOpen, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { optimizeDay, reopenDay, validateDay } from "./actions";
import { usePlanningActivity } from "./planning-activity";

export type ToolbarProps = {
  date: string;
  optimizeLabel: string;
  /** Why optimizing is not possible right now, or null. */
  optimizeBlocked: string | null;
  canValidate: boolean;
  canReopen: boolean;
};

export function PlanningToolbar({ date, optimizeLabel, optimizeBlocked, canValidate, canReopen }: ToolbarProps) {
  const { busy, run } = usePlanningActivity();
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirmation) confirmRef.current?.focus();
  }, [confirmation]);

  const validate = (confirmed: boolean) => {
    setConfirmation(null);
    run("Validation du planning…", () => validateDay(date, confirmed), {
      onResult: (result) => {
        if (!result.ok && result.needsConfirmation) setConfirmation(result.error);
      },
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        onClick={() => run("Optimisation en cours…", () => optimizeDay(date), { long: true })}
        disabled={busy || optimizeBlocked !== null}
        title={optimizeBlocked ?? "Calcule les tournées ; les courses figées restent sur leur véhicule"}
        aria-describedby={optimizeBlocked ? "optimize-blocked" : undefined}
      >
        <Sparkles aria-hidden className="size-4" />
        {optimizeLabel}
      </Button>
      {optimizeBlocked ? (
        <span id="optimize-blocked" className="sr-only">
          {optimizeBlocked}
        </span>
      ) : null}

      {canValidate ? (
        <div className="relative">
          <Button variant="secondary" onClick={() => validate(false)} disabled={busy}>
            <CheckCheck aria-hidden className="size-4" />
            Valider le planning
          </Button>
          {confirmation ? (
            <div
              role="alertdialog"
              aria-labelledby="validate-confirm-text"
              onKeyDown={(e) => {
                if (e.key === "Escape") setConfirmation(null);
              }}
              className="absolute right-0 top-full z-30 mt-2 w-80 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 shadow-lg"
            >
              <p id="validate-confirm-text">{confirmation}</p>
              <div className="mt-3 flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setConfirmation(null)}>
                  Annuler
                </Button>
                <Button ref={confirmRef} size="sm" onClick={() => validate(true)} disabled={busy}>
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
