/**
 * The fleet by energy and by depot over a period (KPI-10, prepares lot 5:
 * diesel or electric). Pure.
 *
 * For each vehicle, from its fill-ups (lib/fleet/consumption.ts): the last
 * full tank before the period and the fills of the period bound a measured
 * interval; over it, the fuel (L) or the energy (kWh) per 100 km, the energy
 * cost per km measured against the cost per km the optimizer uses (which also
 * covers servicing and wear), and the km of the odometer against the km
 * planned on its routes between the two readings (the routes of the days
 * after the first reading through the day of the last one: a fill is recorded
 * at the end of the day), up to the last reading on or before the last day
 * that has routes at all (the days after it are not planned yet); not
 * compared when the interval starts before the first planned day. Then its
 * days off the road in the period (unavailabilities) and its deadlines
 * overdue today, at its latest odometer reading (whatever the period, like
 * the vehicle's record). A group sums its
 * vehicles: litres and kWh never mix, the consumption of a group is given per
 * unit.
 */
import type { EnergyType, MaintenanceKind, VehicleType } from "@prisma/client";
import { consumptionStats, energyUnit, type FuelEntry } from "@/lib/fleet/consumption";
import { deadlineState } from "@/lib/fleet/maintenance";
import { ratio } from "./kpis-rows";

export type EnergyVehicle = {
  id: string;
  label: string;
  type: VehicleType;
  depotId: string;
  energy: EnergyType | null;
  costPerKm: number;
};

export type EnergyDeadline = { vehicleId: string; kind: MaintenanceKind; label: string | null; dueDate: string | null; dueKm: number | null; doneDate: string | null };

export type VehicleEnergy = {
  vehicleId: string;
  energy: EnergyType | null;
  unit: "L" | "kWh";
  /** Km of the odometer over the measured interval (0: not measurable). */
  measuredKm: number;
  quantity: number;
  energyCost: number;
  /**
   * Km of the odometer and km planned on its routes from the start of the
   * measured interval to the last reading of a planned day; null when they
   * cannot be compared (no such reading, or the interval starts before the first planned day).
   */
  comparedKm: number | null;
  plannedKm: number | null;
  /** Configured cost per km × measured km (the optimizer's cost of those km). */
  configuredCost: number;
  offRoadDays: number;
  overdueDeadlines: number;
};

/**
 * The energy figures of each vehicle. `fills`: its fill-ups up to `to` (the
 * older ones are ignored but the last full tank before `from`); `plannedKm`:
 * km of its route by date; `offRoad`: its unavailable dates in the period.
 */
export function vehicleEnergy(
  vehicle: EnergyVehicle,
  input: {
    from: string;
    to: string;
    today: string;
    fills: readonly FuelEntry[];
    plannedKm: ReadonlyMap<string, number>;
    /** First and last dates with routes (any vehicle): the planned km are only known between them. */
    plannedSince: string | null;
    plannedUntil?: string | null;
    offRoadDays: number;
    deadlines: readonly EnergyDeadline[];
    /** Its latest odometer reading, all fills (null: none); absent: the highest of `fills`. */
    latestOdometerKm?: number | null;
  },
): VehicleEnergy {
  const before = input.fills.filter((f) => f.date < input.from && f.fullTank).sort((a, b) => a.date.localeCompare(b.date) || a.odometerKm - b.odometerKm);
  const anchor = before[before.length - 1];
  const window = [...(anchor ? [anchor] : []), ...input.fills.filter((f) => f.date >= input.from && f.date <= input.to)];
  const stats = consumptionStats(window);
  let plannedKm: number | null = null;
  let comparedKm: number | null = null;
  const start = window.find((f) => f.date === stats.fromDate && f.fullTank);
  const until = stats.toDate && input.plannedUntil && input.plannedUntil < stats.toDate ? input.plannedUntil : stats.toDate;
  const end = start && until
    ? window.filter((f) => f.date > start.date && f.date <= until).sort((a, b) => b.odometerKm - a.odometerKm)[0]
    : undefined;
  if (start && end && input.plannedSince !== null && start.date >= input.plannedSince) {
    plannedKm = 0;
    for (const [date, km] of input.plannedKm) if (date > start.date && date <= end.date) plannedKm += km;
    comparedKm = end.odometerKm - start.odometerKm;
  }
  const lastOdometer = input.latestOdometerKm !== undefined ? input.latestOdometerKm : consumptionStats(input.fills).odometerKm;
  return {
    vehicleId: vehicle.id,
    energy: vehicle.energy,
    unit: energyUnit(vehicle.energy),
    measuredKm: stats.measuredKm,
    quantity: stats.measuredQuantity,
    energyCost: stats.measuredCost,
    comparedKm,
    plannedKm,
    configuredCost: vehicle.costPerKm * stats.measuredKm,
    offRoadDays: input.offRoadDays,
    overdueDeadlines: input.deadlines.filter((d) => deadlineState(d, input.today, lastOdometer).status === "overdue").length,
  };
}

