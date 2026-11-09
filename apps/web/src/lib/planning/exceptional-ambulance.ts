/**
 * « Recours exceptionnel à une ambulance » (protocol of 24 September 2025,
 * art. 4.1.1 II): when no taxi or VSL can take a seated (TAP) trip, an
 * ambulance may, billed at the VSL tariff. Never automatic: a regulator
 * proposes it for one unassigned trip and one ambulance of the day; the trip
 * is then locked on it (build-request.ts isExceptionalAmbulanceTrip). Pure
 * module, unit-tested.
 */
import type { Payer, TripStatus, VehicleType } from "@prisma/client";

export const EXCEPTIONAL_AMBULANCE_REASON = "Recours exceptionnel à une ambulance (aucun taxi ni VSL disponible)";

export type ExceptionalCandidate = {
  status: TripStatus;
  payer: Payer;
  allowedVehicleTypes: readonly VehicleType[];
  /** The trip is in a route (served). */
  assigned: boolean;
};

/** Why this trip cannot get an exceptional ambulance, or null when it can. */
export function exceptionalAmbulanceIssue(trip: ExceptionalCandidate): string | null {
  if (trip.status === "CANCELLED" || trip.status === "NO_SHOW") return "Cette course est annulée.";
  if (trip.status === "PICKED_UP" || trip.status === "DROPPED_OFF") return "Cette course est déjà commencée ou terminée.";
  if (trip.allowedVehicleTypes.includes("AMBULANCE")) return "Cette course est déjà prescrite en ambulance.";
  if (!trip.allowedVehicleTypes.some((t) => t === "TAXI" || t === "VSL")) return "Cette course n'est pas un transport assis.";
  if (trip.payer !== "CPAM") return "Le recours à une ambulance au tarif VSL ne concerne que les transports pris en charge par l'Assurance maladie.";
  if (trip.assigned) return "Cette course a déjà un véhicule : le recours exceptionnel ne concerne qu'une course non affectée.";
  return null;
}
