/**
 * What the planning timeline (« frise ») draws on a row, at a given zoom:
 * - each trip as a block from its pick-up to its drop-off, the trips on board
 *   together in separate lanes;
 * - click targets at least 24 px wide: close trips share one target, which
 *   lists them (« +3 »);
 * - the free slots of a route (30 min or more), the window of a trip without a
 *   vehicle and the appointment of the selected trip.
 * Pure: minutes in, minutes out (the component turns them into percentages).
 */
import type { TimeRange } from "./timeline";

export type ZoomLevel = "day" | "4h" | "2h";

export const ZOOM_LEVELS: readonly ZoomLevel[] = ["day", "4h", "2h"];

/** Minutes shown in the visible part of the track; « day » shows the whole range. */
export const ZOOM_VISIBLE_MINUTES: Record<Exclude<ZoomLevel, "day">, number> = { "4h": 240, "2h": 120 };

export const ZOOM_LABELS: Record<ZoomLevel, string> = { day: "Journée", "4h": "4\u00a0h", "2h": "2\u00a0h" };

/** Smallest click target (WCAG 2.5.8): 24 CSS px. */
export const MIN_TARGET_PX = 24;

/** A gap of the route at least this long is shown as a free slot. */
export const FREE_SLOT_MIN = 30;

/** Under this margin before the appointment, the selected trip's appointment is flagged. */
export const TIGHT_MARGIN_MIN = 5;

/** How many times wider than the visible part the track is (1 for « day »). */
export function zoomFactor(range: TimeRange, zoom: ZoomLevel): number {
  if (zoom === "day") return 1;
  const span = range.end - range.start;
  return Math.max(1, span / ZOOM_VISIBLE_MINUTES[zoom]);
}

/** The next zoom in (« day » → « 4h » → « 2h »), null at the closest one. */
export function zoomIn(zoom: ZoomLevel): ZoomLevel | null {
  const index = ZOOM_LEVELS.indexOf(zoom);
  return ZOOM_LEVELS[index + 1] ?? null;
}

export type AxisTick = { minute: number; label: string };

/** « 7 h », « 7 h 30 ». */
export function tickLabel(minute: number): string {
  const hours = Math.floor(minute / 60) % 24;
  const minutes = minute % 60;
  return minutes === 0 ? `${hours}\u00a0h` : `${hours}\u00a0h ${String(minutes).padStart(2, "0")}`;
}

/** Room a label of the axis needs (« 10 h 30 » at 11 px, and a gap). */
const LABEL_MIN_PX = 44;
const LABEL_STEPS = [30, 60, 120, 180, 240] as const;

/**
 * Minutes between two labelled ticks of the axis, and between two grid lines
 * of the track: every half hour at 2 h, every hour at 4 h, every hour or 2 h
 * for the day; wider when the labels would touch (`pxPerMin`, once the track
 * is measured).
 */
export function axisSteps(range: TimeRange, zoom: ZoomLevel, pxPerMin?: number): { label: number; grid: number } {
  const base = zoom === "2h" ? 30 : zoom === "4h" ? 60 : range.end - range.start > 14 * 60 ? 120 : 60;
  const grid = zoom === "2h" ? 15 : zoom === "4h" ? 30 : 60;
  const fits = (step: number) => pxPerMin === undefined || step * pxPerMin >= LABEL_MIN_PX;
  const label: number = LABEL_STEPS.find((step) => step >= base && fits(step)) ?? 240;
  return { label, grid };
}

/** Labelled ticks inside the range. */
export function axisTicks(range: TimeRange, zoom: ZoomLevel, pxPerMin?: number): AxisTick[] {
  const step = axisSteps(range, zoom, pxPerMin).label;
  const ticks: AxisTick[] = [];
  for (let m = Math.ceil(range.start / step) * step; m <= range.end; m += step) ticks.push({ minute: m, label: tickLabel(m) });
  return ticks;
}

/** Minutes covered by `px` pixels on a track of `trackPx` pixels showing `range`. */
export function minutesForPx(px: number, trackPx: number, range: TimeRange): number {
  const span = range.end - range.start;
  if (trackPx <= 0 || span <= 0) return span;
  return (px * span) / trackPx;
}

type StopLike = { sequence: number; tripId: string; kind: "PICKUP" | "DROPOFF"; startMinute: number };

export type TripBlock = { tripId: string; from: number; to: number; lane: number };

/**
 * Lanes for intervals: each goes in the first lane free at its start (two
 * trips on board together never share a lane). Returns the lane of each
 * interval, in the input order, and the number of lanes.
 */
