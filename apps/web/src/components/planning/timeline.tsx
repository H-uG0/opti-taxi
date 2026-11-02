"use client";

import { memo, useMemo, type CSSProperties } from "react";
import { Badge, VehicleTypeBadge } from "@/components/ui/badge";
import { cn } from "@/components/ui/cn";
import { sharedLoadColor } from "@/lib/planning/colors";
import { formatEurosRounded, formatKmRounded } from "@/lib/planning/format";
import { hourTicks, percentOf, routeSegments, type TimeRange } from "@/lib/planning/timeline";
import type { StopView, TripView, VehicleRowView } from "@/lib/planning/types";
import { DIRECTION_LABELS, formatPercent, ROUTE_STATUS_LABELS, STOP_KIND_LABELS } from "@/lib/labels";
import { formatMinute } from "@/lib/time";

export type TimelineProps = {
  rows: VehicleRowView[];
  trips: Record<string, TripView>;
  range: TimeRange;
  selectedTripId: string | null;
  selectedVehicleId: string | null;
  violatingTripIds: ReadonlySet<string>;
  onSelectTrip: (tripId: string) => void;
  onSelectVehicle: (vehicleId: string) => void;
};

/** Vehicle | track | figures (figures fold under the vehicle below xl). */
const ROW_GRID = "grid grid-cols-[12.5rem_minmax(30rem,1fr)] xl:grid-cols-[14rem_minmax(26rem,1fr)_19.5rem]";
const STATS_GRID = "grid grid-cols-[3.5rem_3rem_4.25rem_4.25rem_4.5rem] items-center gap-x-2 text-right";

const OFF_SHIFT_STYLE: CSSProperties = {
  backgroundImage: "repeating-linear-gradient(135deg, rgb(241 245 249) 0 6px, rgb(226 232 240) 6px 7px)",
};

function span(from: number, to: number, range: TimeRange): CSSProperties {
  const left = percentOf(from, range);
  return { left: `${left}%`, width: `${Math.max(0, percentOf(to, range) - left)}%` };
}

function stopTitle(stop: StopView, trip: TripView | undefined, trips: Record<string, TripView>): string {
  const lines = [
    `${formatMinute(stop.startMinute)} · ${STOP_KIND_LABELS[stop.kind]} · ${trip?.patientName ?? "Course inconnue"}`,
    stop.address,
  ];
  if (trip) {
    lines.push(
      trip.direction === "OUTBOUND"
        ? `${DIRECTION_LABELS.OUTBOUND} · RDV ${formatMinute(trip.appointmentMinute)}`
        : `${DIRECTION_LABELS.RETURN} · fin de séance ${formatMinute(trip.readyMinute)}`,
    );
    if (trip.coPassengerTripIds.length > 0) {
      const names = trip.coPassengerTripIds.map((id) => trips[id]?.patientName ?? "?").join(", ");
      lines.push(`Partagée avec ${names}`);
    }
    if (trip.lockedVehicleId) lines.push("Course figée sur ce véhicule");
    if (trip.status === "CANCELLED" || trip.status === "NO_SHOW") lines.push("Course annulée");
  }
  if (stop.arrivalMinute < stop.startMinute) {
    lines.push(`Arrivée ${formatMinute(stop.arrivalMinute)} (attente ${stop.startMinute - stop.arrivalMinute} min)`);
  }
  return lines.join("\n");
}

function segmentStyle(load: number, kind: string, color: string): { className: string; style: CSSProperties } {
  if (kind === "wait") {
    return {
      className: "h-0.5",
      style: { backgroundImage: `repeating-linear-gradient(90deg, ${load > 0 ? color : "rgb(148 163 184)"} 0 3px, transparent 3px 6px)` },
    };
  }
  const height = kind === "service" ? "h-3" : "h-2";
  if (load <= 0) return { className: cn(height, "bg-slate-300"), style: {} };
  if (load === 1) return { className: height, style: { background: color } };
  const dark = sharedLoadColor(color);
  return {
    className: height,
    style: { backgroundImage: `repeating-linear-gradient(135deg, ${dark} 0 4px, ${color} 4px 7px)` },
  };
}

