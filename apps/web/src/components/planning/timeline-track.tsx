"use client";

import { useMemo, type CSSProperties } from "react";
import { TriangleAlert } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { OUTBOUND_NO_SHOW_LABEL } from "@/lib/domain/no-show";
import { readableTextColor } from "@/lib/planning/colors";
import { percentOf, type TimeRange } from "@/lib/planning/timeline";
import { clickTargets, initials, type AppointmentMark, type TripBlock, type TripTarget } from "@/lib/planning/timeline-layout";
import type { TripView, ViolationView } from "@/lib/planning/types";
import { violationLabels } from "@/lib/planning/violation-index";
import { DIRECTION_LABELS } from "@/lib/labels";
import { formatDuration, formatMinute } from "@/lib/time";
import { ROVING_PREFERRED } from "./use-roving-grid";

/** Height of the track (px) in each density. */
export const TRACK_HEIGHT = { detailed: 48, compact: 24 } as const;

/** Stripes of a shared trip (two patients on board), over the vehicle's color. */
export const SHARED_STRIPES = "repeating-linear-gradient(135deg, rgb(255 255 255 / 0.32) 0 3px, transparent 3px 7px)";

/** Blocks narrower than this (px) show no initials. */
const INITIALS_MIN_PX = 20;

export function span(from: number, to: number, range: TimeRange): CSSProperties {
  const left = percentOf(from, range);
  return { left: `${left}%`, width: `${Math.max(0, percentOf(to, range) - left)}%` };
}

/** Vertical place of a block in its lane. */
function laneBox(lane: number, lanes: number, compact: boolean): { top: number; height: number } {
  const height = compact ? TRACK_HEIGHT.compact : TRACK_HEIGHT.detailed;
  if (lanes <= 1) return compact ? { top: 5, height: 14 } : { top: 13, height: 22 };
  const pad = compact ? 1 : 3;
  const gap = compact ? 1 : 2;
  const band = (height - 2 * pad - (lanes - 1) * gap) / lanes;
  return { top: pad + lane * (band + gap), height: band };
}

/** Targets keep their lane (two bands of 24 px) only in the detailed density with two lanes at most. */
export function targetsPerLane(lanes: number, compact: boolean): boolean {
  return !compact && lanes <= 2;
}

function targetBox(target: TripTarget, lanes: number, compact: boolean): { top: number; height: number } {
  const height = compact ? TRACK_HEIGHT.compact : TRACK_HEIGHT.detailed;
  if (target.lane === null || lanes <= 1) return { top: 0, height };
  const band = height / lanes;
  return { top: target.lane * band, height: band };
}

/** What a trip's target says (aria-label, and tooltip with line breaks). */
export function tripTitle(
  trip: TripView | undefined,
  block: { from: number; to: number },
  trips: Readonly<Record<string, TripView>>,
  violations: readonly ViolationView[],
  unassigned: boolean,
): string {
  if (!trip) return "Course inconnue";
  const lines = [
    unassigned
      ? `À placer · ${trip.patientName}`
      : `${formatMinute(block.from)} – ${formatMinute(block.to)} · ${trip.patientName}`,
    trip.direction === "OUTBOUND"
      ? `${DIRECTION_LABELS.OUTBOUND} · RDV ${formatMinute(trip.appointmentMinute)}`
      : `${DIRECTION_LABELS.RETURN} · fin de séance ${formatMinute(trip.readyMinute)}`,
  ];
  if (unassigned) {
    lines.push(
      trip.direction === "OUTBOUND"
        ? `Arrivée attendue de ${formatMinute(block.from)} à ${formatMinute(block.to)}`
        : `Prise en charge attendue de ${formatMinute(block.from)} à ${formatMinute(block.to)}`,
    );
  } else {
    lines.push(`${trip.pickupAddress} → ${trip.dropoffAddress}`);
  }
  if (trip.coPassengerTripIds.length > 0) {
    lines.push(`Partagée avec ${trip.coPassengerTripIds.map((id) => trips[id]?.patientName ?? "?").join(", ")}`);
  }
  if (trip.lockedVehicleId) lines.push("Course figée sur ce véhicule");
  if (trip.status === "CANCELLED") lines.push("Course annulée");
  if (trip.status === "NO_SHOW") lines.push("Patient absent");
  if (trip.outboundNoShow) lines.push(OUTBOUND_NO_SHOW_LABEL);
  if (violations.length > 0) lines.push(`Violation : ${violationLabels(violations)}`);
  return lines.join("\n");
}

