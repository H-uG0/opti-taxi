/**
 * State of a stop of a route, from what the crew recorded and the status of
 * its trip: shared by the driver's roadmap (app/chauffeur) and the regulator
 * screens (what is left of a route, lib/staff/route-crew.ts). Pure module.
 */
import type { StopKind, TripStatus } from "@prisma/client";

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

/** The fields of a stop its state is read from. */
export type StopStatusFields = { kind: StopKind; completedAt: Date | null; tripStatus: TripStatus };

export function stopState(stop: StopStatusFields): StopState {
  if (stop.tripStatus === "CANCELLED") return "cancelled";
  if (stop.tripStatus === "NO_SHOW") return stop.kind === "PICKUP" ? "no_show" : "skipped";
  return stop.completedAt ? "done" : "pending";
}

/** True once nothing is left to do on the stop (done, absent, skipped or cancelled). */
export function isStopClosed(stop: StopStatusFields): boolean {
  return stopState(stop) !== "pending";
}