type RowProps = {
  row: VehicleRowView;
  trips: Record<string, TripView>;
  range: TimeRange;
  selected: boolean;
  selectedTrip: TripView | null;
  violatingTripIds: ReadonlySet<string>;
  onSelectTrip: (tripId: string) => void;
  onSelectVehicle: (vehicleId: string) => void;
};

const TimelineRow = memo(function TimelineRow({
  row,
  trips,
  range,
  selected,
  selectedTrip,
  violatingTripIds,
  onSelectTrip,
  onSelectVehicle,
}: RowProps) {
  const route = row.route;
  const segments = useMemo(() => (route ? routeSegments(route) : []), [route]);
  const emptyRatio = route && route.distanceKm > 0 ? route.emptyKm / route.distanceKm : null;
  const companions = new Set(selectedTrip?.coPassengerTripIds ?? []);
  const stats = route ? (
    <>
      <span className="tabular">{formatKmRounded(route.distanceKm)}</span>
      <span className="tabular">{formatPercent(emptyRatio)}</span>
      <span className="tabular">{formatEurosRounded(route.revenue)}</span>
      <span className={cn("tabular", route.margin < 0 && "text-red-700")}>{formatEurosRounded(route.margin)}</span>
      <span>
        <Badge tone={route.status === "VALIDATED" ? "success" : "info"}>{ROUTE_STATUS_LABELS[route.status]}</Badge>
      </span>
    </>
  ) : null;

  // Bracket under the selected trip and its co-passengers on this row.
  const brackets: Array<{ tripId: string; from: number; to: number; main: boolean }> = [];
  if (selectedTrip && route) {
    for (const id of [selectedTrip.id, ...companions]) {
      const t = trips[id];
      if (t && t.vehicleId === row.id && t.plannedPickupMinute !== null && t.plannedDropoffMinute !== null) {
        brackets.push({ tripId: id, from: t.plannedPickupMinute, to: t.plannedDropoffMinute, main: id === selectedTrip.id });
      }
    }
  }

  return (
    <div
      role="row"
      className={cn(ROW_GRID, "border-b border-slate-100 last:border-b-0", selected ? "bg-brand-50/70" : "hover:bg-slate-50/70")}
    >
      <div role="rowheader" className={cn("min-w-0 border-l-4 py-1.5 pl-2 pr-3", selected ? "border-brand-600" : "border-transparent")}>
        <button
          type="button"
          onClick={() => onSelectVehicle(row.id)}
          aria-pressed={selected}
          className="block w-full min-w-0 rounded text-left focus-visible:outline-2 focus-visible:outline-brand-600"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: row.color }} />
            <span className="truncate text-sm font-medium text-slate-900">{row.label}</span>
            <VehicleTypeBadge type={row.type} />
          </span>
          <span className="mt-0.5 block truncate text-xs text-slate-500">
            {row.driverName ?? "Sans chauffeur"}
            {row.crewMateName ? ` + ${row.crewMateName}` : ""}
            {route ? ` · ${route.tripCount} course${route.tripCount > 1 ? "s" : ""}` : ""}
          </span>
          {!row.available ? (
            <span className="mt-0.5 block truncate text-xs font-medium text-red-700" title={row.unavailableReason ?? undefined}>
              Indisponible : {row.unavailableReason ?? "véhicule hors service"}
            </span>
          ) : null}
          {route ? (
            <span className="mt-0.5 block truncate text-xs text-slate-600 xl:hidden">
              <span className="tabular">
                {formatKmRounded(route.distanceKm)} · {formatPercent(emptyRatio)} à vide · {formatEurosRounded(route.revenue)} · marge{" "}
                {formatEurosRounded(route.margin)}
              </span>{" "}
              · {ROUTE_STATUS_LABELS[route.status]}
            </span>
          ) : null}
        </button>
      </div>

      <div role="cell" className="relative my-1.5 h-12 overflow-hidden rounded" style={row.shift ? OFF_SHIFT_STYLE : undefined}>
        {row.shift ? (
          <div
            aria-hidden
            className="absolute inset-y-0 bg-white ring-1 ring-inset ring-slate-200"
            style={span(row.shift.start, row.shift.end, range)}
            title={`Horaires : ${formatMinute(row.shift.start)} – ${formatMinute(row.shift.end)}`}
          />
        ) : (
          <div aria-hidden className="absolute inset-0 bg-white ring-1 ring-inset ring-slate-200" />
        )}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage: "linear-gradient(to right, rgb(226 232 240 / 0.8) 1px, transparent 1px)",
            backgroundSize: `${(60 / Math.max(60, range.end - range.start)) * 100}% 100%`,
          }}
        />
        {row.breakWindow && (route === null || route.breakStartMinute === null) ? (
          <div
            aria-hidden
            className="absolute inset-y-1 rounded border border-dashed border-amber-300"
            style={span(row.breakWindow.start, row.breakWindow.end, range)}
            title={`Fenêtre de pause ${formatMinute(row.breakWindow.start)} – ${formatMinute(row.breakWindow.end)} (${row.breakWindow.duration} min)`}
          />
        ) : null}
        {route && route.breakStartMinute !== null && route.breakEndMinute !== null ? (
          <div
            className="absolute inset-y-1 flex items-center justify-center overflow-hidden rounded bg-amber-100 text-[10px] font-medium text-amber-800 ring-1 ring-inset ring-amber-300"
            style={span(route.breakStartMinute, route.breakEndMinute, range)}
            title={`Pause ${formatMinute(route.breakStartMinute)} – ${formatMinute(route.breakEndMinute)}`}
          >
            Pause
          </div>
        ) : null}

        {segments.map((seg, i) => {
          const { className, style } = segmentStyle(seg.load, seg.kind, row.color);
          return (
            <div
              key={i}
              aria-hidden
              className={cn("absolute top-1/2 -translate-y-1/2 rounded-full", className)}
              style={{ ...span(seg.from, seg.to, range), ...style }}
            />
          );
        })}

        {brackets.map((b) => (
          <div
            key={b.tripId}
            aria-hidden
            className={cn("absolute bottom-0.5 h-1 rounded-full", b.main ? "bg-slate-900" : "bg-amber-400")}
            style={span(b.from, b.to, range)}
          />
        ))}

        {route?.stops.map((stop) => {
          const trip = trips[stop.tripId];
          const isSelected = selectedTrip?.id === stop.tripId;
          const isCompanion = companions.has(stop.tripId);
          const violating = violatingTripIds.has(stop.tripId);
          const cancelled = trip?.status === "CANCELLED" || trip?.status === "NO_SHOW";
          const pickup = stop.kind === "PICKUP";
          const title = stopTitle(stop, trip, trips);
          return (
            <button
              key={stop.id}
              type="button"
              title={title}
              aria-label={title.replaceAll("\n", ", ")}
              aria-pressed={isSelected}
              tabIndex={pickup ? 0 : -1}
              onClick={() => onSelectTrip(stop.tripId)}
              className="group absolute top-1/2 z-10 grid size-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-brand-600"
              style={{ left: `${percentOf(stop.startMinute, range)}%` }}
            >
              <span
                aria-hidden
                className={cn(
                  "block size-3 border-2 transition-transform group-hover:scale-125",
                  trip?.lockedVehicleId ? "rounded-[2px]" : "rounded-full",
                  isSelected && "scale-125 ring-2 ring-slate-900 ring-offset-1",
                  !isSelected && isCompanion && "ring-2 ring-amber-400 ring-offset-1",
                  !isSelected && !isCompanion && violating && "ring-2 ring-red-500 ring-offset-1",
                  stop.completed && "opacity-60",
                )}
                style={
                  cancelled
                    ? { background: "rgb(203 213 225)", borderColor: "rgb(100 116 139)" }
                    : pickup
                      ? { background: row.color, borderColor: "#ffffff" }
                      : { background: "#ffffff", borderColor: row.color }
                }
              />
            </button>
          );
        })}

        {!route ? (
          <span className="absolute inset-0 flex items-center justify-center text-xs text-slate-400">
            {row.available ? "Disponible — aucune course" : ""}
          </span>
        ) : null}
      </div>

      <div role="cell" className={cn("hidden px-3 text-xs text-slate-700 xl:grid", STATS_GRID)}>
        {stats}
      </div>
    </div>
  );
});