/** « 3 courses de 07:10 à 08:20 : A, B, C, dont 1 avec violation ». */
function clusterTitle(
  target: TripTarget,
  blocks: ReadonlyMap<string, TripBlock>,
  trips: Readonly<Record<string, TripView>>,
  violatingTripIds: ReadonlySet<string>,
  selectedTripId: string | null,
): string {
  const from = Math.min(...target.tripIds.map((id) => blocks.get(id)?.from ?? Infinity));
  const to = Math.max(...target.tripIds.map((id) => blocks.get(id)?.to ?? -Infinity));
  const names = target.tripIds.map((id) => trips[id]?.patientName ?? "?").join(", ");
  const violating = target.tripIds.filter((id) => violatingTripIds.has(id)).length;
  const parts = [`${target.tripIds.length} courses de ${formatMinute(from)} à ${formatMinute(to)} : ${names}`];
  if (violating > 0) parts.push(`dont ${violating} avec violation`);
  if (selectedTripId && target.tripIds.includes(selectedTripId)) parts.push("dont la course sélectionnée");
  return `${parts.join(", ")}. Ouvrir la liste`;
}

export type OpenCluster = (args: { key: string; tripIds: string[]; anchor: HTMLElement; from: number; to: number }) => void;

type TrackProps = {
  /** Row id (vehicle, or « unassigned »): prefix of the targets' keys. */
  rowId: string;
  blocks: readonly TripBlock[];
  lanes: number;
  /** One target band for every lane (more trips at the same time than lanes). */
  mergeTargets?: boolean;
  trips: Readonly<Record<string, TripView>>;
  range: TimeRange;
  pxPerMin: number;
  minMinutes: number;
  compact: boolean;
  /** Vehicle color; null for the trips without a vehicle (dashed amber). */
  color: string | null;
  selectedTripId: string | null;
  companionIds: ReadonlySet<string>;
  violationsByTrip: ReadonlyMap<string, ViolationView[]>;
  /** Appointment of the selected trip, when it is on this row. */
  mark: AppointmentMark | null;
  /** Key of the « +3 » whose list is open. */
  openClusterKey: string | null;
  onSelectTrip: (tripId: string) => void;
  onOpenCluster: OpenCluster;
};

/**
 * Trips of a timeline row: the blocks (drawn, hidden from screen readers),
 * then the click targets over them (one per trip, or one per group of close
 * trips), then the selected trip's appointment.
 */
