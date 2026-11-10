"use client";

import { useEffect, useId, useRef, useState, useTransition, type Ref } from "react";
import { LoaderCircle, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { ConfirmPanel } from "@/components/ui/confirm-action";
import { formatSeconds } from "@/lib/planning/format";
import {
  groupPlaces,
  marginText,
  placeFiguresText,
  placesSummary,
  placeTimesText,
  sharedText,
  shiftsText,
  type PlaceGroup,
  type PlaceOptionRow,
  type PlacesView,
} from "@/lib/planning/place-view";
import type { TripView, VehicleRowView } from "@/lib/planning/types";
import { findPlaces, placeTrip } from "./actions";
import { usePlanningActivity } from "./planning-activity";

/** Places shown at once in a depot; the others behind « N autres places ». */
const SHOWN_PER_DEPOT = 3;

export type PlaceFinderProps = {
  trip: Pick<TripView, "id" | "vehicleId" | "allowedVehicleTypes">;
  /** Patients' names of the co-passengers and of the trips a place delays. */
  trips: Record<string, Pick<TripView, "patientName">>;
  vehicles: VehicleRowView[];
  /** Why the trip cannot be placed now (cancelled, started, past date, computation running…), or null. */
  blocked: string | null;
  /** Search at once (« Où la placer ? » from a new trip or a link). */
  autoStart?: boolean;
  /** The « Chercher » button (shortcut « D » of the trip panel). */
  searchRef?: Ref<HTMLButtonElement>;
};

/**
 * « Où placer cette course ? » (INS-01): the best place of the trip in each vehicle's route in
 * place (the optimizer's /insert, about a second at 120 vehicles), grouped by depot, best margin
 * first, the vehicles without a place greyed with their reason. « Appliquer » saves that place
 * only: the vehicle's route and the one the trip leaves, nothing else of the day.
 */
export function PlaceFinder({ trip, trips, vehicles, blocked, autoStart = false, searchRef }: PlaceFinderProps) {
  const { busy, run } = usePlanningActivity();
  const titleId = useId();
  const [view, setView] = useState<PlacesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, startSearch] = useTransition();
  const [confirm, setConfirm] = useState<{ vehicleId: string; question: string } | null>(null);
  const nameOf = (id: string) => trips[id]?.patientName ?? null;

  const search = () => {
    setError(null);
    setConfirm(null);
    startSearch(async () => {
      try {
        const result = await findPlaces(trip.id);
        // A redirect (expired session) resolves without a result: the router navigates.
        if (!result) return;
        if (result.ok) setView(result.view);
        else {
          setView(null);
          setError(result.error);
        }
      } catch {
        setError("La recherche n'a pas abouti (connexion au serveur perdue\u202f?)\u00a0: réessayez.");
      }
    });
  };

  // Once, when asked to (the panel opened to place a new trip).
  const started = useRef(false);
  useEffect(() => {
    if (!autoStart || started.current || blocked !== null) return;
    started.current = true;
    search();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per panel
  }, [autoStart, blocked]);

  const apply = (option: PlaceOptionRow, confirmed: string | null) => {
    if (!view) return;
    setConfirm(null);
    run(`Placement sur ${option.label}…`, () => placeTrip(trip.id, option.vehicleId, view.version, confirmed), {
      onResult: (result) => {
        if (!result.ok && result.needsConfirmation) setConfirm({ vehicleId: option.vehicleId, question: result.error });
        // The places no longer describe the plan: computed again on demand.
        else if (!result.ok && result.stale) setView(null);
      },
    });
  };

  const off = blocked !== null;
  return (
    <section aria-labelledby={titleId} className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 id={titleId} className="text-sm font-medium text-slate-800">
          Où placer cette course&#x202F;?
        </h3>
        <Button
          ref={searchRef}
          size="sm"
          variant={trip.vehicleId ? "secondary" : "primary"}
          aria-keyshortcuts="D"
          onClick={search}
          disabled={busy || searching || off}
          aria-busy={searching}
          title={blocked ?? "Cherche la meilleure place dans chaque tournée en place, sans changer les autres"}
        >
          {searching ? <LoaderCircle aria-hidden className="size-3.5 motion-safe:animate-spin" /> : <Search aria-hidden className="size-3.5" />}
          {searching ? "Recherche…" : view ? "Recalculer" : "Chercher"}
        </Button>
      </div>
      {off ? (
        <p className="text-xs text-slate-500">{blocked}</p>
      ) : !view && !error ? (
        <p className="text-xs text-slate-500">
          La meilleure place dans chaque tournée en place, sans toucher aux autres tournées&nbsp;: km, marge et patients décalés.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      ) : null}
      <div aria-live="polite">
        {view && !off ? (
          <PlacesList
            view={view}
            groups={groupPlaces(view, vehicles, trip.allowedVehicleTypes)}
            nameOf={nameOf}
            busy={busy}
            confirm={confirm}
            onApply={apply}
            onKeep={() => setConfirm(null)}
          />
        ) : null}
      </div>
    </section>
  );
}

