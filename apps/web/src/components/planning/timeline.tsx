"use client";

import { memo, useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { ChevronRight, Lock } from "lucide-react";
import { Badge, VehicleTypeBadge } from "@/components/ui/badge";
import { cn } from "@/components/ui/cn";
import { OUTBOUND_NO_SHOW_LABEL } from "@/lib/domain/no-show";
import { sharedLoadColor } from "@/lib/planning/colors";
import { lockedTripCount, type DepotGroupView as TimelineGroup } from "@/lib/planning/filter";
import { formatEurosRounded, formatKmRounded, pluralize } from "@/lib/planning/format";
import { normalizeText } from "@/lib/planning/search";
import { hourTicks, percentOf, routeSegments, type TimeRange } from "@/lib/planning/timeline";
import type { StopView, TripView, VehicleRowView } from "@/lib/planning/types";
import { DIRECTION_LABELS, formatPercent, ROUTE_STATUS_LABELS, STOP_KIND_LABELS, VEHICLE_TYPE_SHORT } from "@/lib/labels";
import { formatMinute } from "@/lib/time";

export type { DepotGroupView as TimelineGroup } from "@/lib/planning/filter";

export type TimelineProps = {
  groups: TimelineGroup[];
  trips: Record<string, TripView>;
  range: TimeRange;
  selectedTripId: string | null;
  selectedVehicleId: string | null;
  violatingTripIds: ReadonlySet<string>;
  onSelectTrip: (tripId: string) => void;
  onSelectVehicle: (vehicleId: string) => void;
  /** Depot groups folded: their rows are not drawn. */
  collapsed?: ReadonlySet<string>;
  onToggleGroup?: (depotId: string) => void;
  /** Buttons of a group header (« Figer », « Défiger » the depot). */
  groupActions?: (group: TimelineGroup) => ReactNode;
  /** 28 px rows on one line. */
  compact?: boolean;
  /** Said when no row is left (« Aucun véhicule ne correspond aux filtres. » by default). */
  emptyText?: string;
  className?: string;
};

/**
 * Columns, declared once on the table and shared by every row through CSS
 * subgrid, so the header and all rows line up whatever their content.
 *
 * The layout follows a container query on the card (not the viewport), at
 * 57rem = 912 px of card width:
 * - from 57rem: vehicle | track | Km | Vide | CA | Marge | Statut. The figure
 *   columns are sized to their widest value (about 19rem, 21rem with 4-digit
 *   amounts), so none is cut off; the track takes the rest, 24rem at least.
 *   A 1280 px window gets it even with a classic 15 px vertical scrollbar:
 *   1280 - 15 - 240 (sidebar) - 64 (main padding) - 2 (card border) = 959 px.
 * - below (the planning's board, next to the map and the panel): vehicle |
 *   track (22rem at least), the figures wrap under the vehicle name (hidden
 *   in the compact density).
 * If the content ever needs more room than the card (4-digit amounts right at
 * the breakpoint, narrow screens), the table scrolls inside the card with the
 * vehicle column pinned: nothing is clipped.
 *
 * The table scrolls in its own box (fixed height, given by the page): the time
 * axis stays pinned at the top, each depot's header under it while its rows
 * scroll, the vehicle column on the left.
 */
const TABLE_GRID =
  "grid min-w-[36rem] grid-cols-[14rem_minmax(22rem,1fr)] @min-[57rem]:grid-cols-[14rem_minmax(24rem,1fr)_repeat(5,auto)]";
const ROW = "col-span-full grid grid-cols-subgrid";
/** Figure cells: only in the wide layout. */
const STAT_CELL = "hidden self-center px-2 text-right @min-[57rem]:block";
const STAT_LAST_CELL = "hidden self-center pl-2 pr-3 text-left @min-[57rem]:block";
const STAT_HEADERS = ["Km", "Vide", "CA", "Marge"] as const;

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
    if (trip.status === "CANCELLED") lines.push("Course annulée");
    if (trip.status === "NO_SHOW") lines.push("Patient absent");
    if (trip.outboundNoShow) lines.push(OUTBOUND_NO_SHOW_LABEL);
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
  compact: boolean;
};

/**
 * The label without its depot (« Taxi 1 (Marseille) » → « Taxi 1 »): the row
 * sits under its depot's header, which names it.
 */
export function shortVehicleLabel(row: Pick<VehicleRowView, "label" | "depot">): string {
  const match = /^(.*\S)\s*\(([^()]*)\)$/.exec(row.label);
  return match?.[1] && match[2] !== undefined && normalizeText(match[2]) === normalizeText(row.depot.label) ? match[1] : row.label;
}