export function Timeline({
  rows,
  trips,
  range,
  selectedTripId,
  selectedVehicleId,
  violatingTripIds,
  onSelectTrip,
  onSelectVehicle,
}: TimelineProps) {
  const ticks = hourTicks(range);
  const selectedTrip = selectedTripId ? (trips[selectedTripId] ?? null) : null;
  const relevantRows = new Set<string>();
  if (selectedTrip) {
    if (selectedTrip.vehicleId) relevantRows.add(selectedTrip.vehicleId);
    for (const id of selectedTrip.coPassengerTripIds) {
      const vehicleId = trips[id]?.vehicleId;
      if (vehicleId) relevantRows.add(vehicleId);
    }
  }

  return (
    <div className="overflow-x-auto">
      <div role="table" aria-label="Frise des tournées par véhicule" className="min-w-[44rem]">
        <div role="row" className={cn(ROW_GRID, "border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600")}>
          <div role="columnheader" className="px-3 py-2 uppercase tracking-wide">
            Véhicule
          </div>
          <div role="columnheader" className="relative h-8">
            <span className="sr-only">
              Frise de {formatMinute(range.start)} à {formatMinute(range.end)}
            </span>
            {ticks.map((m) => (
              <span
                key={m}
                aria-hidden
                className="tabular absolute top-1/2 -translate-x-1/2 -translate-y-1/2 text-[11px] font-medium text-slate-500"
                style={{ left: `${percentOf(m, range)}%` }}
              >
                {Math.floor(m / 60) % 24} h
              </span>
            ))}
          </div>
          <div role="columnheader" className={cn("hidden px-3 uppercase tracking-wide xl:grid", STATS_GRID)}>
            <span>Km</span>
            <span>Vide</span>
            <span>CA</span>
            <span>Marge</span>
            <span className="text-left">Statut</span>
          </div>
        </div>
        {rows.map((row) => (
          <TimelineRow
            key={row.id}
            row={row}
            trips={trips}
            range={range}
            selected={row.id === selectedVehicleId}
            selectedTrip={relevantRows.has(row.id) ? selectedTrip : null}
            violatingTripIds={violatingTripIds}
            onSelectTrip={onSelectTrip}
            onSelectVehicle={onSelectVehicle}
          />
        ))}
      </div>
    </div>
  );
}