function PlacesList({
  view,
  groups,
  nameOf,
  busy,
  confirm,
  onApply,
  onKeep,
}: {
  view: PlacesView;
  groups: PlaceGroup[];
  nameOf: (tripId: string) => string | null;
  busy: boolean;
  confirm: { vehicleId: string; question: string } | null;
  onApply: (option: PlaceOptionRow, confirmed: string | null) => void;
  onKeep: () => void;
}) {
  const bestId = groups[0]?.options[0]?.vehicleId ?? null;
  const item = (option: PlaceOptionRow) => (
    <PlaceItem
      key={option.vehicleId}
      option={option}
      best={option.vehicleId === bestId}
      nameOf={nameOf}
      busy={busy}
      question={confirm?.vehicleId === option.vehicleId ? confirm.question : null}
      onApply={onApply}
      onKeep={onKeep}
    />
  );
  return (
    <div className="space-y-2.5">
      <p className="text-xs text-slate-600">
        {placesSummary(view)} · calcul {formatSeconds(view.elapsedMs)}
        {view.straightLine ? " · distances à vol d'oiseau" : ""}
      </p>
      {groups.length > 0 ? (
        <ul className="space-y-2.5" aria-label="Places par dépôt">
          {groups.map((group) => (
            <li key={group.depotId}>
              <p className="flex items-baseline justify-between gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <span className="truncate">{group.depotLabel}</span>
                <span className="shrink-0 font-normal normal-case">
                  {group.options.length === 0 ? "aucune place" : group.options.length > 1 ? `${group.options.length} places` : "1 place"}
                </span>
              </p>
              {group.options.length > 0 ? <ul className="mt-1 space-y-1.5">{group.options.slice(0, SHOWN_PER_DEPOT).map(item)}</ul> : null}
              {group.options.length > SHOWN_PER_DEPOT ? (
                <details className="mt-1.5">
                  <summary className="cursor-pointer text-xs font-medium text-brand-700 hover:underline">
                    {group.options.length - SHOWN_PER_DEPOT > 1
                      ? `${group.options.length - SHOWN_PER_DEPOT} autres places`
                      : "1 autre place"}
                  </summary>
                  <ul className="mt-1.5 space-y-1.5">{group.options.slice(SHOWN_PER_DEPOT).map(item)}</ul>
                </details>
              ) : null}
              {group.rejected.length > 0 ? (
                <details className="mt-1.5">
                  <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-700">
                    {group.rejected.length > 1 ? `${group.rejected.length} véhicules sans place` : "1 véhicule sans place"}
                  </summary>
                  <ul className="mt-1 space-y-1 border-l-2 border-slate-200 pl-2">
                    {group.rejected.map((rejection) => (
                      <li key={rejection.vehicleId} className="text-xs text-slate-500">
                        <span className="font-medium text-slate-600">{rejection.label}</span> {rejection.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function PlaceItem({
  option,
  best,
  nameOf,
  busy,
  question,
  onApply,
  onKeep,
}: {
  option: PlaceOptionRow;
  best: boolean;
  nameOf: (tripId: string) => string | null;
  busy: boolean;
  question: string | null;
  onApply: (option: PlaceOptionRow, confirmed: string | null) => void;
  onKeep: () => void;
}) {
  const shared = sharedText(option.coPassengerTripIds, nameOf);
  const shifts = shiftsText(option.shifts, nameOf);
  return (
    <li className={cn("rounded-md border bg-white px-2.5 py-2", best ? "border-emerald-300" : "border-slate-200")}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
            <span className="font-medium text-slate-900">{option.label}</span>
            <span className={cn("tabular text-xs font-semibold", option.deltaMargin >= 0.5 ? "text-emerald-700" : "text-slate-700")}>
              {marginText(option.deltaMargin)}
            </span>
            {best ? <Badge tone="success">Meilleure place</Badge> : null}
          </p>
          <p className="tabular text-xs text-slate-600">{placeTimesText(option)}</p>
          <p className="tabular text-xs text-slate-600">{placeFiguresText(option)}</p>
          {shared ? <p className="text-xs text-shared-strong">{shared}</p> : null}
          {shifts ? <p className="text-xs text-slate-600">{shifts}</p> : null}
          {option.remainingViolations > 0 ? (
            <p className="text-xs text-amber-800">
              {option.remainingViolations > 1
                ? `${option.remainingViolations} contraintes déjà enfreintes par ces tournées le restent`
                : "1 contrainte déjà enfreinte par ces tournées le reste"}
            </p>
          ) : null}
        </div>
        <Button
          size="sm"
          variant={best ? "primary" : "secondary"}
          className="shrink-0"
          disabled={busy}
          onClick={() => onApply(option, null)}
          aria-label={`Appliquer\u00a0: placer la course sur ${option.label}`}
        >
          Appliquer
        </Button>
      </div>
      {question ? (
        <ConfirmPanel
          question={question}
          confirmLabel="Oui, appliquer"
          keepLabel="Ne rien changer"
          tone="primary"
          onKeep={onKeep}
          onConfirm={() => onApply(option, question)}
          pending={busy}
          className="mt-2 border-amber-200 bg-amber-50 [&>div:first-child]:text-amber-950"
        />
      ) : null}
    </li>
  );
}
