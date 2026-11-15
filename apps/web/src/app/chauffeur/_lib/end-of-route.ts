/**
 * « Fin de tournée » (FLD-02): what the crew still has to enter on a route — the stops left without a status, each
 * with its planned time, its patient and its town (no address, no note: data minimisation) — and how many statuses
 * were entered (« Statuts saisis : 12 sur 14 »). The crew enters a forgotten status with its real time until 03:00 the
 * next day (access.ts lateEntryDates). Pure: unit-tested.
 */
import type { StopKind, TripDirection, TripStatus } from "@prisma/client";
import { isStopClosed, stopState } from "@/lib/domain/stops";
import { displayName, townOf } from "./roadmap";

export type EndOfRouteStopInput = {
  id: string;
  sequence: number;
  kind: StopKind;
  tripId: string;
  startMinute: number;
  address: string;
  completedAt: Date | null;
  trip: { status: TripStatus; direction: TripDirection; patient: { firstName: string; lastName: string } };
};

export type PendingStop = {
  id: string;
  kind: StopKind;
  plannedMinute: number;
  patient: string;
  town: string | null;
  /** On a drop-off: its pickup, when it is left without a status too (to enter first). */
  pickupStopId: string | null;
};

export type EndOfRouteView = {
  /** Stops closed (done, absent, skipped, cancelled) over all stops. */
  closed: number;
  total: number;
  /** Stops without a status, in route order. */
  pending: PendingStop[];
};

/** A stop whose planned time is more than this behind the clock without a status is « oublié ». */
export const FORGOTTEN_AFTER_MIN = 10;

export function endOfRouteView(stops: readonly EndOfRouteStopInput[]): EndOfRouteView {
  const ordered = [...stops].sort((a, b) => a.sequence - b.sequence);
  const state = (stop: EndOfRouteStopInput) => ({ kind: stop.kind, completedAt: stop.completedAt, tripStatus: stop.trip.status });
  const pendingPickups = new Map(
    ordered.filter((stop) => stop.kind === "PICKUP" && stopState(state(stop)) === "pending").map((stop) => [stop.tripId, stop.id]),
  );
  return {
    closed: ordered.filter((stop) => isStopClosed(state(stop))).length,
    total: ordered.length,
    pending: ordered
      .filter((stop) => stopState(state(stop)) === "pending")
      .map((stop) => ({
        id: stop.id,
        kind: stop.kind,
        plannedMinute: stop.startMinute,
        patient: displayName(stop.trip.patient),
        town: townOf(stop.address),
        pickupStopId: stop.kind === "DROPOFF" ? (pendingPickups.get(stop.tripId) ?? null) : null,
      })),
  };
}

/**
 * Stops of a route left without a status although their time is past (« N arrêts sans statut » on the roadmap):
 * those planned more than FORGOTTEN_AFTER_MIN before `nowMinute`, on a route of today; every one on a past day.
 */
export function forgottenStops(pending: readonly Pick<PendingStop, "plannedMinute">[], nowMinute: number | null): number {
  return pending.filter((stop) => nowMinute === null || stop.plannedMinute + FORGOTTEN_AFTER_MIN < nowMinute).length;
}