export type EnergyGroup = {
  vehicles: number;
  /** Vehicles with a measured interval. */
  measuredVehicles: number;
  /** Km, fuel and energy cost by unit (a group of one energy has one unit). */
  byUnit: Record<"L" | "kWh", { km: number; quantity: number }>;
  measuredKm: number;
  energyCost: number;
  configuredCost: number;
  /** Km planned and km of the odometer over the intervals of the vehicles whose planned km are known. */
  plannedKm: number;
  comparedKm: number;
  offRoadDays: number;
  overdueDeadlines: number;
};

export function emptyEnergyGroup(): EnergyGroup {
  return {
    vehicles: 0,
    measuredVehicles: 0,
    byUnit: { L: { km: 0, quantity: 0 }, kWh: { km: 0, quantity: 0 } },
    measuredKm: 0,
    energyCost: 0,
    configuredCost: 0,
    plannedKm: 0,
    comparedKm: 0,
    offRoadDays: 0,
    overdueDeadlines: 0,
  };
}

export function addVehicleEnergy(group: EnergyGroup, v: VehicleEnergy): EnergyGroup {
  const measured = v.measuredKm > 0;
  const unit = group.byUnit[v.unit];
  return {
    vehicles: group.vehicles + 1,
    measuredVehicles: group.measuredVehicles + (measured ? 1 : 0),
    byUnit: { ...group.byUnit, [v.unit]: { km: unit.km + v.measuredKm, quantity: unit.quantity + v.quantity } },
    measuredKm: group.measuredKm + v.measuredKm,
    energyCost: group.energyCost + v.energyCost,
    configuredCost: group.configuredCost + v.configuredCost,
    plannedKm: group.plannedKm + (v.plannedKm ?? 0),
    comparedKm: group.comparedKm + (v.plannedKm !== null ? (v.comparedKm ?? 0) : 0),
    offRoadDays: group.offRoadDays + v.offRoadDays,
    overdueDeadlines: group.overdueDeadlines + v.overdueDeadlines,
  };
}

/** All the vehicles in one group (the fleet's total). */
export function sumEnergy(vehicles: readonly VehicleEnergy[]): EnergyGroup {
  return vehicles.reduce(addVehicleEnergy, emptyEnergyGroup());
}

/** Vehicles grouped by `keyOf`, in the order of the keys first met. */
export function groupEnergy(vehicles: readonly VehicleEnergy[], keyOf: (v: VehicleEnergy) => string): Map<string, EnergyGroup> {
  const result = new Map<string, EnergyGroup>();
  for (const v of vehicles) result.set(keyOf(v), addVehicleEnergy(result.get(keyOf(v)) ?? emptyEnergyGroup(), v));
  return result;
}

export type EnergyRates = {
  /** L or kWh per 100 km of each unit present. */
  per100Km: Partial<Record<"L" | "kWh", number>>;
  /** Energy cost per km measured, and the configured cost per km (weighted by the km). */
  energyCostPerKm: number | null;
  configuredCostPerKm: number | null;
  /** (odometer km - planned km) ÷ planned km: positive, the vehicles drove more than planned. */
  kmGap: number | null;
};

export function energyRates(g: EnergyGroup): EnergyRates {
  const per100Km: EnergyRates["per100Km"] = {};
  for (const unit of ["L", "kWh"] as const) {
    const value = ratio(g.byUnit[unit].quantity * 100, g.byUnit[unit].km);
    if (value !== null) per100Km[unit] = value;
  }
  return {
    per100Km,
    energyCostPerKm: ratio(g.energyCost, g.measuredKm),
    configuredCostPerKm: ratio(g.configuredCost, g.measuredKm),
    kmGap: g.plannedKm > 0 ? (g.comparedKm - g.plannedKm) / g.plannedKm : null,
  };
}
