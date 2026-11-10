"use client";

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ChevronRight, Lock, TriangleAlert } from "lucide-react";
import { Badge, VehicleTypeBadge } from "@/components/ui/badge";
import { cn } from "@/components/ui/cn";
import { IDLE_VEHICLE_COLOR } from "@/lib/planning/colors";
import { lockedTripCount, type DepotGroupView as TimelineGroup } from "@/lib/planning/filter";
import { formatEurosRounded, formatKmRounded, pluralize } from "@/lib/planning/format";
import { normalizeText } from "@/lib/planning/search";
import { percentOf, type TimeRange } from "@/lib/planning/timeline";
import {
  appointmentMark,
  assignLanes,
  axisSteps,
  axisTicks,
  freeSlots,
  minutesForPx,
  MIN_TARGET_PX,
  routeBlocks,
  unassignedWindow,
  zoomFactor,
  zoomIn,
  ZOOM_LABELS,
  ZOOM_LEVELS,
  type TripBlock,
  type WaitWindows,
  type ZoomLevel,
} from "@/lib/planning/timeline-layout";
import type { TripView, VehicleRowView, ViolationView } from "@/lib/planning/types";
import { NO_VIOLATIONS, violationLabels, type ViolationIndex } from "@/lib/planning/violation-index";
import { formatPercent, ROUTE_STATUS_LABELS, VEHICLE_TYPE_SHORT } from "@/lib/labels";
import { formatDuration, formatMinute } from "@/lib/time";
import { ClusterPopover } from "./cluster-popover";
import { ReturnToCheckMark, SHARED_STRIPES, span, TrackTrips, type OpenCluster } from "./timeline-track";
import { ROVING_PREFERRED, ROVING_ROW, useRovingGrid } from "./use-roving-grid";

export type { DepotGroupView as TimelineGroup } from "@/lib/planning/filter";

export type TimelineProps = {
  groups: TimelineGroup[];
  trips: Record<string, TripView>;
  range: TimeRange;
  selectedTripId: string | null;
  selectedVehicleId: string | null;
  /** Violations by trip and by vehicle (badge on the row, shape on the trip). */
  violations?: ViolationIndex;
  /** Display color of each vehicle (lib/planning/colors displayColors); a vehicle missing: its own color. */
  colors?: ReadonlyMap<string, string>;
  /** Trips without a vehicle, drawn on the pinned « À placer » row (none: no row). */
  unassignedTripIds?: readonly string[];
  /** Windows the « À placer » row draws a trip on. */
  waitWindows?: WaitWindows;
  onSelectTrip: (tripId: string) => void;
  onSelectVehicle: (vehicleId: string) => void;
  /** Depot groups folded: their rows are not drawn. */
  collapsed?: ReadonlySet<string>;
  onToggleGroup?: (depotId: string) => void;
  /** Buttons of a group header (« Figer », « Défiger » the depot). */
  groupActions?: (group: TimelineGroup) => ReactNode;
  /** 28 px rows on one line. */
  compact?: boolean;
  /** Time shown in the visible part of the track (scrolls sideways when zoomed in). */
  zoom?: ZoomLevel;
  /** With it, the zoom choice sits on the axis (« Journée, 4 h, 2 h »). */
  onZoomChange?: (zoom: ZoomLevel) => void;
  /** Said when no row is left (« Aucun véhicule ne correspond aux filtres. » by default). */
  emptyText?: string;
  className?: string;
};

/**
 * Columns, declared once on the grid and shared by every row through CSS
 * subgrid, so the header and all rows line up whatever their content.
 *
 * The whole day (« Journée ») follows a container query on the card (not the
 * viewport), at 57rem = 912 px of card width:
 * - from 57rem: vehicle | track | Km | Vide | CA | Marge | Statut. The figure
 *   columns are sized to their widest value (about 19rem, 21rem with 4-digit
 *   amounts), so none is cut off; the track takes the rest, 24rem at least.
 *   A 1280 px window gets it even with a classic 15 px vertical scrollbar:
 *   1280 - 15 - 240 (sidebar) - 64 (main padding) - 2 (card border) = 959 px.
 * - below (the planning's board, next to the map and the panel): vehicle |
 *   track (22rem at least), the figures wrap under the vehicle name (hidden
 *   in the compact density).
 * Zoomed in (« 4 h », « 2 h »), the track is as many times wider than the
 * visible part as the day is longer than 4 h or 2 h (100cqw: the card's
 * width), and scrolls sideways under the pinned vehicle column; the figures
 * wrap under the vehicle name.
 *
 * The grid scrolls in its own box (fixed height, given by the page): the time
 * axis stays pinned at the top, the « À placer » row under it, each depot's
 * header under them while its rows scroll, the vehicle column on the left.
 */
const DAY_GRID =
  "grid min-w-[36rem] grid-cols-[14rem_minmax(22rem,1fr)] @min-[57rem]:grid-cols-[14rem_minmax(24rem,1fr)_repeat(5,auto)]";
const ZOOMED_GRID = "grid grid-cols-[14rem_var(--track-w)]";
const ROW = "col-span-full grid grid-cols-subgrid";
/** Figure cells: only in the wide layout of the whole day. */
const STAT_CELL = "hidden self-center px-2 text-right @min-[57rem]:block";
const STAT_LAST_CELL = "hidden self-center pl-2 pr-3 text-left @min-[57rem]:block";
const STAT_HEADERS = ["Km", "Vide", "CA", "Marge"] as const;

