"use client";

import { useId, useState } from "react";
import { ChevronRight, LoaderCircle, PencilLine, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { ConfirmPanel, useConfirmStep } from "@/components/ui/confirm-action";
import { draftCountText, type DraftView } from "@/lib/planning/draft";
import { pluralize } from "@/lib/planning/format";
import { violationLineText } from "@/lib/planning/naming";
import { marginText, signedKmText } from "@/lib/planning/place-view";
import { formatMinute } from "@/lib/time";
import { usePlanningActivity } from "./planning-activity";
import type { PlanningDraft } from "./use-planning-draft";

/**
 * « 2 modifications non enregistrées · marge +45 € · −12,0 km · aucune violation nouvelle » : what
 * the draft changes in the day, both checked by the optimizer.
 */
export function draftSummary(view: Pick<DraftView, "before" | "after" | "newViolations" | "shifted">): string {
  const parts = [marginText(view.after.margin - view.before.margin), signedKmText(view.after.km - view.before.km)];
  const served = view.after.served - view.before.served;
  if (served !== 0) {
    parts.push(`${served > 0 ? "+" : "\u2212"}${pluralize(Math.abs(served), "course servie", "courses servies")}`);
  }
  parts.push(
    view.newViolations.length === 0
      ? "aucune violation nouvelle"
      : pluralize(view.newViolations.length, "violation nouvelle", "violations nouvelles"),
  );
  if (view.shifted.length > 0) {
    parts.push(`${pluralize(view.shifted.length, "autre patient décalé", "autres patients décalés")} de 10\u00a0min ou plus`);
  }
  return parts.join(" · ");
}

/**
 * The bar of the drag-and-drop draft (INS-03), at the top of the timeline: how many moves wait,
 * what they change (figures checked by the optimizer), « Annuler » and « Enregistrer »; the detail of
 * each move (with « Retirer »), the other patients it delays, the violations it adds; why a drop was
 * refused; the question asked on a validated or started day.
 */
export function DraftBar({
  draft,
  nameOf,
  vehicleLabel,
  onShowTrip,
}: {
  draft: PlanningDraft;
  nameOf: (tripId: string) => string;
  vehicleLabel: (vehicleId: string) => string;
  onShowTrip: (tripId: string) => void;
}) {
  const { busy } = usePlanningActivity();
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const { open: abandoning, triggerRef: abandonTrigger, ask: askAbandon, close: closeAbandon } = useConfirmStep();
  const { moves, view, checking, refusal, question } = draft;
  if (moves.length === 0 && !refusal) return null;
  // One move is undone by dropping it again: « Annuler » asks first only from two moves on.
  const cancel = () => (moves.length > 1 ? askAbandon() : draft.cancel());
  const where = (vehicleId: string | null) => (vehicleId ? vehicleLabel(vehicleId) : "À placer");
  const placed = view?.moves.filter((m) => m.ok) ?? [];

  return (
    <div
      role="region"
      aria-label="Brouillon de la frise"
      className="space-y-1.5 border-b border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-950"
    >
      {moves.length > 0 ? (
        <div className="flex items-center gap-3">
          <PencilLine aria-hidden className="size-4 shrink-0 text-brand-700" />
          <p className="min-w-0 flex-1 leading-snug">
            <span className="font-semibold">{draftCountText(moves.length)}</span>{" "}
            <span className="tabular text-xs text-brand-900">
              {checking ? (
                <span className="inline-flex items-center gap-1 whitespace-nowrap">
                  <LoaderCircle aria-hidden className="size-3.5 motion-safe:animate-spin" />
                  vérification par l&apos;optimiseur…
                </span>
              ) : view ? (
                <span className={cn(view.newViolations.length > 0 && "font-medium text-red-800")}>· {draftSummary(view)}</span>
              ) : null}
            </span>
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={detailId}
              onClick={() => setOpen((v) => !v)}
              className="inline-flex min-h-7 items-center gap-1 rounded px-1 text-xs font-medium text-brand-800 hover:bg-brand-100 focus-visible:outline-2 focus-visible:outline-brand-600"
            >
              <ChevronRight aria-hidden className={cn("size-3.5", open && "rotate-90")} />
              Détail
            </button>
            {abandoning ? null : (
              <Button ref={abandonTrigger} size="sm" variant="secondary" onClick={cancel} disabled={busy}>
                Annuler
              </Button>
            )}
            {!view && !checking ? (
              // The check did not answer: nothing is saved before the draft is checked again.
              <Button size="sm" onClick={draft.retry} disabled={busy}>
                Vérifier de nouveau
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => draft.save(null)}
                disabled={busy || checking || !view}
                title="Écrit les tournées changées, et elles seules, et fige les courses déplacées sur leur nouveau véhicule"
              >
                Enregistrer
              </Button>
            )}
          </div>
        </div>
      ) : null}
      {abandoning && moves.length > 1 ? (
        <ConfirmPanel
          question={`Abandonner les ${moves.length} modifications non enregistrées\u202f? Le planning en place reste tel quel.`}
          confirmLabel="Oui, abandonner le brouillon"
          keepLabel="Garder le brouillon"
          onKeep={closeAbandon}
          onConfirm={() => {
            closeAbandon();
            draft.cancel();
          }}
          className="bg-white"
        />
      ) : null}
      {open && moves.length > 0 ? (
        <div id={detailId} className="max-h-48 space-y-1.5 overflow-y-auto rounded-md border border-brand-200 bg-white px-2.5 py-2 text-xs text-slate-700">
          <ul className="space-y-1">
            {moves.map((move) => {
              const result = placed.find((m) => m.tripId === move.tripId);
              const from = result ? result.fromVehicleId : null;
              return (
                <li key={move.tripId} className="flex flex-wrap items-baseline gap-x-2">
                  <button
                    type="button"
                    onClick={() => onShowTrip(move.tripId)}
                    className="rounded font-medium text-brand-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600"
                  >
                    {nameOf(move.tripId)}
                  </button>
                  <span className="tabular">
                    {result ? `${where(from)} → ${where(move.toVehicleId)}` : `→ ${where(move.toVehicleId)}`}
                    {result && result.ok && result.pickupMinute !== null ? ` · prise en charge ${formatMinute(result.pickupMinute)}` : ""}
                    {result && result.ok && result.deltaMargin !== null ? ` · ${marginText(result.deltaMargin)}` : ""}
                  </span>
                  <button
                    type="button"
                    onClick={() => draft.remove(move.tripId)}
                    disabled={busy}
                    className="ml-auto rounded text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600"
                    aria-label={`Retirer du brouillon le déplacement de ${nameOf(move.tripId)}`}
                  >
                    Retirer
                  </button>
                </li>
              );
            })}
          </ul>
          {view && view.shifted.length > 0 ? (
            <div>
              <p className="font-medium text-amber-900">Autres patients décalés de 10&nbsp;min ou plus&nbsp;:</p>
              <ul className="list-disc pl-5">
                {view.shifted.map((s) => (
                  <li key={s.tripId}>
                    {nameOf(s.tripId)} ({vehicleLabel(s.vehicleId)})&nbsp;: {formatMinute(s.fromPickupMinute)} → {formatMinute(s.toPickupMinute)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {view && view.newViolations.length > 0 ? (
            <div className="text-red-800">
              <p className="font-medium">Violations nouvelles&nbsp;:</p>
              <ul className="list-disc pl-5">
                {view.newViolations.map((v, i) => (
                  <li key={i}>{violationLineText(v, nameOf, vehicleLabel)}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="text-slate-500">
            Chaque dépôt est vérifié par l&apos;optimiseur (la meilleure place dans la tournée du véhicule, sans violation
            nouvelle). «&#x202F;Enregistrer&#x202F;» écrit les tournées changées, et elles seules, et fige les courses déplacées.
          </p>
        </div>
      ) : null}
      {refusal ? (
        <p role="alert" className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-900">
          <span className="min-w-0 flex-1">{refusal}</span>
          <button
            type="button"
            onClick={draft.dismissRefusal}
            className="-m-0.5 rounded p-0.5 hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-brand-600"
            aria-label="Fermer le message"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        </p>
      ) : null}
      {question ? (
        <ConfirmPanel
          question={question}
          confirmLabel="Oui, enregistrer"
          keepLabel="Ne rien changer"
          tone="primary"
          onKeep={draft.dismissQuestion}
          onConfirm={() => draft.save(question)}
          pending={busy}
          className="border-amber-200 bg-amber-50 [&>div:first-child]:text-amber-950"
        />
      ) : null}
      <p role="status" className="sr-only">
        {checking ? "Vérification du brouillon…" : view ? `${draftCountText(moves.length)}\u00a0: ${draftSummary(view)}` : ""}
      </p>
    </div>
  );
}
