/**
 * Costs of the fictitious company (pure, unit-tested): loaded hourly cost of
 * each role and variable cost per km of each kind of vehicle. They feed
 * Driver.hourlyCost and Vehicle.costPerKm, hence the margin the optimizer
 * maximizes: revenue - (km x cost per km + hours of the route x hourly cost
 * of its crew). Fixed costs (insurance, financing, premises, regulation) are
 * not in it: the margin is a contribution margin, before overheads.
 *
 * Every figure is an assumption written down with its reasoning, to be
 * replaced by V's own (payslips, fleet accounts) in Chauffeurs and Véhicules.
 * Checked on 9 November 2026 (see docs/journal-ameliorations.md, batch
 * « Données de démonstration à l'échelle de V »).
 */
import type { EnergyType, Qualification, VehicleType } from "@prisma/client";

// ---------------------------------------------------------------------------
// Labour: loaded cost of one hour of work, per role.

export type StaffRole = "TAXI_DRIVER" | "AUXILIARY" | "DEA";

/**
 * Gross hourly pay (€) of each role in 2026:
 * - taxi driver employed by a taxi company: the SMIC, 12.31 €/h since 1 June
 *   2026 (many are paid a share of the takings instead: not modelled);
 * - auxiliaire ambulancier (CCN des transports routiers, IDCC 16, accord du
 *   16 juin 2016, level 1): the conventional minimum is below the SMIC, so
 *   the SMIC is paid: 12.31 €/h;
 * - ambulancier diplômé d'État (level 3): conventional minimum about
 *   12.8 €/h, market pay closer to 13.5 - 14 €/h: 13.8 €/h.
 */
export const GROSS_HOURLY_PAY: Record<StaffRole, number> = { TAXI_DRIVER: 12.31, AUXILIARY: 12.31, DEA: 13.8 };

/**
 * From gross pay to the cost of one hour actually worked:
 * - employer contributions: about 41 % of gross before reduction; the
 *   « réduction générale dégressive unique » (RGDU, 2026) removes almost all
 *   of it at the SMIC and less and less above. What remains (work accident
 *   rate of road transport, supplementary pension, provident fund, the
 *   employer's share of health insurance, training levies): about +12 % at
 *   the SMIC (taxi driver, auxiliary), +20 % at 1.12 SMIC (DE);
 * - paid leave and public holidays: 1 820 paid hours a year for about 1 607
 *   worked, x 1.13;
 * - overtime: crews of VSL and ambulances work 10 to 12 h days paid +25 %
 *   beyond 35 h a week, about x 1.08 on average (x 1.05 for taxi drivers);
 * - meal allowance of the transport convention (about 16 € a day, free of
 *   contributions within the URSSAF limits), spread over a 10 to 11 h day:
 *   +1.5 €/h.
 */
export const LABOUR_LOADING = {
  employerContributions: { TAXI_DRIVER: 0.12, AUXILIARY: 0.12, DEA: 0.2 } as Record<StaffRole, number>,
  paidLeaveFactor: 1.13,
  overtimeFactor: { TAXI_DRIVER: 1.05, AUXILIARY: 1.08, DEA: 1.08 } as Record<StaffRole, number>,
  mealAllowancePerHour: 1.5,
} as const;

/**
 * The optimizer counts the whole span of a route (depot to depot, break
 * included) at the crew's hourly cost: Driver.hourlyCost is therefore the
 * cost of one hour of that span, i.e. the cost of an hour worked times the
 * share of the span that is paid as work.
 * - Ambulance staff (VSL and ambulance crews): the working time is counted
 *   from the daily span weighted at 90 % outside on-call duty (accord-cadre du
 *   4 mai 2000, the « régime d'équivalence » of the Code des transports, art.
 *   D3312-31; the branch agreement of 16 June 2016 counts actual work, also
 *   below the full span): x 0.90.
 * - Taxi drivers: the 30 to 45 min break of an 11 to 12 h day is not paid: x 0.94.
 */
export const PAID_SHARE_OF_SPAN: Record<StaffRole, number> = { TAXI_DRIVER: 0.94, AUXILIARY: 0.9, DEA: 0.9 };

/** Seniority: +0.3 €/h gross per year, up to 5 years (fictitious people get 0 to 5). */
export const SENIORITY_PER_YEAR = 0.3;
export const MAX_SENIORITY_YEARS = 5;

