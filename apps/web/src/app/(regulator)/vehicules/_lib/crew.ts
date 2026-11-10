/**
 * Crew qualification rules (REQUIRED_QUALIFICATIONS and CREW_REQUIRED_ONE_OF
 * in rules.ts): who may drive or crew each vehicle type, and what the whole
 * crew must hold (an ambulance: a DEA, at the wheel or beside the patient).
 * Each requirement list is "any of". Pure module, shared by the vehicle and
 * driver forms.
 */
import type { Qualification, VehicleType } from "@prisma/client";
import { CREW_REQUIRED_ONE_OF, crewHoldsRequired, REQUIRED_QUALIFICATIONS } from "@/lib/domain/rules";
import { QUALIFICATION_LABELS, QUALIFICATION_NOUNS } from "@/lib/labels";
import { formatPersonName } from "@/lib/names";

export const VEHICLE_TYPE_WITH_ARTICLE: Record<VehicleType, string> = {
  TAXI: "un taxi",
  VSL: "un VSL",
  AMBULANCE: "une ambulance",
};

export type CrewMember = {
  firstName: string;
  lastName: string;
  qualifications: readonly Qualification[];
};

export function crewMemberName(member: Pick<CrewMember, "firstName" | "lastName">): string {
  return formatPersonName(member);
}

export function hasRequiredQualification(
  qualifications: readonly Qualification[],
  required: readonly Qualification[] | null,
): boolean {
  if (!required || required.length === 0) return true;
  return required.some((q) => qualifications.includes(q));
}

/** ["AUXILIARY", "DEA"] -> "Auxiliaire ambulancier ou Ambulancier DE" (a list of qualifications). */
export function qualificationRequirement(required: readonly Qualification[]): string {
  return required.map((q) => QUALIFICATION_LABELS[q]).join(" ou ");
}

/** ["DEA"] -> "ambulancier DE": the people holding them, inside a sentence (« au moins un ambulancier DE »). */
export function qualificationNoun(required: readonly Qualification[]): string {
  return required.map((q) => QUALIFICATION_NOUNS[q]).join(" ou ");
}

export function driverRequirement(type: VehicleType): readonly Qualification[] {
  return REQUIRED_QUALIFICATIONS[type].driver;
}

export function crewMateRequirement(type: VehicleType): readonly Qualification[] | null {
  return REQUIRED_QUALIFICATIONS[type].crewMate;
}

/** What one member of the crew must hold whatever their seat, or null (ambulance: ["DEA"]). */
export function crewOneOfRequirement(type: VehicleType): readonly Qualification[] | null {
  return CREW_REQUIRED_ONE_OF[type];
}

/** ", avec au moins un ambulancier DE dans l'équipage" for an ambulance, "" otherwise. */
export function crewRuleSuffix(type: VehicleType): string {
  const oneOf = crewOneOfRequirement(type);
  return oneOf ? `, avec au moins un ${qualificationNoun(oneOf)} dans l'équipage` : "";
}

/**
 * Message when a complete crew lacks what its vehicle type needs once (an
 * ambulance without any DEA), or null. Both seats must be filled: with one
 * empty seat, the person put there later must make up for it.
 */
export function crewCompositionError(
  type: VehicleType,
  driver: NamedMember | null,
  crewMate: NamedMember | null,
): string | null {
  const oneOf = crewOneOfRequirement(type);
  if (!oneOf || !driver || !crewMate) return null;
  if (crewHoldsRequired(type, [driver.qualifications, crewMate.qualifications])) return null;
  return `Il faut au moins un ${qualificationNoun(oneOf)} dans l'équipage d'${VEHICLE_TYPE_WITH_ARTICLE[type].replace(/^une? /, "")}, au volant ou auprès du patient\u00a0: ni ${driver.name} ni ${crewMate.name} ne l'est.`;
}

/** A crew member as the forms show it. */
export type NamedMember = { name: string; qualifications: readonly Qualification[] };

const named = (member: CrewMember | null): NamedMember | null =>
  member ? { name: crewMemberName(member), qualifications: member.qualifications } : null;

/**
 * Field errors when the default driver / crew mate of a vehicle lacks the
 * qualification its type requires. Empty object when the crew is valid.
 */
export function crewQualificationErrors(
  type: VehicleType,
  driver: CrewMember | null,
  crewMate: CrewMember | null,
): Partial<Record<"defaultDriverId" | "defaultCrewMateId", string>> {
  const errors: Partial<Record<"defaultDriverId" | "defaultCrewMateId", string>> = {};
  const driverRule = driverRequirement(type);
  if (driver && !hasRequiredQualification(driver.qualifications, driverRule)) {
    errors.defaultDriverId = `${crewMemberName(driver)} n'a pas la qualification requise pour conduire ${VEHICLE_TYPE_WITH_ARTICLE[type]} (${qualificationRequirement(driverRule)}).`;
  }
  const crewRule = crewMateRequirement(type);
  if (crewMate && crewRule && !hasRequiredQualification(crewMate.qualifications, crewRule)) {
    errors.defaultCrewMateId = `${crewMemberName(crewMate)} n'a pas la qualification requise pour être équipier d'${VEHICLE_TYPE_WITH_ARTICLE[type].replace(/^une? /, "")} (${qualificationRequirement(crewRule)}).`;
  }
  // Each seat is fine: the pair still needs its DEA (R. 6312-10).
  const composition = Object.keys(errors).length === 0 && crewRule ? crewCompositionError(type, named(driver), named(crewMate)) : null;
  if (composition) errors.defaultCrewMateId = composition;
  return errors;
}

