"use client";

import { X } from "lucide-react";
import { Badge, VehicleTypeBadge } from "@/components/ui/badge";
import { Card } from "@/components/ui/layout";
import { cn } from "@/components/ui/cn";
import { formatEurosRounded, formatKmRounded } from "@/lib/planning/format";
import type { TripView, VehicleRowView } from "@/lib/planning/types";
import { formatPercent, ROUTE_STATUS_LABELS, STOP_KIND_LABELS } from "@/lib/labels";
import { formatMinute } from "@/lib/time";

/** Selected vehicle: crew, hours, figures and the ordered stops of its route. */
export function VehiclePanel({
  vehicle,
  trips,
  onSelectTrip,
  onClose,
}: {
  vehicle: VehicleRowView;
  trips: Record<string, TripView>;
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
            <VehicleTypeBadge type={vehicle.type} />
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
        {!vehicle.available ? <p className="text-red-700">Indisponible : {vehicle.unavailableReason ?? "hors service"}</p> : null}
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
      </div>

      {route ? (
        <ol className="max-h-96 overflow-y-auto border-t border-slate-100 px-2 py-2">
          {route.stops.map((stop) => {
            const trip = trips[stop.tripId];
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
                      <span className="sr-only">{STOP_KIND_LABELS[stop.kind]} : </span>
                      {trip?.patientName ?? "Course"}
                      {stop.loadAfter > 1 ? <span className="ml-1 text-xs text-amber-700">(partagé)</span> : null}
                    </span>
                    <span className="block truncate text-xs text-slate-500">{stop.address}</span>
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