/** Track width assumed before it is measured (server render). */
const DEFAULT_TRACK_PX = 560;
/** Height of the pinned « À placer » row (24 px track, its margins, its border) in both densities: room stays for the vehicles. */
const PINNED_ROW_PX = 29;
const AXIS_PX = 32;
const NO_IDS: readonly string[] = [];
/** The settings' defaults (Paramètres), when the page gives none. */
const DEFAULT_WAITS: WaitWindows = { beforeAppointmentMin: 30, afterSessionMin: 15 };
const NO_COMPANIONS: ReadonlySet<string> = new Set();

const OFF_SHIFT_STYLE: CSSProperties = {
  backgroundImage: "repeating-linear-gradient(135deg, rgb(241 245 249) 0 6px, rgb(226 232 240) 6px 7px)",
};
/** A free slot: a light green wash over the track and a green bar along its bottom. */
const FREE_SLOT_STYLE: CSSProperties = {
  backgroundImage: "linear-gradient(to top, rgb(52 211 153 / 0.9) 0 3px, rgb(236 253 245 / 0.75) 3px)",
};

function gridLines(range: TimeRange, step: number): CSSProperties {
  return {
    backgroundImage: "linear-gradient(to right, rgb(226 232 240 / 0.8) 1px, transparent 1px)",
    backgroundSize: `${(step / Math.max(step, range.end - range.start)) * 100}% 100%`,
  };
}

/**
 * The label without its depot (« Taxi 1 (Marseille) » → « Taxi 1 »): the row
 * sits under its depot's header, which names it.
 */
export function shortVehicleLabel(row: Pick<VehicleRowView, "label" | "depot">): string {
  const match = /^(.*\S)\s*\(([^()]*)\)$/.exec(row.label);
  return match?.[1] && match[2] !== undefined && normalizeText(match[2]) === normalizeText(row.depot.label) ? match[1] : row.label;
}

type Geometry = { range: TimeRange; pxPerMin: number; minMinutes: number; compact: boolean; zoomed: boolean; gridStep: number };

type RowProps = {
  row: VehicleRowView;
  trips: Record<string, TripView>;
  geometry: Geometry;
  color: string;
  selected: boolean;
  selectedTrip: TripView | null;
  violationsByTrip: ReadonlyMap<string, ViolationView[]>;
  rowViolations: readonly ViolationView[] | undefined;
  openClusterKey: string | null;
  onSelectTrip: (tripId: string) => void;
  onSelectVehicle: (vehicleId: string) => void;
  onOpenCluster: OpenCluster;
};

/** Row badge: the vehicle's violations (its own and its trips'), by an icon and a count, named for screen readers. */
function ViolationBadge({ violations }: { violations: readonly ViolationView[] }) {
  const labels = violationLabels(violations);
  return (
    <span
      className="inline-flex shrink-0 items-center gap-0.5 rounded bg-slate-900 px-1 py-px text-[11px] leading-none font-semibold text-amber-300"
      title={`${pluralize(violations.length, "violation")} : ${labels}`}
    >
      <TriangleAlert aria-hidden className="size-3" strokeWidth={2.5} />
      <span className="tabular">{violations.length}</span>
      <span className="sr-only">
        {" "}
        {violations.length > 1 ? "violations" : "violation"} : {labels}
      </span>
    </span>
  );
}