export function TrackTrips({
  rowId,
  blocks,
  lanes,
  mergeTargets = false,
  trips,
  range,
  pxPerMin,
  minMinutes,
  compact,
  color,
  selectedTripId,
  companionIds,
  violationsByTrip,
  mark,
  openClusterKey,
  onSelectTrip,
  onOpenCluster,
}: TrackProps) {
  const unassigned = color === null;
  const perLane = !mergeTargets && targetsPerLane(lanes, compact);
  const targets = useMemo(() => clickTargets(blocks, minMinutes, range, perLane), [blocks, minMinutes, range, perLane]);
  const blockById = useMemo(() => new Map(blocks.map((b) => [b.tripId, b])), [blocks]);
  const violating = useMemo(
    () => new Set(blocks.filter((b) => violationsByTrip.has(b.tripId)).map((b) => b.tripId)),
    [blocks, violationsByTrip],
  );
  const textColor = color ? readableTextColor(color) : "#78350f";

  return (
    <>
      {blocks.map((block) => {
        const trip = trips[block.tripId];
        const box = laneBox(block.lane, lanes, compact);
        const widthPx = (block.to - block.from) * pxPerMin;
        const cancelled = trip?.status === "CANCELLED" || trip?.status === "NO_SHOW";
        const done = trip?.status === "DROPPED_OFF";
        const isSelected = block.tripId === selectedTripId;
        const isCompanion = companionIds.has(block.tripId);
        const style: CSSProperties = { ...span(block.from, block.to, range), top: box.top, height: box.height, minWidth: 3 };
        if (!unassigned && !cancelled) {
          style.backgroundColor = color ?? undefined;
          // Shared: light stripes over the vehicle's color, the initials stay readable.
          if (trip && trip.coPassengerTripIds.length > 0) style.backgroundImage = SHARED_STRIPES;
          style.color = textColor;
        }
        return (
          <span
            key={block.tripId}
            aria-hidden
            data-trip-block={block.tripId}
            className={cn(
              "absolute z-10 flex items-center justify-center overflow-hidden rounded-[3px] text-[10px] leading-none font-semibold whitespace-nowrap",
              !unassigned && !cancelled && textColor === "#ffffff" && "[text-shadow:0_0_2px_rgb(15_23_42/0.7)]",
              unassigned && "border-[1.5px] border-dashed border-amber-700 bg-amber-100 text-amber-950",
              cancelled && "bg-slate-300 text-slate-600 line-through",
              trip?.lockedVehicleId && !unassigned && "border-l-[3px] border-slate-900",
              done && "opacity-60",
              violating.has(block.tripId) && "outline-2 outline-offset-1 outline-slate-900 outline-dashed",
              isSelected && "z-[15] ring-2 ring-slate-900 ring-offset-1",
              !isSelected && isCompanion && "z-[15] ring-2 ring-shared ring-offset-1",
            )}
            style={style}
          >
            {widthPx >= INITIALS_MIN_PX && trip ? initials(trip.patientName) : null}
          </span>
        );
      })}

      {/* Shapes, not only colors: a violation gets a dark « ! » badge, a return to check a red « ! ». */}
      {blocks.map((block) => {
        const trip = trips[block.tripId];
        const hasViolation = violating.has(block.tripId);
        if (!hasViolation && !trip?.outboundNoShow) return null;
        const box = laneBox(block.lane, lanes, compact);
        return (
          <span
            key={`${block.tripId}-mark`}
            aria-hidden
            className="pointer-events-none absolute z-[16] flex gap-px"
            style={{ left: `${percentOf(block.to, range)}%`, top: Math.max(0, box.top - 5) }}
          >
            {hasViolation ? (
              <span className="-ml-2 grid size-3.5 place-items-center rounded-full bg-slate-900 text-amber-300 ring-1 ring-white">
                <TriangleAlert className="size-2.5" strokeWidth={3} />
              </span>
            ) : null}
            {trip?.outboundNoShow ? <ReturnToCheckMark className={hasViolation ? "" : "-ml-2"} /> : null}
          </span>
        );
      })}

      {targets.map((target) => {
        const key = `${rowId}:${target.tripIds.join(",")}`;
        const box = targetBox(target, lanes, compact);
        const single = target.tripIds.length === 1;
        const containsSelected = selectedTripId !== null && target.tripIds.includes(selectedTripId);
        const first = blockById.get(target.tripIds[0] ?? "");
        const firstId = target.tripIds[0] ?? "";
        const title = single
          ? tripTitle(trips[firstId], first ?? target, trips, violationsByTrip.get(firstId) ?? [], unassigned)
          : clusterTitle(target, blockById, trips, violating, selectedTripId);
        const clusterViolations = single ? 0 : target.tripIds.filter((id) => violating.has(id)).length;
        return (
          <button
            key={key}
            type="button"
            tabIndex={-1}
            data-trip-ids={target.tripIds.join(" ")}
            {...(containsSelected ? { [ROVING_PREFERRED]: "" } : {})}
            title={title}
            aria-label={title.replaceAll("\n", ", ")}
            aria-pressed={single ? containsSelected : undefined}
            aria-haspopup={single ? undefined : "dialog"}
            aria-expanded={single ? undefined : openClusterKey === key}
            onClick={(e) => {
              if (single) onSelectTrip(target.tripIds[0] ?? "");
              else {
                const blocksOf = target.tripIds.map((id) => blockById.get(id)).filter((b): b is TripBlock => b !== undefined);
                onOpenCluster({
                  key,
                  tripIds: target.tripIds,
                  anchor: e.currentTarget,
                  from: Math.min(...blocksOf.map((b) => b.from)),
                  to: Math.max(...blocksOf.map((b) => b.to)),
                });
              }
            }}
            className={cn(
              "group/target absolute z-20 rounded focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-brand-600",
              "hover:bg-slate-900/[0.07] hover:ring-1 hover:ring-slate-400",
              !single && containsSelected && "ring-2 ring-slate-900",
            )}
            style={{ ...span(target.from, target.to, range), top: box.top, height: box.height }}
          >
            {single ? null : (
              <span
                aria-hidden
                className={cn(
                  "absolute top-1/2 left-1/2 inline-flex h-4 -translate-x-1/2 -translate-y-1/2 items-center gap-0.5 rounded-full px-1 text-[10px] leading-none font-bold shadow-xs ring-1",
                  clusterViolations > 0 ? "bg-slate-900 text-amber-300 ring-white" : "bg-white text-slate-800 ring-slate-400",
                )}
              >
                {clusterViolations > 0 ? <TriangleAlert className="size-2.5" strokeWidth={3} /> : null}+{target.tripIds.length}
              </span>
            )}
          </button>
        );
      })}

      {mark ? <AppointmentLine mark={mark} range={range} compact={compact} /> : null}
    </>
  );
}

