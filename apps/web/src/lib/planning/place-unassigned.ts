/**
 * « Placer les non affectées » (UX-07): a computation where every trip already
 * in a route is sent locked on the vehicle of that route, for this computation
 * only (never written on the trip), so that only the trips without a vehicle
 * are placed, without moving the others to another vehicle. Their times may
 * still shift to make room. Pure.
 */
import type { OptimizeInput } from "@/lib/optimizer/build-request";

export type PinnedInput = {
  input: OptimizeInput;
  /** Trips sent locked for this computation only. */
  pinned: ReadonlySet<string>;
  /** Trips of the request without a route: the ones to place. */
  toPlace: number;
};

/**
 * The day's input with the assigned trips pinned to the vehicle of their route
 * (`assignments`: trip id → vehicle id of its route). A trip locked by the
 * regulator keeps its own lock, even on another vehicle.
 */
export function pinAssignedTrips(input: OptimizeInput, assignments: ReadonlyMap<string, string>): PinnedInput {
  const pinned = new Set<string>();
  let toPlace = 0;
  const trips = input.trips.map((trip) => {
    const vehicleId = assignments.get(trip.id);
    if (!vehicleId) {
      toPlace += 1;
      return trip;
    }
    if (trip.lockedVehicleId !== null) return trip;
    pinned.add(trip.id);
    return { ...trip, lockedVehicleId: vehicleId };
  });
  return { input: { ...input, trips }, pinned, toPlace };
}