const TimelineRow = memo(function TimelineRow({
  row,
  trips,
  geometry,
  color,
  selected,
  selectedTrip,
  violationsByTrip,
  rowViolations,
  openClusterKey,
  onSelectTrip,
  onSelectVehicle,
  onOpenCluster,
}: RowProps) {
  const { range, compact, zoomed } = geometry;
  const route = row.route;
  const layout = useMemo(() => (route ? routeBlocks(route.stops) : { blocks: [] as TripBlock[], lanes: 1 }), [route]);
  const slots = useMemo(() => freeSlots(row.shift, route), [row.shift, route]);
  const companions = useMemo(() => new Set(selectedTrip?.coPassengerTripIds ?? []), [selectedTrip]);
  const emptyRatio = route && route.distanceKm > 0 ? route.emptyKm / route.distanceKm : null;
  const crew = (row.driverName ?? "Sans chauffeur") + (row.crewMateName ? ` + ${row.crewMateName}` : "");
  const tripCountLabel = route ? ` · ${route.tripCount} course${route.tripCount > 1 ? "s" : ""}` : "";
  const crewLine = crew + tripCountLabel;
  const locked = lockedTripCount(row, trips);
  const label = shortVehicleLabel(row);
  // « Taxi 12 » already says its type: the badge would repeat it.
  const labelSaysType = normalizeText(label).startsWith(normalizeText(VEHICLE_TYPE_SHORT[row.type]));
  const off = !row.available && !route;
  const mark = selectedTrip && selectedTrip.vehicleId === row.id ? appointmentMark(selectedTrip) : null;
  const tripSelectedHere = selectedTrip !== null && selectedTrip.vehicleId === row.id;
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
  const violationMark = rowViolations && rowViolations.length > 0 ? <ViolationBadge violations={rowViolations} /> : null;
  // Short names: a screen reader says them when the focus enters the row or its track (the content is long).
  const rowName = [
    row.label,
    route ? pluralize(route.tripCount, "course") : row.available ? "sans tournée" : "indisponible",
    rowViolations && rowViolations.length > 0 ? pluralize(rowViolations.length, "violation") : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div
      role="row"
      aria-label={rowName}
      data-vehicle-id={row.id}
      {...{ [ROVING_ROW]: "" }}
      className={cn(
        ROW,
        "group/row border-b border-slate-100 text-xs text-slate-700 last:border-b-0",
        selected ? "bg-brand-50" : "hover:bg-slate-50",
      )}
    >
      {/* Opaque background: the cell stays pinned over the track when the grid scrolls. */}
      <div
        role="rowheader"
        className={cn(
          "sticky left-0 z-[22] min-w-0 border-l-4 pl-2 pr-3",
          compact ? "py-0.5" : "py-1.5",
          selected ? "border-brand-600 bg-brand-50" : "border-transparent bg-white group-hover/row:bg-slate-50",
        )}
      >
        <button
          type="button"
          tabIndex={-1}
          data-vehicle-button
          {...(selected && !tripSelectedHere ? { [ROVING_PREFERRED]: "" } : {})}
          onClick={() => onSelectVehicle(row.id)}
          aria-pressed={selected}
          title={[row.label, crewLine, row.unavailableReason ? `Indisponible : ${row.unavailableReason}` : null].filter(Boolean).join("\n")}
          className="block w-full min-w-0 rounded text-left focus-visible:outline-2 focus-visible:outline-brand-600"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: color }} />
            {/* The depot is the group's header: the full label goes to screen readers and the tooltip. */}
            <span aria-hidden className={cn("min-w-0 truncate text-sm font-medium text-slate-900", off && "text-slate-500")}>
              {label}
            </span>
            <span className="sr-only">
              {row.label}, dépôt {row.depot.label}
            </span>
            {labelSaysType ? null : <VehicleTypeBadge type={row.type} />}
            {violationMark}
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
            // Narrow layout or zoomed in: the figures wrap between items (never inside one), so none is hidden.
            <span
              className={cn("mt-0.5 block truncate text-xs text-slate-600", !zoomed && "@min-[57rem]:hidden")}
              title={`CA ${formatEurosRounded(route.revenue)} · ${ROUTE_STATUS_LABELS[route.status]}`}
            >
              <span className="tabular">{formatKmRounded(route.distanceKm)}</span> ·{" "}
              <span className="tabular">vide {formatPercent(emptyRatio)}</span> ·{" "}
              <span className={cn("tabular", route.margin < 0 && "text-red-700")}>marge {formatEurosRounded(route.margin)}</span>
              {route.status === "VALIDATED" ? " · validée" : ""}
            </span>
          ) : null}
        </button>
        {slots.length > 0 ? (
          <span className="sr-only">
            {slots.length > 1 ? "Créneaux libres" : "Créneau libre"} :{" "}
            {slots.map((s) => `${formatMinute(s.start)} – ${formatMinute(s.end)}`).join(", ")}.
          </span>
        ) : null}
      </div>

      <div
        role="gridcell"
        aria-label={route ? `Tournée de ${label} : ${pluralize(route.tripCount, "course")}` : `${label} : aucune course`}
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
        <div aria-hidden className="pointer-events-none absolute inset-0" style={gridLines(range, geometry.gridStep)} />
        {slots.map((slot) => {
          const widthPx = (slot.end - slot.start) * geometry.pxPerMin;
          return (
            <div
              key={slot.start}
              aria-hidden
              className="absolute inset-y-0.5 flex items-end justify-center overflow-hidden rounded-sm pb-1 text-[10px] leading-none whitespace-nowrap text-emerald-800"
              style={{ ...span(slot.start, slot.end, range), ...FREE_SLOT_STYLE }}
              title={`Libre de ${formatMinute(slot.start)} à ${formatMinute(slot.end)} (${formatDuration(slot.end - slot.start)})`}
            >
              {widthPx >= 80 && !compact ? <span className="mb-px">libre {formatDuration(slot.end - slot.start)}</span> : null}
            </div>
          );
        })}
        {row.breakWindow && (route === null || route.breakStartMinute === null) ? (
          <div
            aria-hidden
            className="absolute inset-y-1 rounded border border-dashed border-amber-300"
            style={span(row.breakWindow.start, row.breakWindow.end, range)}
            title={`Fenêtre de pause ${formatMinute(row.breakWindow.start)} – ${formatMinute(row.breakWindow.end)} (${row.breakWindow.duration} min)`}
          />
        ) : null}
        {route ? (
          <div
            aria-hidden
            className="absolute top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-slate-300"
            style={span(route.startMinute, route.endMinute, range)}
          />
        ) : null}
        {route && route.breakStartMinute !== null && route.breakEndMinute !== null ? (
          <div
            aria-hidden
            className="absolute inset-y-1 z-[5] flex items-center justify-center overflow-hidden rounded bg-amber-100 text-[10px] font-medium text-amber-800 ring-1 ring-inset ring-amber-300"
            style={span(route.breakStartMinute, route.breakEndMinute, range)}
            title={`Pause ${formatMinute(route.breakStartMinute)} – ${formatMinute(route.breakEndMinute)}`}
          >
            {(route.breakEndMinute - route.breakStartMinute) * geometry.pxPerMin >= 36 ? "Pause" : null}
          </div>
        ) : null}

        {route ? (
          <TrackTrips
            rowId={row.id}
            blocks={layout.blocks}
            lanes={layout.lanes}
            trips={trips}
            range={range}
            pxPerMin={geometry.pxPerMin}
            minMinutes={geometry.minMinutes}
            compact={compact}
            color={color}
            selectedTripId={selectedTrip?.id ?? null}
            companionIds={companions}
            violationsByTrip={violationsByTrip}
            mark={mark}
            openClusterKey={openClusterKey}
            onSelectTrip={onSelectTrip}
            onOpenCluster={onOpenCluster}
          />
        ) : null}

        {!route && row.available && !compact ? (
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="rounded bg-white/90 px-1.5 text-xs text-slate-400">Disponible — aucune course</span>
          </span>
        ) : null}
      </div>

      <div role="gridcell" className={cn(zoomed ? "hidden" : STAT_CELL, "tabular")}>
        {route ? formatKmRounded(route.distanceKm) : null}
      </div>
      <div role="gridcell" className={cn(zoomed ? "hidden" : STAT_CELL, "tabular")}>
        {route ? formatPercent(emptyRatio) : null}
      </div>
      <div role="gridcell" className={cn(zoomed ? "hidden" : STAT_CELL, "tabular")}>
        {route ? formatEurosRounded(route.revenue) : null}
      </div>
      <div role="gridcell" className={cn(zoomed ? "hidden" : STAT_CELL, "tabular", route && route.margin < 0 && "text-red-700")}>
        {route ? formatEurosRounded(route.margin) : null}
      </div>
      <div role="gridcell" className={zoomed ? "hidden" : STAT_LAST_CELL}>
        {route ? (
          <Badge tone={route.status === "VALIDATED" ? "success" : "info"}>{ROUTE_STATUS_LABELS[route.status]}</Badge>
        ) : null}
      </div>
    </div>
  );
});