// ------------------------------------------------ one person, one vehicle a day

/** A vehicle whose default crew a person belongs to. */
export type CrewSeat = { vehicleId: string; label: string; role: "driver" | "crewMate" };

type CrewedVehicle = {
  id: string;
  label: string;
  type: VehicleType;
  active: boolean;
  defaultDriverId: string | null;
  defaultCrewMateId: string | null;
};

/**
 * Active vehicles each person is in the default crew of, by person id. As in
 * the optimisation request, the crew mate only counts on an ambulance.
 */
export function seatsByPerson(vehicles: readonly CrewedVehicle[]): Map<string, CrewSeat[]> {
  const seats = new Map<string, CrewSeat[]>();
  const add = (personId: string | null, seat: CrewSeat) => {
    if (!personId) return;
    const list = seats.get(personId);
    if (list) list.push(seat);
    else seats.set(personId, [seat]);
  };
  for (const vehicle of vehicles) {
    if (!vehicle.active) continue;
    add(vehicle.defaultDriverId, { vehicleId: vehicle.id, label: vehicle.label, role: "driver" });
    if (vehicle.type === "AMBULANCE") {
      add(vehicle.defaultCrewMateId, { vehicleId: vehicle.id, label: vehicle.label, role: "crewMate" });
    }
  }
  return seats;
}

/** Number of active vehicles a person holds a planned seat in (crew mate: ambulances only). */
export function plannedSeatCount(
  asDriver: readonly { active: boolean }[],
  asCrewMate: readonly { active: boolean; type: VehicleType }[],
): number {
  return asDriver.filter((v) => v.active).length + asCrewMate.filter((v) => v.active && v.type === "AMBULANCE").length;
}

/** The seats of `personId` on vehicles other than `vehicleId`. */
export function otherSeats(seats: ReadonlyMap<string, readonly CrewSeat[]>, personId: string | null, vehicleId: string): CrewSeat[] {
  if (!personId) return [];
  return (seats.get(personId) ?? []).filter((seat) => seat.vehicleId !== vehicleId);
}

/** "chauffeur par défaut de « VSL 2 » et équipier de « Ambulance 1 »". */
function describeSeats(seats: readonly CrewSeat[]): string {
  const parts = seats.map((seat) => `${seat.role === "driver" ? "chauffeur par défaut" : "équipier"} de «\u202f${seat.label}\u202f»`);
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} et ${parts[parts.length - 1]}`;
}

/**
 * Warning when a person chosen for a vehicle is already in the default crew of
 * other active vehicles: a person works on one vehicle a day (crews of the
 * day, lib/staff/day-crews.ts), the first one in display order keeps them and
 * the others get a replacement when someone qualified is free, or stay at the
 * depot. A warning, not a block, so spare vehicles stay possible. Null when no
 * overlap.
 */
export function sharedCrewWarning(name: string, others: readonly CrewSeat[]): string | null {
  if (others.length === 0) return null;
  const many = others.length > 1;
  return `${name} est déjà ${describeSeats(others)}\u00a0: une personne ne roule que sur un véhicule par jour, ${many ? "les autres recevront" : "l'autre recevra"} un remplaçant s'il y en a un de libre (page Équipages).`;
}

/**
 * What a qualification allows, derived from the rules: "Conduite : VSL,
 * ambulance · Équipier : ambulance · Requis dans chaque équipage d'ambulance".
 */
export function qualificationScope(qualification: Qualification): string {
  const types = Object.keys(REQUIRED_QUALIFICATIONS) as VehicleType[];
  const names: Record<VehicleType, string> = { TAXI: "taxi", VSL: "VSL", AMBULANCE: "ambulance" };
  const drive = types.filter((t) => hasRequiredQualification([qualification], driverRequirement(t)));
  const crew = types.filter((t) => {
    const rule = crewMateRequirement(t);
    return rule !== null && hasRequiredQualification([qualification], rule);
  });
  const parts: string[] = [];
  if (drive.length > 0) parts.push(`Conduite\u00a0: ${drive.map((t) => names[t]).join(", ")}`);
  if (crew.length > 0) parts.push(`Équipier\u00a0: ${crew.map((t) => names[t]).join(", ")}`);
  for (const t of types) {
    const oneOf = crewOneOfRequirement(t);
    if (!oneOf) continue;
    if (oneOf.includes(qualification)) parts.push(`Au moins un dans chaque équipage d'${names[t]}`);
    else if (drive.includes(t) || crew.includes(t)) parts.push(`En ${names[t]}, avec un ${qualificationNoun(oneOf)}`);
  }
  return parts.join(" · ");
}
