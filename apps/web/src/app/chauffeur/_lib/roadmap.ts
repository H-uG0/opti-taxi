/**
 * Pure helpers of the driver roadmap (/chauffeur): state of each stop, the next
 * stop to do, shared rides, and the timeline with depot and break markers.
 * No server-only import: used by the server page and the unit tests.
 */
import type { StopKind, TripDirection, TripStatus } from "@prisma/client";
import { addDays, isIsoDate, minuteOfDay } from "@/lib/time";

/**
 * The days a driver can open: today (statuses are recorded) and tomorrow
 * (preview). Older and later roadmaps serve no field purpose and would only
 * expose patient data (names, phones, home addresses, door codes) on a phone
 * that can be lost or borrowed: data minimisation (RGPD, HDS).
 */
export function roadmapDateWindow(today: string): { first: string; last: string } {
  return { first: today, last: addDays(today, 1) };
}

export function isReadableRoadmapDate(date: string | null | undefined, today: string): date is string {
  if (!isIsoDate(date)) return false;
  const { first, last } = roadmapDateWindow(today);
  return date >= first && date <= last;
}

// Pairing of the outbound and return legs (patient absent on the outbound
// leg): shared with the regulator screens, see @/lib/domain/no-show.
export { isSameEpisode, returnTripsAfterOutboundNoShow, type LegKey } from "@/lib/domain/no-show";

/** What the driver sees on a stop. */
export type StopState =
  /** Still to do. */
  | "pending"
  /** Pickup or dropoff recorded by the crew (completedAt set). */
  | "done"
  /** Pickup of a patient declared absent. */
  | "no_show"
  /** Dropoff of an absent patient: nothing to do there. */
  | "skipped"
  /** Trip cancelled by the regulator after the route was planned. */
  | "cancelled";

/** The fields of a stop the roadmap rules look at. */
export type StopLike = {
  id: string;
  sequence: number;
  kind: StopKind;
  tripId: string;
  completedAt: Date | null;
  tripStatus: TripStatus;
};

/** Trips whose patient is not in the vehicle (no ride, no co-passenger). */
const NOT_RIDING: readonly TripStatus[] = ["NO_SHOW", "CANCELLED"];

export function stopState(stop: Pick<StopLike, "kind" | "completedAt" | "tripStatus">): StopState {
  if (stop.tripStatus === "CANCELLED") return "cancelled";
  if (stop.tripStatus === "NO_SHOW") return stop.kind === "PICKUP" ? "no_show" : "skipped";
  return stop.completedAt ? "done" : "pending";
}

/** True once nothing is left to do on the stop (done, absent, skipped or cancelled). */
export function isStopClosed(stop: Pick<StopLike, "kind" | "completedAt" | "tripStatus">): boolean {
  return stopState(stop) !== "pending";
}

function bySequence<T extends { sequence: number }>(stops: readonly T[]): T[] {
  return [...stops].sort((a, b) => a.sequence - b.sequence);
}

/**
 * The stop to do next: the first stop still pending in route order. A stop
 * forgotten earlier in the route stays "next" until it is recorded, which
 * reminds the driver of it. Null when the route is finished.
 */
export function nextStopId(stops: readonly StopLike[]): string | null {
  return bySequence(stops).find((stop) => stopState(stop) === "pending")?.id ?? null;
}

/**
 * The stop holding the most recent status recorded on the route (latest
 * completedAt, ties broken by route order): the only one whose status the
 * crew can undo. Stops of cancelled trips are left out (their status belongs
 * to the regulator now).
 */
export function latestCompletedStopId(stops: readonly StopLike[]): string | null {
  let latest: (StopLike & { completedAt: Date }) | null = null;
  for (const stop of stops) {
    if (!stop.completedAt || stop.tripStatus === "CANCELLED") continue;
    const time = stop.completedAt.getTime();
    const latestTime = latest?.completedAt.getTime() ?? Number.NEGATIVE_INFINITY;
    if (!latest || time > latestTime || (time === latestTime && stop.sequence > latest.sequence)) {
      latest = { ...stop, completedAt: stop.completedAt };
    }
  }
  return latest?.id ?? null;
}