type PinnedProps = {
  tripIds: readonly string[];
  trips: Record<string, TripView>;
  geometry: Geometry;
  waits: WaitWindows;
  selectedTrip: TripView | null;
  violationsByTrip: ReadonlyMap<string, ViolationView[]>;
  openClusterKey: string | null;
  onSelectTrip: (tripId: string) => void;
  onOpenCluster: OpenCluster;
};

export const UNASSIGNED_ROW_ID = "a-placer";

/**
 * « À placer », pinned under the axis: each trip without a vehicle on the
 * window where it must be served (drop-off before the appointment, pick-up
 * after the session), so that a free slot of the same time is easy to spot.
 */
const PinnedUnassignedRow = memo(function PinnedUnassignedRow({
  tripIds,
  trips,
  geometry,
  waits,
  selectedTrip,
  violationsByTrip,
  openClusterKey,
  onSelectTrip,
  onOpenCluster,
}: PinnedProps) {
  const { range } = geometry;
  const layout = useMemo(() => {
    const windows = tripIds.flatMap((id) => {
      const trip = trips[id];
      const slot = trip ? unassignedWindow(trip, waits) : null;
      return slot ? [{ tripId: id, from: slot.start, to: slot.end }] : [];
    });
    const { lanes, count } = assignLanes(windows);
    // Two lanes at most: more trips at the same time share the second one (their targets are merged).
    const blocks = windows
      .map((w, i) => ({ ...w, lane: Math.min(lanes[i] ?? 0, 1) }))
      .sort((a, b) => a.from - b.from || a.lane - b.lane);
    return { blocks, lanes: Math.min(count, 2), crowded: count > 2 };
  }, [tripIds, trips, waits]);
  const mark = selectedTrip && selectedTrip.vehicleId === null ? appointmentMark(selectedTrip) : null;
  const missing = tripIds.length - layout.blocks.length;

  return (
    <div
      role="row"
      data-pinned-row
      aria-label={`À placer, ${pluralize(tripIds.length, "course sans véhicule", "courses sans véhicule")}`}
      {...{ [ROVING_ROW]: "" }}
      className={cn(ROW, "sticky z-[27] border-b border-amber-200 bg-amber-50 text-xs text-slate-700")}
      style={{ top: AXIS_PX, height: PINNED_ROW_PX }}
    >
      <div role="rowheader" className="sticky left-0 z-[22] flex min-w-0 items-center bg-amber-50 pl-3 pr-3">
        <p
          className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-amber-900"
          title="Le créneau où chaque course sans véhicule doit être servie : arrivée avant le RDV (aller), prise en charge après la séance (retour)"
        >
          À placer
          <span className="tabular rounded-full bg-white px-1.5 text-xs font-medium ring-1 ring-amber-300">
            {tripIds.length}
            <span className="sr-only"> {tripIds.length > 1 ? "courses sans véhicule" : "course sans véhicule"}</span>
          </span>
          <span className="truncate text-xs font-normal text-amber-900/80">
            {missing > 0 ? `dont ${missing} sans horaire` : "créneau à servir"}
          </span>
        </p>
      </div>
      <div
        role="gridcell"
        aria-label={`Courses à placer : ${pluralize(tripIds.length, "course")}`}
        className="relative my-0.5 h-6 self-center overflow-hidden rounded bg-white/70"
      >
        <div aria-hidden className="pointer-events-none absolute inset-0" style={gridLines(range, geometry.gridStep)} />
        <TrackTrips
          rowId={UNASSIGNED_ROW_ID}
          blocks={layout.blocks}
          lanes={layout.lanes}
          mergeTargets={layout.crowded}
          trips={trips}
          range={range}
          pxPerMin={geometry.pxPerMin}
          minMinutes={geometry.minMinutes}
          compact
          color={null}
          selectedTripId={selectedTrip?.id ?? null}
          companionIds={NO_COMPANIONS}
          violationsByTrip={violationsByTrip}
          mark={mark}
          openClusterKey={openClusterKey}
          onSelectTrip={onSelectTrip}
          onOpenCluster={onOpenCluster}
        />
      </div>
    </div>
  );
});

