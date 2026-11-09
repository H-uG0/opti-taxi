/**
 * Manual adjustments of the regulator on the eve of a simulated day (pure,
 * unit-tested). Some patients ask for « their » driver: once the first plan
 * is computed, the regulator freezes (« Figer ») their trips of the day on
 * the vehicle the plan gave them, so that the re-optimizations after a
 * refusal keep them there. Drawn per patient, the same on every run.
 */
import { unitFromKey } from "./hash";

/** Share of the patients of a series who ask for the same driver. */
export const SAME_DRIVER_SHARE = 0.05;

export function asksForSameDriver(patientId: string): boolean {
  return unitFromKey(`same-driver:${patientId}`) < SAME_DRIVER_SHARE;
}

export type LockCandidate = {
  id: string;
  patientId: string;
  recurrenceId: string | null;
  vehicleId: string | null;
  lockedVehicleId: string | null;
};

/** Trips to freeze on their planned vehicle (series trips of patients who ask for it, placed, not frozen yet), by id. */
export function tripsToLock(trips: readonly LockCandidate[]): { id: string; vehicleId: string }[] {
  return trips
    .filter((trip) => trip.recurrenceId !== null && trip.vehicleId !== null && trip.lockedVehicleId === null && asksForSameDriver(trip.patientId))
    .map((trip) => ({ id: trip.id, vehicleId: trip.vehicleId ?? "" }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
