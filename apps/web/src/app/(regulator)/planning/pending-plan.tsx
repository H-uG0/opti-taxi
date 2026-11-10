"use client";

import { useEffect, useRef, useState } from "react";
import { History, Scale } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { formatEurosRounded, formatInstant, formatKmRounded, pluralize } from "@/lib/planning/format";
import type { PlanFigures } from "@/lib/planning/plan-compare";
import type { RunView } from "@/lib/planning/types";
import { confirmPlan, discardPlan, restorePlan } from "./actions";
import { usePlanningActivity } from "./planning-activity";

type Row = { label: string; current: string; next: string; worse: boolean };

function rows(current: PlanFigures | null, next: PlanFigures): Row[] {
  const violations = (f: PlanFigures | null) => (f === null ? "—" : f.violations === null ? "?" : String(f.violations));
  return [
    { label: "Courses servies", current: current ? String(current.served) : "—", next: String(next.served), worse: current !== null && next.served < current.served },
    {
      label: "Violations de contraintes",
      current: violations(current),
      next: violations(next),
      worse: (next.violations ?? 0) > (current?.violations ?? 0),
    },
    {
      label: "Marge estimée",
      current: current ? formatEurosRounded(current.margin) : "—",
      next: formatEurosRounded(next.margin),
      worse: current !== null && next.margin < current.margin,
    },
    { label: "Kilomètres", current: current ? formatKmRounded(current.km) : "—", next: formatKmRounded(next.km), worse: current !== null && next.km > current.km },
  ];
}

const KIND_LABEL: Record<NonNullable<RunView["kind"]>, string> = {
  optimize: "Le calcul",
  move: "Le déplacement",
  restore: "Le retour au planning précédent",
  place: "Le placement des courses non affectées",
};

/** At most this many trips or violations are named; the rest is counted. */
const LIST_MAX = 5;