export function assignLanes(intervals: ReadonlyArray<{ from: number; to: number }>): { lanes: number[]; count: number } {
  const order = intervals
    .map((_, i) => i)
    .sort((a, b) => intervals[a]!.from - intervals[b]!.from || intervals[a]!.to - intervals[b]!.to);
  const ends: number[] = [];
  const lanes = new Array<number>(intervals.length).fill(0);
  for (const i of order) {
    const { from, to } = intervals[i]!;
    let lane = ends.findIndex((end) => end <= from);
    if (lane === -1) {
      lane = ends.length;
      ends.push(to);
    } else ends[lane] = to;
    lanes[i] = lane;
  }
  return { lanes, count: Math.max(1, ends.length) };
}

/**
 * One block per trip of a route, from the start of its pick-up to the start of
 * its drop-off (the patient on board), in lanes. A trip with a single stop on
 * the route gets a 5-minute block.
 */
export function routeBlocks(stops: readonly StopLike[]): { blocks: TripBlock[]; lanes: number } {
  const byTrip = new Map<string, { from: number | null; to: number | null; order: number }>();
  for (const stop of [...stops].sort((a, b) => a.sequence - b.sequence)) {
    const entry = byTrip.get(stop.tripId) ?? { from: null, to: null, order: byTrip.size };
    if (stop.kind === "PICKUP") entry.from = stop.startMinute;
    else entry.to = stop.startMinute;
    byTrip.set(stop.tripId, entry);
  }
  const intervals = [...byTrip.entries()].map(([tripId, e]) => {
    const from = e.from ?? (e.to ?? 0) - 5;
    const to = Math.max(e.to ?? from + 5, from);
    return { tripId, from, to };
  });
  const { lanes, count } = assignLanes(intervals);
  const blocks = intervals.map((b, i) => ({ ...b, lane: lanes[i] ?? 0 })).sort((a, b) => a.from - b.from || a.lane - b.lane);
  return { blocks, lanes: count };
}

export type TripTarget = {
  /** Trips reached by this target, in time order; more than one: a cluster (« +3 »). */
  tripIds: string[];
  from: number;
  to: number;
  /** Lane band of the target; null: the whole height of the track. */
  lane: number | null;
};

/** A group of close targets reaches this many target widths from its start at most (see clickTargets). */
const MAX_GROUP_WIDTHS = 2;

/**
 * Click targets of blocks: each block's target is centred on it and at least
 * `minMinutes` wide (the minutes of 24 px at the current zoom), kept inside
 * the range; targets that would overlap become one target listing their
 * trips. A chain of trips minutes apart does not make one group for hours: a
 * target starting 2 widths or more after its group's start begins the next
 * group, the two touching (unless a trip of the group runs on under it).
 * With `perLane`, each lane keeps its own targets (a band of the track each);
 * otherwise they are merged across lanes.
 */
export function clickTargets(
  blocks: readonly TripBlock[],
  minMinutes: number,
  range: TimeRange,
  perLane: boolean,
): TripTarget[] {
  const span = range.end - range.start;
  const hits = blocks.map((b) => {
    const width = Math.min(Math.max(b.to - b.from, minMinutes), span);
    let from = (b.from + b.to) / 2 - width / 2;
    if (from < range.start) from = range.start;
    if (from + width > range.end) from = range.end - width;
    return { block: b, from, to: from + width, lane: perLane ? b.lane : 0 };
  });
  type Hit = (typeof hits)[number];
  /** `blocksTo`: where the group's last trip ends (its block, not its target). */
  const groups: Array<{ hits: Hit[]; from: number; to: number; lane: number; blocksTo: number }> = [];
  const lanes = [...new Set(hits.map((h) => h.lane))].sort((a, b) => a - b);
  for (const lane of lanes) {
    const inLane = hits.filter((h) => h.lane === lane).sort((a, b) => a.from - b.from || a.block.from - b.block.from);
    for (const hit of inLane) {
      const current = groups.at(-1);
      if (current && current.lane === lane && hit.from < current.to) {
        const longEnough = hit.from - current.from >= MAX_GROUP_WIDTHS * minMinutes;
        // Cut only where the group's trips end (half a target at most under the next one), never a long trip.
        if (!longEnough || current.blocksTo - hit.from >= minMinutes / 2) {
          current.hits.push(hit);
          current.to = Math.max(current.to, hit.to);
          current.blocksTo = Math.max(current.blocksTo, hit.block.to);
          continue;
        }
        current.to = hit.from;
      }
      groups.push({ hits: [hit], from: hit.from, to: hit.to, lane, blocksTo: hit.block.to });
    }
  }
  return groups
    .map((g) => ({
      // A cluster's trips in time order (the list it opens).
      tripIds: [...g.hits].sort((a, b) => a.block.from - b.block.from || a.block.lane - b.block.lane).map((h) => h.block.tripId),
      from: g.from,
      to: g.to,
      lane: perLane ? g.lane : null,
    }))
    .sort((a, b) => a.from - b.from || (a.lane ?? 0) - (b.lane ?? 0));
}

