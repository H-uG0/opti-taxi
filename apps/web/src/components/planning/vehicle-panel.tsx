"use client";

import type { ReactNode } from "react";
import { FileCheck2, FileWarning, Lock, Radio, TriangleAlert, X } from "lucide-react";
import { Badge, VehicleTypeBadge } from "@/components/ui/badge";
import { Card } from "@/components/ui/layout";
import { cn } from "@/components/ui/cn";
import { formatEurosRounded, formatKmRounded } from "@/lib/planning/format";
import type { RoadmapStateView } from "@/lib/planning/live-load";
import type { VehicleLiveView } from "@/lib/planning/live-view";
import type { TripView, VehicleRowView } from "@/lib/planning/types";
import { formatPercent, ROUTE_STATUS_LABELS, STOP_KIND_LABELS } from "@/lib/labels";
import { formatMinute } from "@/lib/time";

/** Selected vehicle: crew, hours, figures and the ordered stops of its route. */
export function VehiclePanel({
  vehicle,
  trips,
  issues = [],
  crewAction,
  outageAction,
  lockAction,
  live = null,
  roadmap = null,
  onSelectTrip,
  onClose,
}: {
  vehicle: VehicleRowView;
  /** Today: where the route stands (« Suivi du jour »). */
  live?: VehicleLiveView | null;
  /** Where the crew stands with its roadmap (version published, « J'ai vu »). */
  roadmap?: RoadmapStateView | null;
  trips: Record<string, TripView>;
  /** What to fix on this vehicle (route-issues.ts): an absent driver, a crew changed since the computation… */
  issues?: string[];
  /** « Changer l'équipage » (planning page). */
  crewAction?: ReactNode;
  /** « Hors service… » : the vehicle or its crew unavailable from a time (planning page, DAY-03). */
  outageAction?: ReactNode;
  /** « Figer la tournée » / « Défiger la tournée » (planning page). */
  lockAction?: ReactNode;
  onSelectTrip: (tripId: string) => void;
  onClose: () => void;
}) {
  const route = vehicle.route;
  return (
    <Card aria-labelledby="vehicle-panel-title">
      <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div className="min-w-0">
          <h2 id="vehicle-panel-title" className="flex items-center gap-2 text-base font-semibold text-slate-900">
            <span aria-hidden className="size-3 shrink-0 rounded-full" style={{ background: vehicle.color }} />
            <span className="truncate">{vehicle.label}</span>
          </h2>
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
            <VehicleTypeBadge type={vehicle.type} dot={false} />
            <span>{vehicle.registration}</span>
            <span aria-hidden>·</span>
            <span>dépôt {vehicle.depot.label}</span>
            {route ? <Badge tone={route.status === "VALIDATED" ? "success" : "info"}>{ROUTE_STATUS_LABELS[route.status]}</Badge> : null}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="-m-1 rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-brand-600"
          aria-label="Fermer le détail du véhicule"
        >
          <X aria-hidden className="size-4" />
        </button>
      </div>

      <div className="space-y-1 px-4 py-3 text-sm text-slate-700">
        <p>
          {vehicle.driverName ?? "Sans chauffeur"}
          {vehicle.crewMateName ? ` + ${vehicle.crewMateName}` : ""}
          {vehicle.shift ? (
            <span className="tabular text-slate-500">
              {" "}
              · {formatMinute(vehicle.shift.start)} – {formatMinute(vehicle.shift.end)}
            </span>
          ) : null}
        </p>
        {!vehicle.available ? <p className="text-red-700">Indisponible&nbsp;: {vehicle.unavailableReason ?? "hors service"}</p> : null}
        {route ? (
          <p className="tabular text-slate-600">
            {formatMinute(route.startMinute)} → {formatMinute(route.endMinute)} · {formatKmRounded(route.distanceKm)} (
            {formatPercent(route.distanceKm > 0 ? route.emptyKm / route.distanceKm : null)} à vide) · CA{" "}
            {formatEurosRounded(route.revenue)} · marge{" "}
            <span className={cn(route.margin < 0 && "text-red-700")}>{formatEurosRounded(route.margin)}</span>
          </p>
        ) : (
          <p className="text-slate-500">Aucune course ce jour.</p>
        )}
        {live ? (
          <div className="mt-1 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700">
            <p className="flex items-start gap-1.5">
              <Radio aria-hidden className="mt-0.5 size-3.5 shrink-0 text-red-600" />
              <span className="tabular">{live.summary}</span>
            </p>
            {live.alert ? <p className="mt-0.5 font-medium text-red-800">{live.alert}</p> : null}
          </div>
        ) : null}
        {roadmap ? (
          <p className={cn("flex items-start gap-1.5 text-xs", roadmap.tone === "pending" ? "font-medium text-amber-900" : "text-slate-600")}>
            {roadmap.tone === "pending" ? (
              <FileWarning aria-hidden className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
            ) : (
              <FileCheck2 aria-hidden className="mt-0.5 size-3.5 shrink-0 text-slate-500" />
            )}
            <span>
              <span className="sr-only">Feuille de route&nbsp;: </span>
              {roadmap.text}
            </span>
          </p>
        ) : null}
        {route && lockAction ? <div className="pt-1.5">{lockAction}</div> : null}
        {issues.length > 0 ? (
          <ul className="space-y-0.5 pt-1 text-xs text-amber-900">
            {issues.map((issue) => (
              <li key={issue} className="flex items-start gap-1.5">
                <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
                <span>{issue}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {crewAction}
      {outageAction}

      {route ? (
        <ol className="border-t border-slate-100 px-2 py-2">
          {route.stops.map((stop) => {
            const trip = trips[stop.tripId];
            const now = live?.stops[stop.id];
            return (
              <li key={stop.id}>
                <button
                  type="button"
                  onClick={() => onSelectTrip(stop.tripId)}
                  className="grid w-full grid-cols-[3rem_1rem_minmax(0,1fr)] items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-brand-600"
                >
                  <span className="tabular font-medium text-slate-900">{formatMinute(stop.startMinute)}</span>
                  <span
                    aria-hidden
                    className={cn("mt-1 size-3 rounded-full border-2", stop.kind === "PICKUP" ? "border-white" : "bg-white")}
                    style={stop.kind === "PICKUP" ? { background: vehicle.color } : { borderColor: vehicle.color }}
                  />
                  <span className="min-w-0">
                    <span className="block truncate">
                      <span className="sr-only">{STOP_KIND_LABELS[stop.kind]}&nbsp;: </span>
                      {trip?.patientName ?? "Course"}
                      {stop.loadAfter > 1 ? <span className="ml-1 text-xs font-medium text-shared-strong">(partagé)</span> : null}
                      {trip?.lockedVehicleId === vehicle.id && stop.kind === "PICKUP" ? (
                        <Lock role="img" aria-label="figée" className="ml-1 inline size-3 align-[-1px] text-slate-500" />
                      ) : null}
                    </span>
                    <span className="block truncate text-xs text-slate-500">{stop.address}</span>
                    {now ? (
                      <span
                        className={cn(
                          "tabular block text-xs",
                          now.tone === "done" && "text-emerald-700",
                          now.tone === "late" && "font-medium text-amber-800",
                          now.tone === "alert" && "font-medium text-red-700",
                          now.tone === "ok" && "text-slate-500",
                        )}
                      >
                        {now.text}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
    </Card>
  );
}
