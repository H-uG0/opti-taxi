/**
 * Crew qualification rules (REQUIRED_QUALIFICATIONS in rules.ts): who may drive
 * or crew each vehicle type. Each requirement list is "any of".
 * Pure module, shared by the vehicle and driver forms.
 */
import type { Qualification, VehicleType } from "@prisma/client";
import { REQUIRED_QUALIFICATIONS } from "@/lib/domain/rules";
import { QUALIFICATION_LABELS } from "@/lib/labels";

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
  return `${member.firstName} ${member.lastName}`;
}

export function hasRequiredQualification(
  qualifications: readonly Qualification[],
  required: readonly Qualification[] | null,
): boolean {
  if (!required || required.length === 0) return true;
  return required.some((q) => qualifications.includes(q));
}

/** ["AUXILIARY", "DEA"] -> "Auxiliaire ambulancier ou Ambulancier DE". */
export function qualificationRequirement(required: readonly Qualification[]): string {
  return required.map((q) => QUALIFICATION_LABELS[q]).join(" ou ");
}

export function driverRequirement(type: VehicleType): readonly Qualification[] {
  return REQUIRED_QUALIFICATIONS[type].driver;
}

export function crewMateRequirement(type: VehicleType): readonly Qualification[] | null {
  return REQUIRED_QUALIFICATIONS[type].crewMate;
}

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
  const parts = seats.map((seat) => `${seat.role === "driver" ? "chauffeur par défaut" : "équipier"} de « ${seat.label} »`);
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} et ${parts[parts.length - 1]}`;
}

/**
 * Warning when a person chosen for a vehicle is already in the default crew of
 * other active vehicles: the optimisation gives each person one vehicle a day
 * (the first one in display order), the others are left out of the plan.
 * A warning, not a block, so spare vehicles stay possible. Null when no overlap.
 */
export function sharedCrewWarning(name: string, others: readonly CrewSeat[]): string | null {
  if (others.length === 0) return null;
  const total = others.length + 1;
  const which = total === 2 ? "des deux véhicules" : `des ${total} véhicules`;
  return `${name} est déjà ${describeSeats(others)} : un seul ${which} pourra être planifié chaque jour.`;
}

/** What a qualification allows, derived from the rules: "Conduite : VSL, ambulance · Équipier : ambulance". */
export function qualificationScope(qualification: Qualification): string {
  const types = Object.keys(REQUIRED_QUALIFICATIONS) as VehicleType[];
  const names: Record<VehicleType, string> = { TAXI: "taxi", VSL: "VSL", AMBULANCE: "ambulance" };
  const drive = types.filter((t) => hasRequiredQualification([qualification], driverRequirement(t)));
  const crew = types.filter((t) => {
    const rule = crewMateRequirement(t);
    return rule !== null && hasRequiredQualification([qualification], rule);
  });
  const parts: string[] = [];
  if (drive.length > 0) parts.push(`Conduite : ${drive.map((t) => names[t]).join(", ")}`);
  if (crew.length > 0) parts.push(`Équipier : ${crew.map((t) => names[t]).join(", ")}`);
  return parts.join(" · ");
}
