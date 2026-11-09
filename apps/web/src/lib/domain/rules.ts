/**
 * Business rules shared by forms, trip generation and the optimizer request.
 * Pure functions: no database, no server-only imports (used by the seed and tests).
 */
import type {
  Payer,
  PrescribedMode,
  SharingScope,
  SharingStatus,
  TripDirection,
  VehicleType,
} from "@prisma/client";

/** The prescribed mode fixes the vehicle: lying -> ambulance; seated -> VSL or taxi. Private clients ride a taxi. */
export function allowedVehicleTypesFor(mode: PrescribedMode | null, payer: Payer): VehicleType[] {
  if (payer === "PRIVATE") return ["TAXI"];
  return mode === "AMBULANCE" ? ["AMBULANCE"] : ["TAXI", "VSL"];
}

/** Shared transport only for TAP trips whose prescription allows sharing on this leg. */
export function sharingAllowedFor(
  scope: SharingScope | null,
  direction: TripDirection,
  mode: PrescribedMode | null,
  payer: Payer,
): boolean {
  if (payer === "PRIVATE" || mode !== "TAP" || !scope) return false;
  return scope === "BOTH" || scope === direction;
}

export function initialSharingStatus(sharingAllowed: boolean): SharingStatus {
  return sharingAllowed ? "NOT_PROPOSED" : "NOT_ELIGIBLE";
}

/**
 * Sharing traceability once the prescription rules of a trip change: no longer
 * allowed -> NOT_ELIGIBLE (a refusal stays recorded); allowed again -> NOT_PROPOSED.
 */
export function nextSharingStatus(current: SharingStatus, sharingAllowed: boolean): SharingStatus {
  if (!sharingAllowed) return current === "REFUSED" ? current : "NOT_ELIGIBLE";
  return current === "NOT_ELIGIBLE" ? "NOT_PROPOSED" : current;
}

/** What the optimizer may do with a trip: share only if allowed and the patient did not refuse. */
export function isShareable(trip: { sharingAllowed: boolean; sharingStatus: SharingStatus }): boolean {
  return trip.sharingAllowed && trip.sharingStatus !== "REFUSED" && trip.sharingStatus !== "NOT_ELIGIBLE";
}

/** Default seats per vehicle type: V shares at most 2 patients; an ambulance carries 1. */
export const DEFAULT_CAPACITY: Record<VehicleType, number> = {
  TAXI: 2,
  VSL: 2,
  AMBULANCE: 1,
};

/** Qualifications needed to drive (and crew) each vehicle type. */
export const REQUIRED_QUALIFICATIONS = {
  TAXI: { driver: ["TAXI_CARD"], crewMate: null },
  VSL: { driver: ["AUXILIARY", "DEA"], crewMate: null },
  AMBULANCE: { driver: ["DEA"], crewMate: ["AUXILIARY", "DEA"] },
} as const satisfies Record<VehicleType, { driver: readonly string[]; crewMate: readonly string[] | null }>;

export function formatAddress(place: { address: string; postalCode: string; city: string }): string {
  return `${place.address}, ${place.postalCode} ${place.city}`;
}
