/**
 * Business rules shared by forms, trip generation and the optimizer request.
 * Pure functions: no database, no server-only imports (used by the seed and tests).
 */
import type {
  Payer,
  PrescribedMode,
  Qualification,
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

/**
 * Qualifications accepted on each seat of a vehicle type ("any of"), and the
 * one the whole crew must hold at least once (CREW_REQUIRED_ONE_OF).
 *
 * Ambulance (vehicles of categories A and C): article R. 6312-10 of the code
 * de la santé publique asks for a crew of two people (up to three for a
 * bariatric transport), at least one of whom holds the diplôme d'État
 * d'ambulancier (1° of art. R. 6312-7), without saying who drives. The arrêté
 * of 11 April 2022 (training of the ambulancier and of the auxiliaire
 * ambulancier, JORF of 17 April 2022), art. 2: « L'auxiliaire ambulancier est
 * habilité à assurer la conduite du véhicule sanitaire léger et de
 * l'ambulance. Il peut également être l'équipier de l'ambulancier dans
 * l'ambulance. » No text found requires the DEA to sit beside the patient
 * (checked on Légifrance, 9 November 2026): two AUXILIARY or DEA, at least one
 * DEA, whoever drives. The usual crew of V (auxiliary at the wheel, DEA beside
 * the patient) is the one the automatic proposals prefer (lib/staff/day-crews.ts).
 */
export const REQUIRED_QUALIFICATIONS = {
  TAXI: { driver: ["TAXI_CARD"], crewMate: null },
  VSL: { driver: ["AUXILIARY", "DEA"], crewMate: null },
  AMBULANCE: { driver: ["AUXILIARY", "DEA"], crewMate: ["AUXILIARY", "DEA"] },
} as const satisfies Record<VehicleType, { driver: readonly Qualification[]; crewMate: readonly Qualification[] | null }>;

/** Qualification one member of the crew at least must hold, whatever their seat (ambulance: a DEA). */
export const CREW_REQUIRED_ONE_OF = {
  TAXI: null,
  VSL: null,
  AMBULANCE: ["DEA"],
} as const satisfies Record<VehicleType, readonly Qualification[] | null>;

/**
 * Whether a complete crew (the qualifications of each person on board) holds
 * what its vehicle type needs once: true for a taxi or a VSL, true for an
 * ambulance with a DEA at the wheel or beside the patient.
 */
export function crewHoldsRequired(type: VehicleType, members: readonly (readonly Qualification[])[]): boolean {
  const required: readonly Qualification[] | null = CREW_REQUIRED_ONE_OF[type];
  if (!required) return true;
  return members.some((qualifications) => qualifications.some((q) => required.includes(q)));
}

export function formatAddress(place: { address: string; postalCode: string; city: string }): string {
  return `${place.address}, ${place.postalCode} ${place.city}`;
}