/** The visible part of the scrolling box left free by its pinned parts (axis, « À placer », depot header, vehicle column). */
function revealInBox(scroller: HTMLElement, element: HTMLElement) {
  const box = scroller.getBoundingClientRect();
  const row = element.closest<HTMLElement>("[role='row']");
  if (row && !row.hasAttribute("data-pinned-row") && !row.hasAttribute("data-timeline-axis")) {
    const axis = scroller.querySelector<HTMLElement>("[data-timeline-axis]")?.offsetHeight ?? 0;
    const pinned = scroller.querySelector<HTMLElement>("[data-pinned-row]")?.offsetHeight ?? 0;
    const groupHeader = row.hasAttribute("data-depot-header")
      ? 0
      : (row.closest("[data-depot-group]")?.querySelector<HTMLElement>("[data-depot-header]")?.offsetHeight ?? 0);
    const rect = row.getBoundingClientRect();
    const top = box.top + axis + pinned + groupHeader;
    const bottom = box.top + scroller.clientHeight;
    if (rect.top < top) scroller.scrollTop -= top - rect.top + 4;
    else if (rect.bottom > bottom) scroller.scrollTop += Math.min(rect.bottom - bottom + 4, rect.top - top);
  }
  // Sideways (zoomed in): a trip of the track, not hidden under the vehicle column.
  if (element.closest("[role='gridcell']")) {
    const column = scroller.querySelector<HTMLElement>("[data-timeline-axis] [role='columnheader']")?.offsetWidth ?? 0;
    const left = box.left + column;
    const right = box.left + scroller.clientWidth;
    const rect = element.getBoundingClientRect();
    if (rect.left < left) scroller.scrollLeft -= left - rect.left + 8;
    else if (rect.right > right) scroller.scrollLeft += Math.min(rect.right - right + 8, rect.left - left);
  }
}

