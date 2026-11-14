/**
 * Whether the crew has done a stop: its own record (completedAt), or its trip's field status. A pure
 * module without imports beyond types, shared by persist.ts, refresh-routes.ts and route-writes.ts.
 */
import type { StopKind, TripStatus } from "@prisma/client";

/** A stop the crew has done: recorded, or implied by its trip's field status. */
export function isStopDone(stop: { kind: StopKind; completedAt?: Date | null }, tripStatus: TripStatus | undefined): boolean {
  if (stop.completedAt) return true;
  if (tripStatus === "DROPPED_OFF") return true;
  return stop.kind === "PICKUP" && (tripStatus === "PICKED_UP" || tripStatus === "NO_SHOW");
}