/** Key to the timeline symbols. */
export function TimelineLegend() {
  const item = "inline-flex items-center gap-1.5";
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600" aria-label="Légende de la frise">
      <li className={item}>
        <span aria-hidden className="h-2 w-6 rounded-full bg-slate-300" /> À vide
      </li>
      <li className={item}>
        <span aria-hidden className="h-2 w-6 rounded-full bg-slate-700" /> 1 patient
      </li>
      <li className={item}>
        <span
          aria-hidden
          className="h-2 w-6 rounded-full"
          style={{ backgroundImage: "repeating-linear-gradient(135deg, #1e293b 0 4px, #475569 4px 7px)" }}
        />{" "}
        2 patients (partagé)
      </li>
      <li className={item}>
        <span aria-hidden className="size-3 rounded-full border-2 border-white bg-slate-700 ring-1 ring-slate-300" /> Prise en charge
      </li>
      <li className={item}>
        <span aria-hidden className="size-3 rounded-full border-2 border-slate-700 bg-white" /> Dépose
      </li>
      <li className={item}>
        <span aria-hidden className="size-3 rounded-[2px] border-2 border-white bg-slate-700 ring-1 ring-slate-300" /> Course figée
      </li>
      <li className={item}>
        <span aria-hidden className="h-3 w-6 rounded bg-amber-100 ring-1 ring-inset ring-amber-300" /> Pause
      </li>
      <li className={item}>
        <span aria-hidden className="h-3 w-6 rounded ring-1 ring-inset ring-slate-200" style={OFF_SHIFT_STYLE} /> Hors horaires
      </li>
    </ul>
  );
}