/** The zoom choice on the axis: a radio group (one Tab stop, arrows to change). */
function ZoomChoice({ zoom, onChange }: { zoom: ZoomLevel; onChange: (zoom: ZoomLevel) => void }) {
  const name = useId();
  return (
    <fieldset className="ml-auto flex shrink-0 rounded-md border border-slate-300 bg-white p-px normal-case tracking-normal">
      <legend className="sr-only">Zoom de la frise</legend>
      {ZOOM_LEVELS.map((level) => (
        <label key={level} className="relative">
          <input
            type="radio"
            name={name}
            value={level}
            checked={zoom === level}
            onChange={() => onChange(level)}
            className="peer absolute inset-0 cursor-pointer opacity-0"
            aria-label={level === "day" ? "Journée entière" : `${ZOOM_LABELS[level]} à l'écran`}
          />
          <span
            aria-hidden
            className={cn(
              "flex h-6 min-w-6 items-center justify-center rounded-[5px] px-1.5 text-xs font-medium",
              "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-brand-600",
              zoom === level ? "bg-brand-700 text-white" : "text-slate-600 peer-hover:bg-slate-100",
            )}
          >
            {ZOOM_LABELS[level]}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

type ClusterState = { rowId: string; key: string; tripIds: string[]; anchor: HTMLElement; from: number; to: number };

export function Timeline({
  groups,
  trips,
  range,
  selectedTripId,
  selectedVehicleId,
  violations = NO_VIOLATIONS,
  colors,
  unassignedTripIds = NO_IDS,
  waitWindows = DEFAULT_WAITS,
  onSelectTrip,
  onSelectVehicle,
  collapsed,
  onToggleGroup,
  groupActions,
  compact = false,
  zoom = "day",
  onZoomChange,
  emptyText = "Aucun véhicule ne correspond aux filtres.",
  className,
}: TimelineProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const trackHeader = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const [trackPx, setTrackPx] = useState(DEFAULT_TRACK_PX);
  const [cluster, setCluster] = useState<ClusterState | null>(null);
  const zoomed = zoom !== "day";
  const spanMinutes = range.end - range.start;
  const steps = axisSteps(range, zoom, trackPx / Math.max(1, spanMinutes));
  const ticks = axisTicks(range, zoom, trackPx / Math.max(1, spanMinutes));
  const geometry = useMemo<Geometry>(
    () => ({
      range,
      pxPerMin: trackPx / Math.max(1, spanMinutes),
      minMinutes: minutesForPx(MIN_TARGET_PX, trackPx, range),
      compact,
      zoomed,
      gridStep: steps.grid,
    }),
    [range, trackPx, spanMinutes, compact, zoomed, steps.grid],
  );
  const selectedTrip = selectedTripId ? (trips[selectedTripId] ?? null) : null;
  const relevantRows = new Set<string>();
  if (selectedTrip) {
    if (selectedTrip.vehicleId) relevantRows.add(selectedTrip.vehicleId);
    for (const id of selectedTrip.coPassengerTripIds) {
      const vehicleId = trips[id]?.vehicleId;
      if (vehicleId) relevantRows.add(vehicleId);
    }
  }
  const showPinned = unassignedTripIds.length > 0;

  // The track's width in pixels: how many minutes 24 px cover (targets), whether initials fit.
  useEffect(() => {
    const element = trackHeader.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry?.contentRect.width ?? 0);
      if (width > 0) setTrackPx((current) => (Math.abs(current - width) >= 4 ? width : current));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const reveal = useCallback((element: HTMLElement) => {
    if (scroller.current) revealInBox(scroller.current, element);
  }, []);
  const roving = useRovingGrid(grid, { selectionKey: `${selectedTripId ?? ""}|${selectedVehicleId ?? ""}`, reveal });

  /** Minute at the middle of the visible track, kept while scrolling: a zoom keeps it in the middle. */
  const centerMinute = useRef<number | null>(null);
  /** Where « Zoomer sur ce créneau » asked to look. */
  const pendingCenter = useRef<number | null>(null);
  const trackViewport = () => {
    const box = scroller.current;
    const column = box?.querySelector<HTMLElement>("[data-timeline-axis] [role='columnheader']")?.offsetWidth ?? 0;
    return { box, column, width: (box?.clientWidth ?? 0) - column };
  };
  const onScroll = () => {
    const { box, width } = trackViewport();
    const track = trackHeader.current?.offsetWidth ?? 0;
    if (!box || track <= 0) return;
    centerMinute.current = range.start + ((box.scrollLeft + width / 2) / track) * spanMinutes;
  };

  // A new zoom keeps the same time in the middle (or the trip selected, or the slot asked for).
  const lastZoom = useRef<ZoomLevel | null>(null);
  useLayoutEffect(() => {
    if (lastZoom.current === zoom) return;
    const first = lastZoom.current === null;
    lastZoom.current = zoom;
    const { box, width } = trackViewport();
    const track = trackHeader.current?.offsetWidth ?? 0;
    if (!box || track <= 0) return;
    if (zoom === "day") {
      box.scrollLeft = 0;
      return;
    }
    const trip = selectedTripId ? trips[selectedTripId] : undefined;
    // The middle of the selected trip: its block, or its window when it has no vehicle.
    const slot = trip && trip.vehicleId === null ? unassignedWindow(trip, waitWindows) : null;
    const tripMinute = !trip
      ? null
      : slot
        ? (slot.start + slot.end) / 2
        : trip.plannedPickupMinute !== null && trip.plannedDropoffMinute !== null
          ? (trip.plannedPickupMinute + trip.plannedDropoffMinute) / 2
          : (trip.plannedPickupMinute ?? trip.appointmentMinute ?? trip.readyMinute);
    const minute = pendingCenter.current ?? (first ? tripMinute : (centerMinute.current ?? tripMinute));
    pendingCenter.current = null;
    if (minute === null || minute === undefined) return;
    box.scrollLeft = Math.max(0, ((minute - range.start) / spanMinutes) * track - width / 2);
    centerMinute.current = minute;
    // Only when the zoom changes: the selection's own effect below moves the box otherwise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  // Any selection (search, map, « À traiter », link) brings its row, and its trip when zoomed in, into view.
  useEffect(() => {
    const box = scroller.current;
    if (!box || (!selectedVehicleId && !selectedTripId)) return;
    const rows = Array.from(box.querySelectorAll<HTMLElement>("[data-vehicle-id]"));
    const row = rows.find((r) => r.dataset.vehicleId === selectedVehicleId);
    if (row) revealInBox(box, row);
    if (selectedTripId) {
      const target = Array.from(box.querySelectorAll<HTMLElement>("[data-trip-ids]")).find((t) =>
        (t.dataset.tripIds ?? "").split(" ").includes(selectedTripId),
      );
      if (target) revealInBox(box, target);
    }
  }, [selectedVehicleId, selectedTripId, compact]);

  const clusterRef = useRef<ClusterState | null>(null);
  useLayoutEffect(() => {
    clusterRef.current = cluster;
  }, [cluster]);
  const openCluster = useCallback<OpenCluster>(({ key, tripIds, anchor, from, to }) => {
    const rowId = anchor.closest<HTMLElement>("[data-vehicle-id]")?.dataset.vehicleId ?? UNASSIGNED_ROW_ID;
    setCluster(clusterRef.current?.key === key ? null : { rowId, key, tripIds, anchor, from, to });
  }, []);
  const closeCluster = useCallback((restoreFocus: boolean) => {
    const anchor = clusterRef.current?.anchor;
    setCluster(null);
    if (restoreFocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
  }, []);
  const clusterEntries = useMemo(() => {
    if (!cluster) return [];
    return cluster.tripIds.map((id) => {
      const trip = trips[id];
      if (trip && trip.vehicleId === null) {
        const slot = unassignedWindow(trip, waitWindows);
        return { tripId: id, from: slot?.start ?? 0, to: slot?.end ?? 0 };
      }
      return { tripId: id, from: trip?.plannedPickupMinute ?? 0, to: trip?.plannedDropoffMinute ?? 0 };
    });
  }, [cluster, trips, waitWindows]);
  const violatingTripIds = useMemo(() => new Set(violations.byTrip.keys()), [violations]);
  const nextZoom = zoomIn(zoom);

  const pinnedPx = showPinned ? PINNED_ROW_PX : 0;
  const gridStyle = zoomed ? ({ "--track-w": `calc((100cqw - 14rem) * ${zoomFactor(range, zoom)})` } as CSSProperties) : undefined;

  return (
    // @container: the column layout follows the card width (see DAY_GRID).
    <div
      ref={scroller}
      onScroll={zoomed ? onScroll : undefined}
      className={cn("@container relative overflow-auto overscroll-contain", className)}
    >
      <p id={hintId} className="sr-only">
        Flèches haut et bas : véhicule précédent ou suivant ; gauche et droite : course précédente ou suivante ; Entrée :
        sélectionner ; Échap : désélectionner.
      </p>
      <div
        ref={grid}
        role="grid"
        aria-label="Frise des tournées par véhicule"
        aria-describedby={hintId}
        className={zoomed ? ZOOMED_GRID : DAY_GRID}
        style={gridStyle}
        onKeyDown={roving.onKeyDown}
        onFocus={roving.onFocus}
      >
        <div
          role="row"
          data-timeline-axis
          className={cn(ROW, "sticky top-0 z-30 h-8 border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600")}
        >
          <div role="columnheader" className="sticky left-0 z-[22] flex items-center gap-2 bg-slate-50 pr-1 pl-3 uppercase tracking-wide">
            <span>Véhicule</span>
            {onZoomChange ? <ZoomChoice zoom={zoom} onChange={onZoomChange} /> : null}
          </div>
          <div role="columnheader" ref={trackHeader} className="relative h-8">
            <span className="sr-only">
              Frise de {formatMinute(range.start)} à {formatMinute(range.end)}
            </span>
            {ticks.map((tick) => {
              const left = percentOf(tick.minute, range);
              // Labels stay inside the axis: the first one starts at the edge instead of hiding under the
              // pinned vehicle column, the one at the very end (no room left) is not labelled.
              if (left >= 100) return null;
              return (
                <span
                  key={tick.minute}
                  aria-hidden
                  className={cn(
                    "tabular absolute top-1/2 -translate-y-1/2 text-[11px] font-medium whitespace-nowrap text-slate-500",
                    left <= 0 ? "translate-x-0.5" : "-translate-x-1/2",
                  )}
                  style={{ left: `${left}%` }}
                >
                  {tick.label}
                </span>
              );
            })}
          </div>
          {STAT_HEADERS.map((label) => (
            <div key={label} role="columnheader" className={cn(zoomed ? "hidden" : STAT_CELL, "uppercase tracking-wide")}>
              {label}
            </div>
          ))}
          <div role="columnheader" className={cn(zoomed ? "hidden" : STAT_LAST_CELL, "uppercase tracking-wide")}>
            Statut
          </div>
        </div>
        {showPinned ? (
          <PinnedUnassignedRow
            tripIds={unassignedTripIds}
            trips={trips}
            geometry={geometry}
            waits={waitWindows}
            selectedTrip={selectedTrip && selectedTrip.vehicleId === null ? selectedTrip : null}
            violationsByTrip={violations.byTrip}
            openClusterKey={cluster?.rowId === UNASSIGNED_ROW_ID ? cluster.key : null}
            onSelectTrip={onSelectTrip}
            onOpenCluster={openCluster}
          />
        ) : null}
        {groups.map((group) => {
          const folded = collapsed?.has(group.id) === true && !group.rows.some((r) => r.id === selectedVehicleId);
          const bodyId = `depot-group-${group.id}`;
          return (
            <div key={group.id} role="rowgroup" data-depot-group={group.id} className="col-span-full grid grid-cols-subgrid">
              <div
                role="row"
                aria-label={`Dépôt ${group.label}, ${pluralize(group.fleet, "véhicule")}${folded ? ", replié" : ""}`}
                data-depot-header
                {...{ [ROVING_ROW]: "" }}
                className={cn(ROW, "sticky z-[25] border-b border-slate-200 bg-slate-100/95 text-xs text-slate-700")}
                style={{ top: AXIS_PX + pinnedPx }}
              >
                <div role="rowheader" className="col-span-full">
                  <div className="sticky left-0 flex w-fit max-w-full flex-wrap items-center gap-x-3 gap-y-0.5 px-2 py-1">
                    <button
                      type="button"
                      tabIndex={-1}
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
                      geometry={geometry}
                      color={colors?.get(row.id) ?? (row.route ? row.color : IDLE_VEHICLE_COLOR)}
                      selected={row.id === selectedVehicleId}
                      selectedTrip={relevantRows.has(row.id) ? selectedTrip : null}
                      violationsByTrip={violations.byTrip}
                      rowViolations={violations.byVehicle.get(row.id)}
                      openClusterKey={cluster?.rowId === row.id ? cluster.key : null}
                      onSelectTrip={onSelectTrip}
                      onSelectVehicle={onSelectVehicle}
                      onOpenCluster={openCluster}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {groups.length === 0 ? (
          <div role="row" className={ROW}>
            <div role="gridcell" className="col-span-full px-4 py-8 text-center text-sm text-slate-500">
              {emptyText}
            </div>
          </div>
        ) : null}
      </div>
      {cluster ? (
        <ClusterPopover
          anchor={cluster.anchor}
          title={`${cluster.tripIds.length} courses de ${formatMinute(cluster.from)} à ${formatMinute(cluster.to)}`}
          entries={clusterEntries}
          trips={trips}
          violatingTripIds={violatingTripIds}
          selectedTripId={selectedTripId}
          canZoom={nextZoom !== null && onZoomChange !== undefined}
          onSelect={onSelectTrip}
          onZoom={() => {
            if (!nextZoom || !onZoomChange) return;
            pendingCenter.current = (cluster.from + cluster.to) / 2;
            // Straight to the closest zoom: the trips of a « +3 » are minutes apart.
            onZoomChange("2h");
          }}
          onClose={closeCluster}
        />
      ) : null}
    </div>
  );
}

/** Key to the timeline symbols; the "return to check" mark only when the day has one. */
export function TimelineLegend({ showReturnToCheck = false }: { showReturnToCheck?: boolean }) {
  const item = "flex items-center gap-2";
  const block = "inline-flex h-3.5 w-8 shrink-0 items-center justify-center rounded-[3px] text-[9px] leading-none font-semibold";
  return (
    <ul className="grid gap-y-1.5 text-xs text-slate-600" aria-label="Légende de la frise">
      <li className={item}>
        <span aria-hidden className={cn(block, "bg-blue-600 text-white")}>
          MA
        </span>
        Course : de la prise en charge à la dépose (initiales du patient)
      </li>
      <li className={item}>
        <span aria-hidden className={cn(block, "text-white")} style={{ backgroundColor: "#2563eb", backgroundImage: SHARED_STRIPES }} />
        Course partagée (deux patients à bord)
      </li>
      <li className={item}>
        <span aria-hidden className={cn(block, "border-l-[3px] border-slate-900 bg-blue-600")} />
        Course figée sur son véhicule
      </li>
      <li className={item}>
        <span aria-hidden className="inline-flex h-4 w-8 shrink-0 items-center justify-center">
          <span className="inline-flex h-4 items-center rounded-full bg-white px-1 text-[10px] font-bold text-slate-800 ring-1 ring-slate-400">+3</span>
        </span>
        Courses rapprochées : la pastille ouvre leur liste
      </li>
      <li className={item}>
        <span aria-hidden className={cn(block, "border-[1.5px] border-dashed border-amber-700 bg-amber-100")} />
        À placer : créneau où la course sans véhicule doit être servie
      </li>
      <li className={item}>
        <span aria-hidden className="h-3.5 w-8 shrink-0 rounded-sm" style={FREE_SLOT_STYLE} />
        Créneau libre de 30 min ou plus
      </li>
      <li className={item}>
        <span aria-hidden className="relative inline-flex h-4 w-8 shrink-0 justify-center">
          <span className="h-4 border-l-2 border-slate-900" />
        </span>
        RDV de la course sélectionnée
      </li>
      <li className={item}>
        <span aria-hidden className="relative inline-flex h-4 w-8 shrink-0 items-center justify-center">
          <span className="h-4 border-l-2 border-dashed border-amber-600" />
          <TriangleAlert className="absolute right-0 size-3 text-amber-700" strokeWidth={2.5} />
        </span>
        Moins de 5 min de marge avant le RDV
      </li>
      <li className={item}>
        <span aria-hidden className="relative inline-flex h-4 w-8 shrink-0 items-center">
          <span className={cn(block, "w-6 bg-blue-600 outline-2 outline-offset-1 outline-slate-900 outline-dashed")} />
          <span className="absolute right-0 -top-0.5 grid size-3.5 place-items-center rounded-full bg-slate-900 text-amber-300">
            <TriangleAlert className="size-2.5" strokeWidth={3} />
          </span>
        </span>
        Violation (pointillé et pastille) ; sur la ligne : nombre de violations
      </li>
      <li className={item}>
        <span aria-hidden className="inline-flex h-4 w-8 shrink-0 items-center">
          <span className="h-0.5 w-8 rounded-full bg-slate-300" />
        </span>
        Tournée : départ et retour au dépôt
      </li>
      <li className={item}>
        <span aria-hidden className="h-3.5 w-8 shrink-0 rounded bg-amber-100 ring-1 ring-inset ring-amber-300" /> Pause
      </li>
      <li className={item}>
        <span aria-hidden className="h-3.5 w-8 shrink-0 rounded ring-1 ring-inset ring-slate-200" style={OFF_SHIFT_STYLE} /> Hors horaires
      </li>
      {showReturnToCheck ? (
        <li className={cn(item, "font-medium text-red-800")}>
          <span aria-hidden className="inline-flex w-8 shrink-0 justify-center">
            <ReturnToCheckMark />
          </span>
          Retour à vérifier (aller : patient absent)
        </li>
      ) : null}
      <li className="text-slate-500">
        Couleur : celle du véhicule, la même sur la carte. Le type (taxi, VSL, ambulance) est dans le nom ou la pastille du
        véhicule.
      </li>
    </ul>
  );
}
