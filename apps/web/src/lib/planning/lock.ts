/**
 * Lock writes of the planning actions (« Figer », « Défiger », « Déplacer
 * vers… »): conditional, so that a write, and its audit event, happen only
 * when the lock actually changes. Pure: no server-only import.
 */
import type { Prisma } from "@prisma/client";

/**
 * Trips not locked on `vehicleId` yet, unlocked trips included: in SQL,
 * `"lockedVehicleId" <> $1` is not true for NULL, so `{ not: vehicleId }`
 * alone would leave out every unlocked trip.
 */
export function notLockedOn(vehicleId: string): Prisma.TripWhereInput {
  return { OR: [{ lockedVehicleId: null }, { lockedVehicleId: { not: vehicleId } }] };
}

/** Trips locked on some vehicle. */
export const LOCKED: Prisma.TripWhereInput = { lockedVehicleId: { not: null } };

/** Audit action of setting a trip's lock to `lockedVehicleId` (null: no lock), e.g. when a rejected move puts it back. */
export function lockAction(lockedVehicleId: string | null): "trip.lock" | "trip.unlock" {
  return lockedVehicleId ? "trip.lock" : "trip.unlock";
}
