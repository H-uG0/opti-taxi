/**
 * Estimated fare of one patient's trip with a tariff grid — the same formula
 * as the optimizer (contract/README.md, « Calcul du CA estimé d'une course »):
 *   base = baseFare + pricePerKm × max(0, km − includedKm)
 *   shared with n patients (n capped at 3): base × (1 − sharedDiscount{n})
 * Pure module, used by the client-side simulator.
 */

export type FareGrid = {
  baseFare: number;
  pricePerKm: number;
  includedKm: number;
  sharedDiscount2: number;
  sharedDiscount3: number;
};

/** Price of a solo trip of `km` kilometres. */
export function soloFare(grid: FareGrid, km: number): number {
  return grid.baseFare + grid.pricePerKm * Math.max(0, km - grid.includedKm);
}

/** Discount (fraction) applied to each patient when `patients` ride together. */
export function sharedDiscount(grid: FareGrid, patients: number): number {
  if (patients <= 1) return 0;
  return patients === 2 ? grid.sharedDiscount2 : grid.sharedDiscount3;
}

/** Fare billed for one patient of a trip shared by `patients` patients. */
export function patientFare(grid: FareGrid, km: number, patients = 1): number {
  return soloFare(grid, km) * (1 - sharedDiscount(grid, patients));
}

/**
 * Revenue of the vehicle when `patients` patients each travel `km` km together,
 * compared with a solo trip (what sharing brings in, before the saved km).
 */
export function sharedComparison(grid: FareGrid, km: number, patients: number) {
  const solo = soloFare(grid, km);
  const perPatient = patientFare(grid, km, patients);
  const vehicleTotal = perPatient * patients;
  return { solo, perPatient, vehicleTotal, gainVsSolo: solo > 0 ? vehicleTotal / solo - 1 : 0 };
}
