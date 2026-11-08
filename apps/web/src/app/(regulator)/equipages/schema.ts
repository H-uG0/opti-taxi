/**
 * Crew form of a date (Équipages page): reading the submitted crews and the
 * problems that block saving them. Pure module (unit-tested).
 */
import type { VehicleType } from "@prisma/client";
import { valueOf, type FieldErrors, type FormValues } from "@/lib/forms";
import type { DayCrewPlan, SavedCrew } from "@/lib/staff/day-crews";

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export const driverField = (vehicleId: string) => `driver:${vehicleId}`;
export const crewMateField = (vehicleId: string) => `mate:${vehicleId}`;

/**
 * The crew of every vehicle as submitted: an empty select means nobody. A
 * malformed id is reported on its field. Only an ambulance has a crew mate.
 */
export function readCrewForm(
  values: FormValues,
  vehicles: readonly { id: string; type: VehicleType }[],
): { saved: SavedCrew[]; errors: FieldErrors } {
  const saved: SavedCrew[] = [];
  const errors: FieldErrors = {};
  const read = (field: string): string | null => {
    const raw = valueOf(values, field).trim();
    if (raw === "") return null;
    if (!ID.test(raw)) {
      errors[field] = "Personne inconnue : rechargez la page.";
      return null;
    }
    return raw;
  };
  for (const vehicle of vehicles) {
    const driverId = read(driverField(vehicle.id));
    const crewMateId = vehicle.type === "AMBULANCE" ? read(crewMateField(vehicle.id)) : null;
    saved.push({ vehicleId: vehicle.id, driverId, crewMateId });
  }
  return { saved, errors };
}

/**
 * Problems that block saving: every error of the resolved crews, except a
 * vehicle the regulator left without anybody on purpose (it stays at the
 * depot that day).
 */
export function crewFormErrors(plan: Pick<DayCrewPlan, "crews">): FieldErrors {
  const errors: FieldErrors = {};
  for (const crew of plan.crews) {
    if (crew.driverId === null && crew.crewMateId === null) continue;
    for (const issue of crew.issues) {
      if (issue.level !== "error") continue;
      const field = issue.seat === "crewMate" ? crewMateField(crew.vehicleId) : driverField(crew.vehicleId);
      if (!errors[field]) errors[field] = issue.message;
    }
    if (crew.driverId === null && crew.crewMateId !== null && !errors[driverField(crew.vehicleId)]) {
      errors[driverField(crew.vehicleId)] = "Choisissez aussi un chauffeur, ou retirez l'équipier.";
    }
  }
  return errors;
}

export const SOURCE_LABELS = {
  saved: "Fixé",
  default: "Attitré",
  replacement: "Remplaçant",
  none: "Sans équipage",
} as const;
