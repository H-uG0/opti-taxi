/**
 * One order for vehicles and people on every screen (Véhicules, Chauffeurs,
 * Équipages, Planning, Dépôts, optimizer request): depot by name, then type
 * (taxi, VSL, ambulance), then label in numeric order (« Taxi 2 » before
 * « Taxi 10 »); people by last name, then first name. Pure module.
 */
import type { VehicleType } from "@prisma/client";

export const VEHICLE_TYPE_ORDER: Record<VehicleType, number> = { TAXI: 0, VSL: 1, AMBULANCE: 2 };

const collator = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });

/** Labels in numeric order, case and accents aside: « Taxi 2 » < « taxi 10 » < « VSL 1 ». */
export function compareLabels(a: string, b: string): number {
  return collator.compare(a, b);
}

/** Type (taxi, VSL, ambulance), then label in numeric order. */
export function compareVehicles(a: { type: VehicleType; label: string }, b: { type: VehicleType; label: string }): number {
  return VEHICLE_TYPE_ORDER[a.type] - VEHICLE_TYPE_ORDER[b.type] || compareLabels(a.label, b.label);
}

/** Depot name, then type, then label: the order of the lists grouped by depot. */
export function compareVehiclesByDepot(
  a: { depotName: string; type: VehicleType; label: string },
  b: { depotName: string; type: VehicleType; label: string },
): number {
  return compareLabels(a.depotName, b.depotName) || compareVehicles(a, b);
}

/** Last name, then first name. */
export function comparePeople(a: { lastName: string; firstName: string }, b: { lastName: string; firstName: string }): number {
  return compareLabels(a.lastName, b.lastName) || compareLabels(a.firstName, b.firstName);
}
