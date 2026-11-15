/**
 * The time a status is recorded at: the moment the crew tapped it on the
 * phone (observedAt), not the moment the server received it. A status typed
 * in a valley with no signal at 08:02 and sent at 08:25 is recorded at 08:02,
 * so lateness, waiting times and the traffic calibration stay right.
 *
 * The phone's time is not trusted as is:
 * - its clock offset is cancelled: the phone also sends the time it sent the
 *   request (sentAt, its own clock), and observedAt is shifted by
 *   receivedAt − sentAt (the offset plus a few seconds of network delay);
 * - never in the future: a later time is brought back to the reception;
 * - at most MAX_STATUS_AGE_MS old: an older one is refused (the crew calls the
 *   regulation with the real time), so a status cannot be back-dated by hours;
 * - never before the statuses it follows (previousStatusAt): a dropoff is not
 *   recorded before its trip's pickup, nor any status before one already
 *   recorded on an earlier stop of the route (brought forward to that time),
 *   so the order of the route's statuses, which decides the one « Annuler »
 *   may undo, is not set by the phone alone.
 * Pure module (unit-tested).
 */
import type { StopKind } from "@prisma/client";

/** About 3 h: a white zone between Sisteron and Grenoble, plus the time to come back to the app. */
export const MAX_STATUS_AGE_MS = 3 * 60 * 60 * 1000;

/** Below this gap between the gesture and the reception, the status counts as sent live. */
export const DEFERRED_AFTER_MS = 60 * 1000;

export type ObservedTimeInput = {
  /** Phone clock at the gesture (epoch ms), null for a client that does not send it. */
  observedAt: number | null;
  /** Phone clock when the request left (epoch ms), null when not sent: no offset correction. */
  sentAt: number | null;
  /** Server clock at reception. */
  receivedAt: Date;
  /** Time of the latest status this one follows (previousStatusAt), if any. */
  previousAt: Date | null;
};

export type ObservedTime =
  | {
      ok: true;
      /** The time to record (RouteStop.completedAt). */
      at: Date;
      /** Sent later from the offline queue (DEFERRED_AFTER_MS or more after the gesture). */
      deferred: boolean;
    }
  | { ok: false; reason: "too-old" };

export function boundObservedAt({ observedAt, sentAt, receivedAt, previousAt }: ObservedTimeInput): ObservedTime {
  const received = receivedAt.getTime();
  if (observedAt === null || !Number.isFinite(observedAt)) return { ok: true, at: receivedAt, deferred: false };
  const offset = sentAt !== null && Number.isFinite(sentAt) ? received - sentAt : 0;
  let at = Math.min(observedAt + offset, received);
  if (at < received - MAX_STATUS_AGE_MS) return { ok: false, reason: "too-old" };
  if (previousAt && at < previousAt.getTime()) at = Math.min(previousAt.getTime(), received);
  return { ok: true, at: new Date(at), deferred: received - at >= DEFERRED_AFTER_MS };
}

/** A stop of the route as previousStatusAt reads it. */
export type RecordedStop = {
  id: string;
  sequence: number;
  kind: StopKind;
  tripId: string;
  completedAt: Date | null;
  /** The trip is cancelled: its status belongs to the regulator now (left out, as in latestCompletedStopId). */
  cancelled: boolean;
};

/**
 * The latest status a new status on `stop` may not precede: the latest one
 * recorded on an earlier stop of the route (cancelled trips aside), and for a
 * dropoff its trip's pickup. Null when there is none.
 */
export function previousStatusAt(
  stop: Pick<RecordedStop, "id" | "sequence" | "kind" | "tripId">,
  routeStops: readonly RecordedStop[],
): Date | null {
  let latest: number | null = null;
  for (const other of routeStops) {
    if (!other.completedAt || other.id === stop.id) continue;
    const earlier = other.sequence < stop.sequence && !other.cancelled;
    const ownPickup = stop.kind === "DROPOFF" && other.kind === "PICKUP" && other.tripId === stop.tripId;
    if (earlier || ownPickup) latest = Math.max(latest ?? Number.NEGATIVE_INFINITY, other.completedAt.getTime());
  }
  return latest === null ? null : new Date(latest);
}

/**
 * The earliest status a new status on `stop` may not follow: the earliest one recorded on a later stop of the route
 * (cancelled trips aside), and for a pickup its own drop-off. Null when there is none. With previousStatusAt, it
 * bounds a time typed afterwards (« Fin de tournée »), which must keep the route's statuses in their order.
 */
export function nextStatusAt(
  stop: Pick<RecordedStop, "id" | "sequence" | "kind" | "tripId">,
  routeStops: readonly RecordedStop[],
): Date | null {
  let earliest: number | null = null;
  for (const other of routeStops) {
    if (!other.completedAt || other.id === stop.id) continue;
    const later = other.sequence > stop.sequence && !other.cancelled;
    const ownDropoff = stop.kind === "PICKUP" && other.kind === "DROPOFF" && other.tripId === stop.tripId;
    if (later || ownDropoff) earliest = Math.min(earliest ?? Number.POSITIVE_INFINITY, other.completedAt.getTime());
  }
  return earliest === null ? null : new Date(earliest);
}

export type DeclaredTime =
  | { ok: true; at: Date }
  | { ok: false; reason: "future" | "before-previous" | "after-next"; bound: Date | null };

/**
 * A time typed afterwards by the crew (« Fin de tournée », FLD-02): the real time of a forgotten status, already the
 * instant of its minute on the service day. Never in the future, never before the statuses it follows nor after the
 * ones that follow it (previousStatusAt, nextStatusAt): unlike a gesture, it is refused rather than moved.
 */
export function boundDeclaredAt(args: { at: Date; receivedAt: Date; previousAt: Date | null; nextAt: Date | null }): DeclaredTime {
  const { at, receivedAt, previousAt, nextAt } = args;
  if (at.getTime() > receivedAt.getTime()) return { ok: false, reason: "future", bound: null };
  if (previousAt && at.getTime() < previousAt.getTime()) return { ok: false, reason: "before-previous", bound: previousAt };
  if (nextAt && at.getTime() > nextAt.getTime()) return { ok: false, reason: "after-next", bound: nextAt };
  return { ok: true, at };
}

/**
 * Refusal shown to the crew for a status older than MAX_STATUS_AGE_MS: tapping
 * again would record the current time, so the crew types the real one in
 * « Fin de tournée » (until 03:00 the next day), or calls the regulation.
 */
export const TOO_OLD_ERROR =
  "Statut saisi il y a plus de 3\u00a0h, non enregistré. Saisissez l'heure réelle dans «\u202fFin de tournée\u202f» " +
  "(un nouvel appui enregistrerait l'heure actuelle), ou appelez la régulation.";