/** A title, then the first items, then « et 4 autres ». */
function NamedList({ title, items }: { title: string; items: readonly string[] }) {
  if (items.length === 0) return null;
  const shown = items.slice(0, LIST_MAX);
  const more = items.length - shown.length;
  return (
    <div className="text-xs text-amber-900">
      <p className="font-medium">{title}</p>
      <ul className="mt-0.5 list-disc space-y-0.5 pl-5">
        {shown.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
        {more > 0 ? <li className="list-none text-amber-800">et {pluralize(more, "autre", "autres")}</li> : null}
      </ul>
    </div>
  );
}

/**
 * A computation that would make the planning worse (fewer trips served, new
 * violations, much lower margin) waits here: the regulator replaces the
 * routes in place with it in one click, or keeps them. It takes the focus
 * when it appears (the action that produced it may have been started far
 * down the page, from the trip panel), as the toolbar's confirmation does.
 */
export function PendingPlanBanner({ run }: { run: RunView & { pending: NonNullable<RunView["pending"]> } }) {
  const { busy, run: runAction } = usePlanningActivity();
  const { comparison, question, lostTrips, violations } = run.pending;
  const current = comparison.current;
  const restore = run.kind === "restore";
  const keepFirst = run.kind === "place" && current !== null;
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const replace = (
    <Button
      key="replace"
      size="sm"
      variant={keepFirst ? "secondary" : "primary"}
      disabled={busy}
      onClick={() => runAction("Enregistrement du nouveau planning…", () => confirmPlan(run.id))}
    >
      {current ? "Remplacer quand même" : "Enregistrer quand même"}
    </Button>
  );
  const keep = (
    <Button
      key="keep"
      size="sm"
      variant={keepFirst ? "primary" : "secondary"}
      disabled={busy}
      onClick={() => runAction("Abandon du calcul…", () => discardPlan(run.id))}
    >
      {current ? "Garder le planning actuel" : "Abandonner ce calcul"}
    </Button>
  );
  return (
    <section
      ref={ref}
      tabIndex={-1}
      role="alertdialog"
      aria-labelledby="pending-plan-title"
      aria-describedby="pending-plan-question"
      className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 focus-visible:outline-2 focus-visible:outline-amber-600"
    >
      <div className="flex items-start gap-2">
        <Scale aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-700" />
        <div className="min-w-0 flex-1 space-y-2">
          <p id="pending-plan-title" className="font-semibold">
            {KIND_LABEL[run.kind ?? "optimize"]} du {formatInstant(run.startedAt)}
            {run.requestedBy ? ` (${run.requestedBy})` : ""}{" "}
            {current ? "n'a pas remplacé le planning en place" : "n'a pas été enregistré"}
          </p>
          <p id="pending-plan-question">{question}</p>
          <table className="w-full max-w-xl text-left text-xs">
            <thead>
              <tr className="text-amber-800">
                <th scope="col" className="py-1 pr-3 font-medium">
                  <span className="sr-only">Indicateur</span>
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">
                  {current ? "Planning en place" : "Aucun planning en place"}
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  {restore ? "Planning précédent" : "Nouveau calcul"}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-amber-200/70">
              {rows(current, comparison.next).map((row) => (
                <tr key={row.label}>
                  <th scope="row" className="py-1 pr-3 font-normal text-amber-900">
                    {row.label}
                  </th>
                  <td className="tabular py-1 pr-3 text-right">{row.current}</td>
                  <td className={cn("tabular py-1 text-right", row.worse && "font-semibold text-red-700")}>{row.next}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {lostTrips.length > 0 && current ? (
            <NamedList
              title={`${pluralize(lostTrips.length, "course servie", "courses servies")} actuellement ${
                lostTrips.length > 1 ? "resteraient" : "resterait"
              } sans véhicule :`}
              items={lostTrips}
            />
          ) : null}
          {violations.length > 0 ? (
            <NamedList
              title={`${restore ? "Violations du planning précédent" : "Violations du nouveau calcul"} (${violations.length}) :`}
              items={violations}
            />
          ) : null}
          {/* « Placer les non affectées » promised to leave the planning as it is but for the trips placed:
              keeping it is the first choice there. */}
          <div className="flex flex-wrap gap-2 pt-1">
            {keepFirst ? [keep, replace] : [replace, keep]}
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * « Revenir au planning précédent » : the routes the last computation
 * replaced come back, re-timed with today's data. Asks first.
 */
export function RestorePlanButton({
  date,
  version,
  previous,
  blocked,
}: {
  date: string;
  version: string;
  previous: PlanFigures;
  /** Why the day cannot be re-planned (past, validated, started, computation running), or null. */
  blocked: string | null;
}) {
  const { busy, run, optimizerOffline } = usePlanningActivity();
  const [confirming, setConfirming] = useState(false);
  const off = blocked ?? optimizerOffline;
  const served = pluralize(previous.served, "course servie", "courses servies");

  if (confirming && off === null) {
    return (
      <span role="group" aria-label="Revenir au planning précédent" className="inline-flex flex-wrap items-center gap-2">
        <span className="text-slate-700">
          Rétablir les tournées remplacées par le dernier calcul ({served} quand elles ont été remplacées ; ce qui ne
          peut plus être assuré aujourd&apos;hui sera laissé de côté) ?
        </span>
        <Button
          size="sm"
          autoFocus
          disabled={busy}
          onClick={() => {
            setConfirming(false);
            run("Retour au planning précédent…", () => restorePlan(date, version), { long: true });
          }}
        >
          Rétablir
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
          Annuler
        </Button>
      </span>
    );
  }
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={busy || off !== null}
      title={
        off ??
        `Rétablit les tournées remplacées par le dernier calcul (${served} à ce moment-là), horaires recalculés avec ` +
          "les données du jour ; ce qui ne peut plus être assuré est laissé de côté."
      }
      onClick={() => setConfirming(true)}
    >
      <History aria-hidden className="size-3.5" />
      Revenir au planning précédent
    </Button>
  );
}