type RouteLike = {
  startMinute: number;
  endMinute: number;
  breakStartMinute: number | null;
  breakEndMinute: number | null;
  stops: ReadonlyArray<StopLike & { arrivalMinute: number; departureMinute: number; loadAfter: number }>;
};

/** `slots` minus `cut` (each slot may split in two). */
function subtract(slots: TimeRange[], cut: TimeRange): TimeRange[] {
  const result: TimeRange[] = [];
  for (const slot of slots) {
    if (cut.end <= slot.start || cut.start >= slot.end) {
      result.push(slot);
      continue;
    }
    if (cut.start > slot.start) result.push({ start: slot.start, end: cut.start });
    if (cut.end < slot.end) result.push({ start: cut.end, end: slot.end });
  }
  return result;
}

/**
 * Free slots of a vehicle with a route: before the route and after it within
 * the shift (at the depot), and the waits with nobody on board (arrived early
 * for the next pick-up), minus the break; only those of `minMinutes` or more.
 * A vehicle without a route is free all day: the row says so, no slot drawn.
 */
export function freeSlots(shift: TimeRange | null, route: RouteLike | null, minMinutes = FREE_SLOT_MIN): TimeRange[] {
  if (!route) return [];
  let slots: TimeRange[] = [];
  if (shift && route.startMinute > shift.start) slots.push({ start: shift.start, end: route.startMinute });
  let cursor = route.startMinute;
  let load = 0;
  for (const stop of [...route.stops].sort((a, b) => a.sequence - b.sequence)) {
    const waitFrom = Math.max(cursor, stop.arrivalMinute);
    if (load === 0 && stop.startMinute > waitFrom) slots.push({ start: waitFrom, end: stop.startMinute });
    load = stop.loadAfter;
    cursor = Math.max(cursor, stop.departureMinute);
  }
  if (shift && shift.end > route.endMinute) slots.push({ start: route.endMinute, end: shift.end });
  if (route.breakStartMinute !== null && route.breakEndMinute !== null) {
    slots = subtract(slots, { start: route.breakStartMinute, end: route.breakEndMinute });
  }
  return slots.filter((s) => s.end - s.start >= minMinutes).sort((a, b) => a.start - b.start);
}

type TripTimes = {
  direction: "OUTBOUND" | "RETURN";
  appointmentMinute: number | null;
  readyMinute: number | null;
  plannedPickupMinute: number | null;
  plannedDropoffMinute: number | null;
};

export type WaitWindows = { beforeAppointmentMin: number; afterSessionMin: number };

/**
 * Where a trip without a vehicle must be served: an outbound trip's drop-off
 * window before the appointment, a return trip's pick-up window after the end
 * of the session (the optimizer's windows, from Paramètres). At least 10 min
 * wide; null without the time.
 */
export function unassignedWindow(trip: TripTimes, waits: WaitWindows): (TimeRange & { anchor: number }) | null {
  if (trip.direction === "OUTBOUND") {
    if (trip.appointmentMinute === null) return null;
    const before = Math.max(10, waits.beforeAppointmentMin);
    return { start: trip.appointmentMinute - before, end: trip.appointmentMinute, anchor: trip.appointmentMinute };
  }
  if (trip.readyMinute === null) return null;
  const after = Math.max(10, waits.afterSessionMin);
  return { start: trip.readyMinute, end: trip.readyMinute + after, anchor: trip.readyMinute };
}

export type AppointmentMark = {
  /** Appointment (outbound) or end of the session (return). */
  kind: "appointment" | "ready";
  minute: number;
  /** Outbound: appointment - planned drop-off; return: planned pick-up - end of session; null when not planned. */
  marginMin: number | null;
  /** Outbound trip dropped off less than 5 minutes before its appointment (or after it). */
  tight: boolean;
};

/** The selected trip's appointment (outbound) or end of session (return), with its margin. */
export function appointmentMark(trip: TripTimes): AppointmentMark | null {
  if (trip.direction === "OUTBOUND") {
    if (trip.appointmentMinute === null) return null;
    const margin = trip.plannedDropoffMinute === null ? null : trip.appointmentMinute - trip.plannedDropoffMinute;
    const tight = margin !== null && margin < TIGHT_MARGIN_MIN;
    return { kind: "appointment", minute: trip.appointmentMinute, marginMin: margin, tight };
  }
  if (trip.readyMinute === null) return null;
  const margin = trip.plannedPickupMinute === null ? null : trip.plannedPickupMinute - trip.readyMinute;
  return { kind: "ready", minute: trip.readyMinute, marginMin: margin, tight: false };
}

/** « MA » for « Monique Aubert », « ÉF » for « Élodie Fabre »: first letters of the first and last words. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  if (!first) return "";
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  const letter = (word: string) => Array.from(word)[0]?.toLocaleUpperCase("fr-FR") ?? "";
  return letter(first) + (last ? letter(last) : "");
}