/** Role a person is paid for: the highest qualification held (a DEA who is also auxiliary is paid as DEA). */
export function staffRoleOf(qualifications: readonly Qualification[]): StaffRole {
  if (qualifications.includes("DEA")) return "DEA";
  if (qualifications.includes("AUXILIARY")) return "AUXILIARY";
  return "TAXI_DRIVER";
}

/** Loaded cost of one hour actually worked (€/h, 2 decimals), with `seniorityYears` of seniority. */
export function loadedHourlyCost(role: StaffRole, seniorityYears = 0): number {
  const years = Math.max(0, Math.min(MAX_SENIORITY_YEARS, seniorityYears));
  const gross = GROSS_HOURLY_PAY[role] + years * SENIORITY_PER_YEAR;
  const l = LABOUR_LOADING;
  const loaded = gross * (1 + l.employerContributions[role]) * l.paidLeaveFactor * l.overtimeFactor[role] + l.mealAllowancePerHour;
  return Math.round(loaded * 100) / 100;
}

/** Cost of one hour of a route's span for a person of `role` (Driver.hourlyCost, 2 decimals). */
export function routeHourlyCost(role: StaffRole, seniorityYears = 0): number {
  return Math.round(loadedHourlyCost(role, seniorityYears) * PAID_SHARE_OF_SPAN[role] * 100) / 100;
}

/** Driver.hourlyCost of a person from their qualifications. */
export function hourlyCostFor(qualifications: readonly Qualification[], seniorityYears = 0): number {
  return routeHourlyCost(staffRoleOf(qualifications), seniorityYears);
}

// ---------------------------------------------------------------------------
// Vehicles: variable cost per km.

/**
 * Consumption (litres or kWh per 100 km) and price per unit of the fill-ups
 * the seed records: diesel at 1.72 €/L; an electric taxi charged at the depot
 * (0.26 €/kWh, professional contract including the charging point).
 */
export const FUEL_PROFILE = {
  TAXI: { per100Km: 6.2, price: 1.72 },
  VSL: { per100Km: 7.1, price: 1.72 },
  AMBULANCE: { per100Km: 10.8, price: 1.72 },
  ELECTRIC: { per100Km: 17.5, price: 0.26 },
} as const;

/** Prefix of the ids of the fill-ups the seed records (the history script may rebuild them, prisma/history/fuel.ts). */
export const FUEL_LOG_SEED_PREFIX = "seed-fuel-";

export function fuelProfileOf(type: VehicleType, energy: EnergyType | null): { per100Km: number; price: number } {
  return energy === "ELECTRIC" ? FUEL_PROFILE.ELECTRIC : FUEL_PROFILE[type];
}

/**
 * What one more km costs, besides the fuel of FUEL_PROFILE (€/km):
 * - tyres, servicing and repairs: about 0.06 €/km for a car (taxi, VSL),
 *   0.09 €/km for a van fitted as an ambulance (brakes, heavier tyres, the
 *   sanitary cell), 0.05 €/km for an electric car (no oil change, less brake wear);
 * - the share of depreciation that follows the km: a taxi or a VSL of about
 *   32 000 € resold 6 000 € after 300 000 km = 0.087 €/km; an electric taxi of
 *   42 000 € resold 9 000 € = 0.11 €/km; a fitted ambulance of about 75 000 €
 *   resold 10 000 € after 350 000 km = 0.186 €/km.
 */
const UPKEEP_PER_KM = { car: 0.06, electricCar: 0.05, ambulance: 0.09 } as const;
const DEPRECIATION_PER_KM = { car: 0.087, electricCar: 0.11, ambulance: 0.186 } as const;

/** Variable cost per km (Vehicle.costPerKm, 2 decimals) of a vehicle, plus `ageSurcharge` for an older one. */
export function costPerKmFor(type: VehicleType, energy: EnergyType | null, ageSurcharge = 0): number {
  const fuel = fuelProfileOf(type, energy);
  const kind = type === "AMBULANCE" ? "ambulance" : energy === "ELECTRIC" ? "electricCar" : "car";
  const perKm = (fuel.per100Km / 100) * fuel.price + UPKEEP_PER_KM[kind] + DEPRECIATION_PER_KM[kind];
  return Math.round((perKm + ageSurcharge) * 100) / 100;
}
