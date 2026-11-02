/**
 * Pure geometry of the planning timeline ("frise"): visible time range,
 * segments of a route colored by the number of patients on board, and
 * co-passengers derived from the stop sequence.
 */

export type TimeRange = { start: number; end: number };

export type SegmentKind = "drive" | "wait" | "service";
export type TimelineSegment = { from: number; to: number; load: number; kind: SegmentKind };

type StopLike = {
  sequence: number;
  tripId: string;
  kind: "PICKUP" | "DROPOFF";
  arrivalMinute: number;
  startMinute: number;
  departureMinute: number;
  loadAfter: number;
};

type RouteLike = { startMinute: number; endMinute: number; stops: StopLike[] };

export const DEFAULT_TIME_RANGE: TimeRange = { start: 5 * 60, end: 21 * 60 };
const MIN_SPAN = 6 * 60;
const MAX_MINUTE = 2 * 24 * 60;

/**
 * Hour-aligned range covering every shift, route and stop given, or the
 * default 05:00–21:00 when there is nothing to show. At least 6 hours wide.
 */
export function computeTimeRange(
  rows: Array<{ shift: TimeRange | null; route: RouteLike | null }>,
  fallback: TimeRange = DEFAULT_TIME_RANGE,
): TimeRange {
  const values: number[] = [];
  for (const row of rows) {
    if (row.shift) values.push(row.shift.start, row.shift.end);
    if (row.route) {
      values.push(row.route.startMinute, row.route.endMinute);
      for (const stop of row.route.stops) values.push(stop.arrivalMinute, stop.departureMinute);
    }
  }
  if (values.length === 0) return fallback;
  let start = Math.floor(Math.min(...values) / 60) * 60;
  let end = Math.ceil(Math.max(...values) / 60) * 60;
  if (end - start < MIN_SPAN) end = start + MIN_SPAN;
  start = Math.max(0, start);
  end = Math.min(MAX_MINUTE, end);
  return { start, end };
}

/** Position of a minute in the range, as a percentage clamped to [0, 100]. */
export function percentOf(minute: number, range: TimeRange): number {
  const span = range.end - range.start;
  if (span <= 0) return 0;
  return Math.min(100, Math.max(0, ((minute - range.start) / span) * 100));
}

/** Hour marks inside the range (every hour, or every 2 h for long days). */
export function hourTicks(range: TimeRange): number[] {
  const step = range.end - range.start > 14 * 60 ? 120 : 60;
  const ticks: number[] = [];
  for (let m = Math.ceil(range.start / step) * step; m <= range.end; m += step) ticks.push(m);
  return ticks;
}

/**
 * Successive pieces of a route: driving between stops (with the load on
 * board), waiting for a time window, and service at a stop.
 */
export function routeSegments(route: RouteLike): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  const stops = [...route.stops].sort((a, b) => a.sequence - b.sequence);
  let cursor = route.startMinute;
  let load = 0;
  for (const stop of stops) {
    if (stop.arrivalMinute > cursor) segments.push({ from: cursor, to: stop.arrivalMinute, load, kind: "drive" });
    const serviceFrom = Math.max(cursor, stop.startMinute);
    if (stop.startMinute > stop.arrivalMinute) {
      segments.push({ from: Math.max(cursor, stop.arrivalMinute), to: stop.startMinute, load, kind: "wait" });
    }
    if (stop.departureMinute > serviceFrom) {
      segments.push({ from: serviceFrom, to: stop.departureMinute, load: Math.max(load, stop.loadAfter), kind: "service" });
    }
    load = stop.loadAfter;
    cursor = Math.max(cursor, stop.departureMinute);
  }
  if (route.endMinute > cursor) segments.push({ from: cursor, to: route.endMinute, load, kind: "drive" });
  return segments;
}

/** Trips on board at the same time as each trip of the route. */
export function coPassengers(stops: StopLike[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const onBoard = new Set<string>();
  const link = (a: string, b: string) => {
    if (!result.has(a)) result.set(a, new Set());
    result.get(a)?.add(b);
  };
  for (const stop of [...stops].sort((a, b) => a.sequence - b.sequence)) {
    if (stop.kind === "PICKUP") {
      for (const other of onBoard) {
        link(stop.tripId, other);
        link(other, stop.tripId);
      }
      onBoard.add(stop.tripId);
    } else {
      onBoard.delete(stop.tripId);
    }
  }
  return result;
}
