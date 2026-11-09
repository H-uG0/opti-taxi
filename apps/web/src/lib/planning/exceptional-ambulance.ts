/**
 * « Recours exceptionnel à une ambulance » (protocol of 24 September 2025,
 * art. 4.1.1 II): when no taxi or VSL can take a seated (TAP) trip, an
 * ambulance may, billed at the VSL tariff. Never automatic: a regulator
 * proposes it for one trip the last optimization left unassigned and one
 * ambulance of the day; the trip is then locked on it. The measure holds
 * while the trip stays locked on an ambulance (isExceptionalAmbulanceTrip):
 * the optimizer request, the planning badge and the dashboard read the same
 * predicate. Pure module, unit-tested.
 */
import type { Payer, TripStatus, VehicleType } from "@prisma/client";

/** Why the measure was taken, in the audit trail (trip.exceptional_ambulance) and on the trip in Courses. */
export const EXCEPTIONAL_AMBULANCE_REASON = "Recours exceptionnel à une ambulance (aucun taxi ni VSL disponible)";

export type ExceptionalCandidate = {
  status: TripStatus;
  payer: Payer;
  allowedVehicleTypes: readonly VehicleType[];
  /** The trip is in a route (served). */
  assigned: boolean;
  /** The last optimization of the day ran and could not give the trip any taxi or VSL (its « unassigned » list). */
  leftByOptimizer: boolean;
};

export const OPTIMIZE_FIRST_ISSUE =
  "Optimisez d'abord la journée : le recours exceptionnel ne se propose que pour une course que le dernier calcul n'a pu confier à aucun taxi ni VSL.";

/** Why this trip cannot get an exceptional ambulance, or null when it can. */
export function exceptionalAmbulanceIssue(trip: ExceptionalCandidate): string | null {
  if (trip.status === "CANCELLED" || trip.status === "NO_SHOW") return "Cette course est annulée.";
  if (trip.status === "PICKED_UP" || trip.status === "DROPPED_OFF") return "Cette course est déjà commencée ou terminée.";
  if (trip.allowedVehicleTypes.includes("AMBULANCE")) return "Cette course est déjà prescrite en ambulance.";
  if (!isSeatedOnly(trip.allowedVehicleTypes)) return "Cette course n'est pas un transport assis.";
  if (trip.payer !== "CPAM") return "Le recours à une ambulance au tarif VSL ne concerne que les transports pris en charge par l'Assurance maladie.";
  if (trip.assigned) return "Cette course a déjà un véhicule : le recours exceptionnel ne concerne qu'une course non affectée.";
  if (!trip.leftByOptimizer) return OPTIMIZE_FIRST_ISSUE;
  return null;
}

/** Prescribed vehicle types of a seated (TAP) trip, the only ones an ambulance may exceptionally extend. */
export function isSeatedOnly(types: readonly VehicleType[]): boolean {
  return types.length > 0 && !types.includes("AMBULANCE") && types.some((t) => t === "TAXI" || t === "VSL");
}

/**
 * Is `trip` an exceptional ambulance trip: proposed by a regulator, still
 * locked on an ambulance, seated only by prescription (TAR-03)? The optimizer
 * then accepts that ambulance for it, at the VSL tariff; without the lock, it
 * goes back to taxi or VSL only.
 */
export function isExceptionalAmbulanceTrip(
  trip: { exceptionalAmbulanceAt?: Date | null; lockedVehicleId: string | null; allowedVehicleTypes: readonly VehicleType[] },
  vehicleType: (id: string) => VehicleType | undefined,
): boolean {
  if (!trip.exceptionalAmbulanceAt || !trip.lockedVehicleId) return false;
  return isSeatedOnly(trip.allowedVehicleTypes) && vehicleType(trip.lockedVehicleId) === "AMBULANCE";
}