const TimelineRow = memo(function TimelineRow({
  row,
  trips,
  range,
  selected,
  selectedTrip,
  violatingTripIds,
  onSelectTrip,
  onSelectVehicle,
  compact,
}: RowProps) {
  const route = row.route;
  const segments = useMemo(() => (route ? routeSegments(route) : []), [route]);
  const emptyRatio = route && route.distanceKm > 0 ? route.emptyKm / route.distanceKm : null;
  const companions = new Set(selectedTrip?.coPassengerTripIds ?? []);
  const crew = (row.driverName ?? "Sans chauffeur") + (row.crewMateName ? ` + ${row.crewMateName}` : "");
  const tripCountLabel = route ? ` · ${route.tripCount} course${route.tripCount > 1 ? "s" : ""}` : "";
  const crewLine = crew + tripCountLabel;
  const locked = lockedTripCount(row, trips);
  const label = shortVehicleLabel(row);
  // « Taxi 12 » already says its type: the badge would repeat it.
  const labelSaysType = normalizeText(label).startsWith(normalizeText(VEHICLE_TYPE_SHORT[row.type]));
  const off = !row.available && !route;
  const lockedMark =
    locked > 0 ? (
      <span
        className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-slate-600"
        title={`${pluralize(locked, "course figée", "courses figées")} sur ce véhicule`}
      >
        <Lock aria-hidden className="size-3" />
        <span className="tabular">{locked}</span>
        <span className="sr-only"> {locked > 1 ? "courses figées" : "course figée"}</span>
      </span>
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
      data-vehicle-id={row.id}
      className={cn(
        ROW,
        "group/row border-b border-slate-100 text-xs text-slate-700 last:border-b-0",
        selected ? "bg-brand-50" : "hover:bg-slate-50",
      )}
    >
      {/* Opaque background: the cell stays pinned over the track when the table scrolls. */}
      <div
        role="rowheader"
        className={cn(
          "sticky left-0 z-20 min-w-0 border-l-4 pl-2 pr-3",
          compact ? "py-0.5" : "py-1.5",
          selected ? "border-brand-600 bg-brand-50" : "border-transparent bg-white group-hover/row:bg-slate-50",
        )}
      >
        <button
          type="button"
          onClick={() => onSelectVehicle(row.id)}
          aria-pressed={selected}
          title={[row.label, crewLine, row.unavailableReason ? `Indisponible : ${row.unavailableReason}` : null].filter(Boolean).join("\n")}
          className="block w-full min-w-0 rounded text-left focus-visible:outline-2 focus-visible:outline-brand-600"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: row.color }} />
            {/* The depot is the group's header: the full label goes to screen readers and the tooltip. */}
            <span aria-hidden className={cn("min-w-0 truncate text-sm font-medium text-slate-900", off && "text-slate-500")}>
              {label}
            </span>
            <span className="sr-only">
              {row.label}, dépôt {row.depot.label}
            </span>
            {labelSaysType ? null : <VehicleTypeBadge type={row.type} />}
            {compact && route ? (
              <span className="tabular shrink-0 text-[11px] text-slate-500">
                {route.tripCount} course{route.tripCount > 1 ? "s" : ""}
              </span>
            ) : null}
            {compact ? lockedMark : null}
            {compact && !row.available ? (
              <span className="shrink-0 text-[11px] font-medium text-red-700">
                <span aria-hidden>Indispo.</span>
                <span className="sr-only">Indisponible : {row.unavailableReason ?? "véhicule hors service"}</span>
              </span>
            ) : null}
          </span>
          {compact ? null : (
            // The crew names give way first: the trip count stays visible.
            <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-slate-500" title={crewLine}>
              <span className="truncate">{crew}</span>
              {tripCountLabel ? <span className="-ml-1 shrink-0 whitespace-pre">{tripCountLabel}</span> : null}
              {lockedMark}
            </span>
          )}
          {!row.available && !compact ? (
            <span className="mt-0.5 block truncate text-xs font-medium text-red-700" title={row.unavailableReason ?? undefined}>
              Indisponible : {row.unavailableReason ?? "véhicule hors service"}
            </span>
          ) : null}
          {route && !compact ? (
            // Narrow layout: the figures wrap between items (never inside one), so none is hidden.
            <span
              className="mt-0.5 block truncate text-xs text-slate-600 @min-[57rem]:hidden"
              title={`CA ${formatEurosRounded(route.revenue)} · ${ROUTE_STATUS_LABELS[route.status]}`}
            >
              <span className="tabular">{formatKmRounded(route.distanceKm)}</span> ·{" "}
              <span className="tabular">vide {formatPercent(emptyRatio)}</span> ·{" "}
              <span className={cn("tabular", route.margin < 0 && "text-red-700")}>marge {formatEurosRounded(route.margin)}</span>
              {route.status === "VALIDATED" ? " · validée" : ""}
            </span>
          ) : null}
        </button>
      </div>

      <div
        role="cell"
        className={cn("relative self-center overflow-hidden rounded", compact ? "my-0.5 h-6" : "my-1.5 h-12")}
        style={row.shift || off ? OFF_SHIFT_STYLE : undefined}
      >
        {row.shift ? (
          <div
            aria-hidden
            className="absolute inset-y-0 bg-white ring-1 ring-inset ring-slate-200"
            style={span(row.shift.start, row.shift.end, range)}
            title={`Horaires : ${formatMinute(row.shift.start)} – ${formatMinute(row.shift.end)}`}
          />
        ) : off ? null : (
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
          const returnToCheck = pickup && trip?.outboundNoShow === true;
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
              {returnToCheck ? <ReturnToCheckMark className="absolute -top-1.5 -right-1" /> : null}
            </button>
          );
        })}

        {!route && row.available && !compact ? (
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="rounded bg-white/90 px-1.5 text-xs text-slate-400">Disponible — aucune course</span>
          </span>
        ) : null}
      </div>

      <div role="cell" className={cn(STAT_CELL, "tabular")}>
        {route ? formatKmRounded(route.distanceKm) : null}
      </div>
      <div role="cell" className={cn(STAT_CELL, "tabular")}>
        {route ? formatPercent(emptyRatio) : null}
      </div>
      <div role="cell" className={cn(STAT_CELL, "tabular")}>
        {route ? formatEurosRounded(route.revenue) : null}
      </div>
      <div role="cell" className={cn(STAT_CELL, "tabular", route && route.margin < 0 && "text-red-700")}>
        {route ? formatEurosRounded(route.margin) : null}
      </div>
      <div role="cell" className={STAT_LAST_CELL}>
        {route ? (
          <Badge tone={route.status === "VALIDATED" ? "success" : "info"}>{ROUTE_STATUS_LABELS[route.status]}</Badge>
        ) : null}
      </div>
    </div>
  );
});

