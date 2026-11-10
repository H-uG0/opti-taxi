/**
 * Pure geometry of the planning timeline ("frise"): visible time range,
 * positions, and co-passengers derived from the stop sequence. What a row
 * draws (blocks, targets, free slots) is in timeline-layout.ts.
 */

export type TimeRange = { start: number; end: number };

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
 * Hour-aligned range covering every shift, route and stop given, and the
 * `windows` (where the « À placer » row draws the trips without a vehicle),
 * or the default 05:00–21:00 when there is nothing to show. At least 6 hours
 * wide.
 */
export function computeTimeRange(
  rows: Array<{ shift: TimeRange | null; route: RouteLike | null }>,
  fallback: TimeRange = DEFAULT_TIME_RANGE,
  windows: readonly TimeRange[] = [],
): TimeRange {
  const values: number[] = windows.flatMap((w) => [w.start, w.end]);
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
