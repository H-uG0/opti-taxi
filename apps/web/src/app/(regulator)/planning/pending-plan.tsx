"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { ChevronRight, History, ListChecks, LoaderCircle, Scale } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Checkbox } from "@/components/ui/form";
import { formatEurosRounded, formatKmRounded, pluralize } from "@/lib/planning/format";
import { CHANGE_GROUP_TITLES, changeCounts, changesText, routeChangeText } from "@/lib/planning/plan-changes";
import { figuresLine, type PlanFigures } from "@/lib/planning/plan-compare";
import { listing } from "@/lib/planning/plan-selection";
import { signedDurationText } from "@/lib/planning/place-view";
import type { SelectionPreview } from "@/lib/planning/run-optimization";
import type { PlanChangesView, RunView } from "@/lib/planning/types";
import { confirmPlan, discardPlan, previewPlanSelection, restorePlan } from "./actions";
import { usePlanningActivity, useTripLink } from "./planning-activity";
import { formatDateTime, formatMinute } from "@/lib/time";

type Row = { label: string; current: string; next: string; selection: string | null; worse: boolean; selectionWorse: boolean };

function rows(current: PlanFigures | null, next: PlanFigures, selection: PlanFigures | null): Row[] {
  const violations = (f: PlanFigures | null) => (f === null ? "—" : f.violations === null ? "?" : String(f.violations));
  const fewer = (f: PlanFigures) => current !== null && f.served < current.served;
  const moreViolations = (f: PlanFigures) => (f.violations ?? 0) > (current?.violations ?? 0);
  const lessMargin = (f: PlanFigures) => current !== null && f.margin < current.margin;
  const moreKm = (f: PlanFigures) => current !== null && f.km > current.km;
  const row = (label: string, text: (f: PlanFigures) => string, worse: (f: PlanFigures) => boolean, currentText: string): Row => ({
    label,
    current: currentText,
    next: text(next),
    selection: selection ? text(selection) : null,
    worse: worse(next),
    selectionWorse: selection !== null && worse(selection),
  });
  return [
    row("Courses servies", (f) => String(f.served), fewer, current ? String(current.served) : "—"),
    row("Violations de contraintes", violations, moreViolations, violations(current)),
    row("Marge estimée", (f) => formatEurosRounded(f.margin), lessMargin, current ? formatEurosRounded(current.margin) : "—"),
    row("Kilomètres", (f) => formatKmRounded(f.km), moreKm, current ? formatKmRounded(current.km) : "—"),
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
function NamedList({ title, items, tone = "amber" }: { title: string; items: readonly string[]; tone?: "amber" | "red" }) {
  if (items.length === 0) return null;
  const shown = items.slice(0, LIST_MAX);
  const more = items.length - shown.length;
  return (
    <div className={cn("text-xs", tone === "red" ? "text-red-800" : "text-amber-900")}>
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

type TripChangeView = NonNullable<PlanChangesView>["trips"][number];

/** « Taxi 1 → VSL 2 · 08:05 → 08:12 », « Taxi 3 · 09:10 → 09:25 (+15 min) », « Taxi 1 → sans véhicule ». */
function changeDetail(change: TripChangeView): string {
  const pickup =
    change.fromPickupMinute !== null && change.toPickupMinute !== null && change.fromPickupMinute !== change.toPickupMinute
      ? `prise en charge ${formatMinute(change.fromPickupMinute)} → ${formatMinute(change.toPickupMinute)}`
      : change.toPickupMinute !== null
        ? `prise en charge ${formatMinute(change.toPickupMinute)}`
        : null;
  switch (change.kind) {
    case "vehicle":
      return [`${change.fromLabel} → ${change.toLabel}`, pickup].filter(Boolean).join(" · ");
    case "time": {
      const shift = (change.toPickupMinute ?? 0) - (change.fromPickupMinute ?? 0);
      return `${change.toLabel} · ${pickup} (${signedDurationText(shift)})`;
    }
    case "unassigned":
      return `${change.fromLabel} → sans véhicule`;
    case "assigned":
      return [`→ ${change.toLabel}`, pickup].filter(Boolean).join(" · ");
  }
}

const CHANGE_ORDER = ["unassigned", "vehicle", "time", "assigned"] as const;

/**
 * « Changements » (INS-02): each trip the plan changes, grouped by kind, most serious first. A trip's
 * name selects it on the board, which highlights it a moment on the timeline (where it is now: the
 * plan is not saved yet).
 */
function ChangesList({ changes }: { changes: PlanChangesView }) {
  const { showTrip } = useTripLink();
  const counts = changeCounts(changes);
  return (
    <details className="group rounded-md border border-amber-200 bg-white/70" open={changes.trips.length <= 8}>
      <summary className="flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-amber-950 hover:bg-amber-100/60">
        <ChevronRight aria-hidden className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
        Changements ({changes.trips.length})
        <span className="min-w-0 truncate font-normal text-amber-900">· {changesText(counts)}</span>
      </summary>
      <div className="space-y-2 border-t border-amber-200 px-2.5 py-2">
        {CHANGE_ORDER.map((kind) => {
          const items = changes.trips.filter((change) => change.kind === kind);
          if (items.length === 0) return null;
          return (
            <section key={kind} aria-label={CHANGE_GROUP_TITLES[kind]}>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-800">
                {CHANGE_GROUP_TITLES[kind]} ({items.length})
              </p>
              <ul className="mt-0.5 space-y-0.5">
                {items.map((change) => (
                  <li key={change.tripId} className="flex flex-wrap items-baseline gap-x-2 text-xs text-slate-700">
                    <button
                      type="button"
                      onClick={() => showTrip(change.tripId)}
                      className="rounded font-medium text-brand-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600"
                      title="Voir la course sur la frise"
                    >
                      {change.trip}
                    </button>
                    <span className="tabular">{changeDetail(change)}</span>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </details>
  );
}

/**
 * « Accepter véhicule par véhicule » : each vehicle whose route changes, ticked to take its new
 * route, unticked to keep its route in place. The merged day is checked by the optimizer
 * (« Vérifier la sélection ») and shown before « Enregistrer la sélection ».
 */
function VehicleChoice({
  routes,
  refused,
  onChange,
  disabled,
}: {
  routes: PlanChangesView["routes"];
  refused: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  disabled: boolean;
}) {
  const refusable = routes.filter((route) => route.refusable);
  // Opened and closed by the regulator only: « Tout cocher » never folds it under the pointer (nor the focus).
  const [open, setOpen] = useState(refused.size > 0);
  return (
    <details className="group rounded-md border border-amber-200 bg-white/70" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-amber-950 hover:bg-amber-100/60">
        <ChevronRight aria-hidden className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
        Accepter véhicule par véhicule ({pluralize(routes.length, "tournée change", "tournées changent")})
        {refused.size > 0 ? (
          <span className="font-normal text-amber-900">· {pluralize(refused.size, "véhicule garde sa tournée", "véhicules gardent leur tournée")}</span>
        ) : null}
      </summary>
      <fieldset className="border-t border-amber-200 px-2.5 py-2" disabled={disabled}>
        <legend className="sr-only">Véhicules qui prennent leur nouvelle tournée</legend>
        <p className="text-xs text-amber-900">
          Coché&nbsp;: le véhicule prend sa nouvelle tournée. Décoché&nbsp;: il garde sa tournée actuelle, telle quelle.
        </p>
        <div className="mt-1 flex gap-3 text-xs">
          <button
            type="button"
            className="font-medium text-brand-700 underline-offset-2 hover:underline disabled:text-slate-400"
            onClick={() => onChange(new Set())}
            disabled={refused.size === 0}
          >
            Tout cocher
          </button>
          <button
            type="button"
            className="font-medium text-brand-700 underline-offset-2 hover:underline disabled:text-slate-400"
            onClick={() => onChange(new Set(refusable.map((route) => route.vehicleId)))}
            disabled={refused.size === refusable.length}
          >
            Tout décocher
          </button>
        </div>
        <ul className="mt-1.5 space-y-1">
          {routes.map((route) => (
            <li key={route.vehicleId}>
              <Checkbox
                className="items-start text-xs"
                checked={!refused.has(route.vehicleId)}
                disabled={!route.refusable}
                onChange={(e) => {
                  const next = new Set(refused);
                  if (e.currentTarget.checked) next.delete(route.vehicleId);
                  else next.add(route.vehicleId);
                  onChange(next);
                }}
                label={
                  <span className="min-w-0">
                    <span className="font-medium text-slate-900">{route.label}</span>{" "}
                    <span className="tabular text-slate-600">— {routeChangeText(route)}</span>
                    {route.tripChanges > 0 ? (
                      <span className="text-slate-600"> · {pluralize(route.tripChanges, "changement")}</span>
                    ) : null}
                    {!route.refusable ? (
                      <span className="block text-amber-800">Indisponible ce jour&nbsp;: ne peut pas garder sa tournée.</span>
                    ) : null}
                  </span>
                }
              />
            </li>
          ))}
        </ul>
      </fieldset>
    </details>
  );
}

/**
 * A computation that would make the planning worse (fewer trips served, new
 * violations, much lower margin), or that changes trips of the plan in place
 * (vehicle, pickup by 10 min or more, trips left without a vehicle: INS-02),
 * waits here: the regulator sees the « Changements », then saves it all, or
 * vehicle by vehicle (a re-optimization: the refused vehicles keep their
 * route, the merged day checked by the optimizer first), or keeps the routes
 * in place. It takes the focus when it appears (the action that produced it
 * may have been started far down the page, from the trip panel), as the
 * toolbar's confirmation does.
 */
export function PendingPlanBanner({ run }: { run: RunView & { pending: NonNullable<RunView["pending"]> } }) {
  const { busy, run: runAction } = usePlanningActivity();
  const { comparison, question, lostTrips, violations } = run.pending;
  const changes = run.pending.changes ?? null;
  const review = run.pending.review === true;
  const selectable = run.pending.selectable === true && changes !== null;
  const current = comparison.current;
  const restore = run.kind === "restore";
  const keepFirst = run.kind === "place" && current !== null && !review;
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  const [refused, setRefused] = useState<Set<string>>(() => new Set());
  const refusedKey = [...refused].sort().join(",");
  const [preview, setPreview] = useState<{ refusedKey: string; result: SelectionPreview } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [checking, startCheck] = useTransition();
  const shownPreview = preview && preview.refusedKey === refusedKey && refused.size > 0 ? preview.result : null;
  const choosing = refused.size > 0;

  const check = () => {
    if (checking) return;
    setPreviewError(null);
    const asked = refusedKey;
    startCheck(async () => {
      try {
        const result = await previewPlanSelection(run.id, [...refused]);
        if (!result) return;
        if (result.ok) setPreview({ refusedKey: asked, result: result.preview });
        else setPreviewError(result.error);
      } catch {
        setPreviewError("La vérification n'a pas abouti (connexion au serveur perdue ?) : réessayez.");
      }
    });
  };

  const replace = (
    <Button
      key="replace"
      size="sm"
      variant={keepFirst || choosing ? "secondary" : "primary"}
      disabled={busy}
      onClick={() => runAction("Enregistrement du nouveau planning…", () => confirmPlan(run.id))}
    >
      {review ? "Tout accepter" : current ? "Remplacer quand même" : "Enregistrer quand même"}
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
  const saveSelection = shownPreview ? (
    <Button
      key="selection"
      size="sm"
      disabled={busy}
      onClick={() =>
        runAction(
          "Enregistrement de la sélection…",
          () => confirmPlan(run.id, { refusedVehicleIds: [...refused], key: shownPreview.key }),
          // Refused (the selection or the routes in place changed since): « Vérifier la sélection » comes back.
          { onResult: (result) => (result.ok ? undefined : setPreview(null)) },
        )
      }
    >
      {shownPreview.question ? "Enregistrer la sélection quand même" : "Enregistrer la sélection"}
    </Button>
  ) : null;
  const when = `${KIND_LABEL[run.kind ?? "optimize"]} du ${formatDateTime(run.startedAt)}${run.requestedBy ? ` (${run.requestedBy})` : ""}`;
  return (
    <section
      ref={ref}
      tabIndex={-1}
      role="alertdialog"
      aria-labelledby="pending-plan-title"
      aria-describedby="pending-plan-question"
      // The banner scrolls in its own box (the board stays in view below it), and only it (no list
      // inside has its own scroll): its title stays at the top, its buttons at the bottom.
      className="max-h-[60dvh] shrink-0 overflow-y-auto overscroll-contain rounded-lg border border-amber-300 bg-amber-50 text-sm text-amber-950 focus-visible:outline-2 focus-visible:outline-amber-600"
    >
      <div className="sticky top-0 z-10 flex items-start gap-2 bg-amber-50 px-4 pt-3 pb-1.5">
        {review ? (
          <ListChecks aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-700" />
        ) : (
          <Scale aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-700" />
        )}
        <p id="pending-plan-title" className="min-w-0 flex-1 font-semibold">
          {when}{" "}
          {review
            ? "n'est pas encore enregistré : vérifiez ce qu'il change"
            : current
              ? "n'a pas remplacé le planning en place"
              : "n'a pas été enregistré"}
        </p>
      </div>
      <div className="space-y-2 pr-4 pb-2 pl-10">
        <p id="pending-plan-question">{question}</p>
        <table className="w-full max-w-2xl text-left text-xs">
          <thead>
            <tr className="text-amber-800">
              <th scope="col" className="py-1 pr-3 font-medium">
                <span className="sr-only">Indicateur</span>
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">
                {current ? "Planning en place" : "Aucun planning en place"}
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">
                {restore ? "Planning précédent" : "Nouveau calcul"}
              </th>
              {shownPreview ? (
                <th scope="col" className="py-1 text-right font-medium">
                  Sélection
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-amber-200/70">
            {rows(current, comparison.next, shownPreview?.selection ?? null).map((row) => (
              <tr key={row.label}>
                <th scope="row" className="py-1 pr-3 font-normal text-amber-900">
                  {row.label}
                </th>
                <td className="tabular py-1 pr-3 text-right">{row.current}</td>
                <td className={cn("tabular py-1 pr-3 text-right", row.worse && "font-semibold text-red-700")}>{row.next}</td>
                {row.selection !== null ? (
                  <td className={cn("tabular py-1 text-right", row.selectionWorse && "font-semibold text-red-700")}>{row.selection}</td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
        {changes && changes.trips.length > 0 ? <ChangesList changes={changes} /> : null}
        {/* Listed once: in « Changements » (« Resteraient sans véhicule ») when the plan has that list. */}
        {lostTrips.length > 0 && current && !review && !(changes && changes.trips.length > 0) ? (
          <NamedList
            title={`${pluralize(lostTrips.length, "course servie", "courses servies")} actuellement ${
              lostTrips.length > 1 ? "resteraient" : "resterait"
            } sans véhicule :`}
            items={lostTrips}
          />
        ) : null}
        {violations.length > 0 ? (
          <NamedList
            title={`${restore ? "Violations du planning précédent" : "Violations du nouveau calcul"} (${violations.length}) :`}
            items={violations}
          />
        ) : null}
        {selectable && changes ? (
          <div className="space-y-2">
            <VehicleChoice
              routes={changes.routes}
              refused={refused}
              onChange={(next) => {
                setRefused(next);
                setPreviewError(null);
              }}
              disabled={busy}
            />
            {choosing ? (
              <div className="space-y-1.5 rounded-md border border-amber-200 bg-white/70 px-2.5 py-2">
                {shownPreview ? (
                  <SelectionResult preview={shownPreview} />
                ) : (
                  <p className="text-xs text-amber-900">
                    {pluralize(refused.size, "véhicule garde sa tournée", "véhicules gardent leur tournée")}&nbsp;: vérifiez la
                    journée que fait cette sélection avant de l&apos;enregistrer.
                  </p>
                )}
                {previewError ? (
                  <p role="alert" className="text-xs text-red-700">
                    {previewError}
                  </p>
                ) : null}
                {shownPreview ? null : (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={check}
                    disabled={busy}
                    aria-disabled={checking || undefined}
                    aria-busy={checking}
                    className="aria-disabled:cursor-wait aria-disabled:opacity-50"
                  >
                    {checking ? <LoaderCircle aria-hidden className="size-3.5 motion-safe:animate-spin" /> : null}
                    {checking ? "Vérification…" : "Vérifier la sélection"}
                  </Button>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {/* « Placer les non affectées » promised to leave the planning as it is but for the trips placed:
          keeping it is the first choice there. */}
      <div className="sticky bottom-0 z-10 flex flex-wrap gap-2 border-t border-amber-200 bg-amber-50 py-2 pr-4 pl-10">
        {saveSelection}
        {keepFirst ? [keep, replace] : [replace, keep]}
      </div>
    </section>
  );
}

/** What « Vérifier la sélection » found: the trips kept on a refused vehicle, those left without one, its violations. */
function SelectionResult({ preview }: { preview: SelectionPreview }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-amber-950">
        Sélection vérifiée par l&apos;optimiseur&nbsp;: {listing(preview.refused)}{" "}
        {preview.refused.length > 1 ? "gardent leur tournée" : "garde sa tournée"} · {figuresLine(preview.selection)}.
      </p>
      {preview.question ? <p className="text-xs font-medium text-red-800">{preview.question}</p> : null}
      {preview.hint ? <p className="text-xs text-amber-950">{preview.hint}</p> : null}
      <NamedList
        title={`${pluralize(preview.keptOnRefused.length, "course reste", "courses restent")} sur un véhicule qui garde sa tournée :`}
        items={preview.keptOnRefused}
      />
      <NamedList
        title={`${pluralize(preview.leftOut.length, "course resterait", "courses resteraient")} sans véhicule :`}
        items={preview.leftOut}
        tone="red"
      />
      <NamedList title={`Violations de la sélection (${preview.violations.length}) :`} items={preview.violations} tone="red" />
    </div>
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
          Rétablir les tournées remplacées par le dernier calcul ({served} quand elles ont été remplacées&#x202F;; ce qui ne
          peut plus être assuré aujourd&apos;hui sera laissé de côté)&#x202F;?
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
          "les données du jour\u202f; ce qui ne peut plus être assuré est laissé de côté."
      }
      onClick={() => setConfirming(true)}
    >
      <History aria-hidden className="size-3.5" />
      Revenir au planning précédent
    </Button>
  );
}