/** « marge 3 min », « 5 min de retard » (dropped off after the appointment), as the trip's panel says it. */
function marginText(marginMin: number): string {
  return marginMin < 0 ? `${formatDuration(-marginMin)} de retard` : `marge ${formatDuration(marginMin)}`;
}

/**
 * The selected trip's appointment (or end of session) across the row, flagged
 * under 5 min of margin. Above the trips of its track, which isolates it: it
 * scrolls under the pinned axis, rows and vehicle column like the blocks.
 */
function AppointmentLine({ mark, range, compact }: { mark: AppointmentMark; range: TimeRange; compact: boolean }) {
  const left = percentOf(mark.minute, range);
  const margin = mark.tight && mark.marginMin !== null ? ` · ${marginText(mark.marginMin)}` : "";
  const label =
    mark.kind === "appointment" ? `RDV ${formatMinute(mark.minute)}${margin}` : `Fin de séance ${formatMinute(mark.minute)}`;
  return (
    <span
      aria-hidden
      data-appointment-mark
      className={cn(
        "pointer-events-none absolute inset-y-0 z-[21] w-0 border-l-2",
        mark.tight ? "border-dashed border-amber-600" : "border-slate-900",
      )}
      style={{ left: `${left}%` }}
    >
      <span
        className={cn(
          "absolute top-0 inline-flex items-center gap-0.5 rounded-sm px-0.5 text-[10px] leading-tight font-semibold whitespace-nowrap ring-1",
          mark.tight ? "bg-amber-100 text-amber-950 ring-amber-500" : "bg-white text-slate-900 ring-slate-300",
          compact && "top-auto bottom-0",
          left > 70 ? "right-0.5" : "left-0.5",
        )}
      >
        {mark.tight ? <TriangleAlert className="size-2.5" strokeWidth={3} /> : null}
        {label}
      </span>
    </span>
  );
}

/** "!" on a return trip whose outbound leg was closed as patient absent. */
export function ReturnToCheckMark({ className }: { className?: string }) {
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
