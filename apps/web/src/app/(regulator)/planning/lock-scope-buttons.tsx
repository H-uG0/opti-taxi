"use client";

import { useState } from "react";
import { Check, Lock, LockOpen, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { scopeText, type LockScope } from "@/lib/planning/bulk-lock";
import { pluralize } from "@/lib/planning/format";
import { lockRoutes, unlockRoutes } from "./actions";
import { usePlanningActivity } from "./planning-activity";

type Props = {
  date: string;
  /** Plan version shown: a lock on a plan changed since is refused. */
  version: string;
  scope: LockScope;
  /** Vehicle label or depot name, for the messages. */
  name: string | null;
  /** Active trips of the scope's routes not locked yet. */
  lockable: number;
  /** Trips of the scope locked on their vehicle. */
  locked: number;
  /** Why locks cannot change (past date), or null. */
  blocked: string | null;
  /** panel: labelled buttons; icons: two small icon buttons (a depot's header). */
  variant?: "panel" | "icons";
};

/**
 * « Figer » / « Défiger » a route, a depot or the whole day in one action.
 * Unlocking a depot or the day asks first: the locks a regulator set one by
 * one would be lost.
 */
export function LockScopeButtons({ date, version, scope, name, lockable, locked, blocked, variant = "panel" }: Props) {
  const { busy, run } = usePlanningActivity();
  const [confirming, setConfirming] = useState(false);
  const what = scopeText(scope, name);
  const lockLabel = `Figer ${what}`;
  const unlockLabel = `Défiger ${what}`;
  const lock = () => run(`${lockLabel}…`, () => lockRoutes(date, scope, version));
  const unlock = () => {
    setConfirming(false);
    run(`${unlockLabel}…`, () => unlockRoutes(date, scope, version));
  };
  const askFirst = scope.kind !== "route";
  const lockTitle =
    blocked ??
    (lockable > 0
      ? `${pluralize(lockable, "course restera", "courses resteront")} sur leur véhicule à la prochaine optimisation`
      : "Toutes les courses sont déjà figées");
  const unlockTitle = blocked ?? (locked > 0 ? `${pluralize(locked, "course figée", "courses figées")} : l'optimisation pourra de nouveau les déplacer` : "Aucune course figée");

  if (confirming) {
    return (
      <span
        role="group"
        aria-label={`Confirmer : ${unlockLabel}`}
        className={cn("inline-flex flex-wrap items-center gap-1.5", variant === "panel" ? "text-sm" : "text-xs")}
      >
        <span className="text-slate-700">
          Défiger {pluralize(locked, "course", "courses")} ?
        </span>
        <Button size="sm" variant="secondary" className={variant === "icons" ? "h-6 px-1.5 text-xs" : undefined} onClick={unlock} disabled={busy} autoFocus>
          <Check aria-hidden className="size-3.5" />
          Défiger
        </Button>
        <Button size="sm" variant="ghost" className={variant === "icons" ? "h-6 px-1.5 text-xs" : undefined} onClick={() => setConfirming(false)}>
          <X aria-hidden className="size-3.5" />
          Annuler
        </Button>
      </span>
    );
  }

  if (variant === "icons") {
    const icon =
      "inline-grid size-6 place-items-center rounded text-slate-600 hover:bg-slate-200/80 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-brand-600 disabled:pointer-events-none disabled:opacity-40";
    return (
      <>
        <button type="button" className={icon} onClick={lock} disabled={busy || blocked !== null || lockable === 0} aria-label={lockLabel} title={`${lockLabel} — ${lockTitle}`}>
          <Lock aria-hidden className="size-3.5" />
        </button>
        <button
          type="button"
          className={icon}
          onClick={() => (askFirst ? setConfirming(true) : unlock())}
          disabled={busy || blocked !== null || locked === 0}
          aria-label={unlockLabel}
          title={`${unlockLabel} — ${unlockTitle}`}
        >
          <LockOpen aria-hidden className="size-3.5" />
        </button>
      </>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button size="sm" variant="secondary" onClick={lock} disabled={busy || blocked !== null || lockable === 0} title={lockTitle}>
        <Lock aria-hidden className="size-3.5" />
        {scope.kind === "route" ? "Figer la tournée" : scope.kind === "day" ? "Figer toute la journée" : "Figer le dépôt"}
        {lockable > 0 ? <span className="tabular text-xs text-slate-500">({lockable})</span> : null}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => (askFirst ? setConfirming(true) : unlock())}
        disabled={busy || blocked !== null || locked === 0}
        title={unlockTitle}
      >
        <LockOpen aria-hidden className="size-3.5" />
        {scope.kind === "route" ? "Défiger la tournée" : scope.kind === "day" ? "Défiger toute la journée" : "Défiger le dépôt"}
        {locked > 0 ? <span className="tabular text-xs text-slate-500">({locked})</span> : null}
      </Button>
    </span>
  );
}