/** "!" on the pickup of a return trip whose outbound leg was closed as patient absent. */
function ReturnToCheckMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-3 place-items-center rounded-full bg-red-600 text-[8px] leading-none font-bold text-white ring-1 ring-white",
        className,
      )}
    >
      !
    </span>
  );
}

/**
 * Scrolls `row` into the visible part of `scroller`, below the pinned time axis
 * and depot header (never the page itself: the board fits the screen).
 */
function revealRow(scroller: HTMLElement, row: HTMLElement) {
  const axis = scroller.querySelector<HTMLElement>("[data-timeline-axis]")?.offsetHeight ?? 0;
  const groupHeader = row.closest("[data-depot-group]")?.querySelector<HTMLElement>("[data-depot-header]")?.offsetHeight ?? 0;
  const box = scroller.getBoundingClientRect();
  const rect = row.getBoundingClientRect();
  const top = box.top + axis + groupHeader;
  if (rect.top < top) scroller.scrollTop -= top - rect.top + 4;
  else if (rect.bottom > box.bottom) scroller.scrollTop += Math.min(rect.bottom - box.bottom + 4, rect.top - top);
}

export function Timeline({
  groups,
  trips,
  range,
  selectedTripId,
  selectedVehicleId,
  violatingTripIds,
  onSelectTrip,
  onSelectVehicle,
  collapsed,
  onToggleGroup,
  groupActions,
  compact = false,
  emptyText = "Aucun véhicule ne correspond aux filtres.",
  className,
}: TimelineProps) {
  const scroller = useRef<HTMLDivElement>(null);
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

  // Any selection (search, map, « À traiter », link) brings its row into view.
  useEffect(() => {
    const box = scroller.current;
    if (!box || !selectedVehicleId) return;
    const row = Array.from(box.querySelectorAll<HTMLElement>("[data-vehicle-id]")).find((r) => r.dataset.vehicleId === selectedVehicleId);
    if (row) revealRow(box, row);
  }, [selectedVehicleId, selectedTripId, compact]);

  return (
    // @container: the column layout follows the card width (see TABLE_GRID).
    <div ref={scroller} className={cn("@container relative overflow-auto overscroll-contain", className)}>
      <div role="table" aria-label="Frise des tournées par véhicule" className={TABLE_GRID}>
        <div
          role="row"
          data-timeline-axis
          className={cn(ROW, "sticky top-0 z-30 h-8 border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600")}
        >
          <div role="columnheader" className="sticky left-0 z-20 flex items-center bg-slate-50 px-3 uppercase tracking-wide">
            Véhicule
          </div>
          <div role="columnheader" className="relative h-8">
            <span className="sr-only">
              Frise de {formatMinute(range.start)} à {formatMinute(range.end)}
            </span>
            {ticks.map((m) => {
              const left = percentOf(m, range);
              // Labels stay inside the axis: the first one starts at the edge instead of hiding under the
              // pinned vehicle column, the one at the very end (no room left) is not labelled.
              if (left >= 100) return null;
              return (
                <span
                  key={m}
                  aria-hidden
                  className={cn(
                    "tabular absolute top-1/2 -translate-y-1/2 text-[11px] font-medium whitespace-nowrap text-slate-500",
                    left <= 0 ? "translate-x-0.5" : "-translate-x-1/2",
                  )}
                  style={{ left: `${left}%` }}
                >
                  {Math.floor(m / 60) % 24} h
                </span>
              );
            })}
          </div>
          {STAT_HEADERS.map((label) => (
            <div key={label} role="columnheader" className={cn(STAT_CELL, "uppercase tracking-wide")}>
              {label}
            </div>
          ))}
          <div role="columnheader" className={cn(STAT_LAST_CELL, "uppercase tracking-wide")}>
            Statut
          </div>
        </div>
        {groups.map((group) => {
          const folded = collapsed?.has(group.id) === true && !group.rows.some((r) => r.id === selectedVehicleId);
          const bodyId = `depot-group-${group.id}`;
          return (
            <div key={group.id} role="rowgroup" data-depot-group={group.id} className="col-span-full grid grid-cols-subgrid">
              <div
                role="row"
                data-depot-header
                className={cn(ROW, "sticky top-8 z-[25] border-b border-slate-200 bg-slate-100/95 text-xs text-slate-700")}
              >
                <div role="rowheader" className="col-span-full">
                  <div className="sticky left-0 flex w-fit max-w-full flex-wrap items-center gap-x-3 gap-y-0.5 px-2 py-1">
                    <button
                      type="button"
                      onClick={() => onToggleGroup?.(group.id)}
                      aria-expanded={!folded}
                      aria-controls={bodyId}
                      disabled={!onToggleGroup}
                      className="-mx-1 inline-flex min-h-6 items-center gap-1 rounded px-1 text-sm font-semibold text-slate-900 hover:bg-slate-200/70 focus-visible:outline-2 focus-visible:outline-brand-600"
                    >
                      <ChevronRight aria-hidden className={cn("size-4 transition-transform", !folded && "rotate-90")} />
                      Dépôt {group.label}
                    </button>
                    {groupActions ? <span className="-ml-1.5 inline-flex items-center gap-0.5">{groupActions(group)}</span> : null}
                    <span className="tabular text-slate-600">
                      {group.rows.length < group.fleet
                        ? `${group.rows.length} sur ${pluralize(group.fleet, "véhicule")}`
                        : pluralize(group.fleet, "véhicule")}
                    </span>
                    {/* Subtotals of the routes shown (none before the day is optimized). */}
                    {group.rows.some((r) => r.route !== null) ? (
                      <span className="tabular text-slate-600">
                        {pluralize(group.totals.tripsServed, "course")} · {formatKmRounded(group.totals.totalKm)} · vide{" "}
                        {formatPercent(group.totals.emptyKmRatio)} · marge{" "}
                        <span className={cn(group.totals.margin < 0 && "font-medium text-red-700")}>
                          {formatEurosRounded(group.totals.margin)}
                        </span>
                      </span>
                    ) : null}
                    {group.locked > 0 ? (
                      <span className="tabular inline-flex items-center gap-0.5 text-slate-600">
                        <Lock aria-hidden className="size-3" />
                        {pluralize(group.locked, "figée", "figées")}
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
              {folded ? null : (
                <div id={bodyId} role="presentation" className="col-span-full grid grid-cols-subgrid">
                  {group.rows.map((row) => (
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
                      compact={compact}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {groups.length === 0 ? (
          <div role="row" className={ROW}>
            <div role="cell" className="col-span-full px-4 py-8 text-center text-sm text-slate-500">
              {emptyText}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Key to the timeline symbols; the "return to check" mark only when the day has one. */
export function TimelineLegend({ showReturnToCheck = false }: { showReturnToCheck?: boolean }) {
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
      {showReturnToCheck ? (
        <li className={cn(item, "font-medium text-red-800")}>
          <ReturnToCheckMark /> Retour à vérifier (aller : patient absent)
        </li>
      ) : null}
    </ul>
  );
}