/**
 * Other trips on board at the same time as each trip (shared transport),
 * derived from the order of the route's stops: A and B share the vehicle when
 * A is picked up before B is dropped off and B is picked up before A is
 * dropped off. A trip without a pickup on the route is on board from the start,
 * one without a dropoff until the end. Absent and cancelled patients do not ride.
 * Co-passengers are listed in pickup order.
 */
export function coPassengers(stops: readonly StopLike[]): Map<string, string[]> {
  const intervals = new Map<string, { from: number; to: number }>();
  for (const stop of bySequence(stops)) {
    if (NOT_RIDING.includes(stop.tripStatus)) continue;
    const interval = intervals.get(stop.tripId) ?? { from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY };
    if (stop.kind === "PICKUP") interval.from = stop.sequence;
    else interval.to = stop.sequence;
    intervals.set(stop.tripId, interval);
  }

  const ordered = [...intervals.entries()].sort((a, b) => a[1].from - b[1].from);
  const result = new Map<string, string[]>();
  for (const [tripId, interval] of ordered) {
    const others = ordered
      .filter(([otherId, other]) => otherId !== tripId && interval.from < other.to && other.from < interval.to)
      .map(([otherId]) => otherId);
    result.set(tripId, others);
  }
  return result;
}

/** The facility end of a trip: dropoff of an outbound leg, pickup of a return leg. */
export function isFacilityStop(kind: StopKind, direction: TripDirection): boolean {
  return (direction === "OUTBOUND" && kind === "DROPOFF") || (direction === "RETURN" && kind === "PICKUP");
}

/** The time the facility expects: appointment on an outbound dropoff, end of session on a return pickup. */
export function stopKeyTime(stop: {
  kind: StopKind;
  direction: TripDirection;
  appointmentMinute: number | null;
  readyMinute: number | null;
}): { label: "RDV" | "Fin de séance"; minute: number } | null {
  if (stop.direction === "OUTBOUND" && stop.kind === "DROPOFF" && stop.appointmentMinute !== null) {
    return { label: "RDV", minute: stop.appointmentMinute };
  }
  if (stop.direction === "RETURN" && stop.kind === "PICKUP" && stop.readyMinute !== null) {
    return { label: "Fin de séance", minute: stop.readyMinute };
  }
  return null;
}

/** Real time (Europe/Paris) minus planned time, in minutes; positive when late. */
export function minutesLate(plannedMinute: number, completedAt: Date): number {
  return minuteOfDay(completedAt) - plannedMinute;
}

/** "Jeanne MARTIN": first name, then the family name in capitals as on medical paperwork (patients and crew). */
export function displayName(person: { firstName: string; lastName: string }): string {
  return `${person.firstName} ${person.lastName.toLocaleUpperCase("fr-FR")}`.trim();
}

/** Stops closed / total, for the route header. */
export function routeProgress(stops: readonly StopLike[]): { closed: number; total: number } {
  return { closed: stops.filter(isStopClosed).length, total: stops.length };
}

export type TimelineItem<S> =
  | { type: "depart"; minute: number }
  | { type: "stop"; stop: S }
  | { type: "break"; startMinute: number; endMinute: number }
  | { type: "return"; minute: number };

/**
 * The route as the driver reads it: departure from the depot, stops in order,
 * the planned break placed before the first stop served after it starts, and
 * the return to the depot.
 */
export function buildTimeline<S extends { sequence: number; startMinute: number }>(
  stops: readonly S[],
  route: { startMinute: number; endMinute: number; breakStartMinute: number | null; breakEndMinute: number | null },
): TimelineItem<S>[] {
  const items: TimelineItem<S>[] = [{ type: "depart", minute: route.startMinute }];
  const hasBreak = route.breakStartMinute !== null && route.breakEndMinute !== null;
  let breakPlaced = !hasBreak;
  const breakItem = (): TimelineItem<S> => ({
    type: "break",
    startMinute: route.breakStartMinute ?? 0,
    endMinute: route.breakEndMinute ?? 0,
  });

  for (const stop of bySequence(stops)) {
    if (!breakPlaced && stop.startMinute >= (route.breakStartMinute ?? 0)) {
      items.push(breakItem());
      breakPlaced = true;
    }
    items.push({ type: "stop", stop });
  }
  if (!breakPlaced) items.push(breakItem());
  items.push({ type: "return", minute: route.endMinute });
  return items;
}
