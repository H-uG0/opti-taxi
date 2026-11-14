/**
 * Use of the fleet (KPI-03): « courses / véhicule » counts only the vehicles
 * used, so leaving vehicles at the depot improves it. Per day: vehicles
 * active, available (active, minus those unavailable and those without a
 * crew) and used, two ratios (trips per vehicle used and per vehicle
 * available), the use rate and the vehicle-days lost. Pure.
 *
 * Sources: the crews of the day as lib/staff/day-crews.ts resolves them (the
 * crew the regulator fixed, else the default crew and its replacements), with
 * today's staff records: the history of a deactivated vehicle or person is not
 * kept. A vehicle that has a route that day was active and available,
 * whatever the resolution says now (an unavailability recorded afterwards).
 */
import type { DayCrewView } from "@/lib/staff/day-crews";
import { ratio, type KpiFleetDay } from "./kpis-rows";

export type FleetTotals = {
  /** Active vehicles (vehicle-days over a period). */
  active: number;
  /** Unavailable that day (maintenance, repair, on-call duty…). */
  unavailable: number;
  /** Active, available, but without a crew: nobody free, a blocking crew problem, or left at the depot. */
  crewless: number;
  /** Active, neither unavailable nor without a crew. */
  available: number;
  /** With a route that still has stops. */
  used: number;
};

export function addFleet(a: FleetTotals | null, b: FleetTotals | null): FleetTotals | null {
  if (!a) return b;
  if (!b) return a;
  return {
    active: a.active + b.active,
    unavailable: a.unavailable + b.unavailable,
    crewless: a.crewless + b.crewless,
    available: a.available + b.available,
    used: a.used + b.used,
  };
}

/** Vehicle-days lost: unavailable or without a crew. */
export function lostVehicleDays(f: FleetTotals): number {
  return f.unavailable + f.crewless;
}

/** Used ÷ available. */
export function fleetUseRate(f: FleetTotals | null): number | null {
  return f ? ratio(f.used, f.available) : null;
}

/**
 * Fleet of a date from its crews: a vehicle the crews mark unavailable is
 * unavailable; one with no driver or a blocking problem has no crew (a
 * vehicle the regulator left at the depot included). Ids, in crew order.
 */
export function fleetDayFromCrews(
  serviceDate: string,
  crews: readonly Pick<DayCrewView, "vehicleId" | "driverId" | "blocked" | "unavailable">[],
): KpiFleetDay {
  const day: KpiFleetDay = { serviceDate, active: [], unavailable: [], crewless: [] };
  for (const crew of crews) {
    day.active.push(crew.vehicleId);
    if (crew.unavailable) day.unavailable.push(crew.vehicleId);
    else if (crew.driverId === null || crew.blocked !== null) day.crewless.push(crew.vehicleId);
  }
  return day;
}

/**
 * Counts of a day: `usedVehicleIds` (vehicles with a route that has stops)
 * are active and available whatever `day` says. Null when the fleet of the
 * day is unknown.
 */
export function fleetOfDay(day: KpiFleetDay | undefined, usedVehicleIds: ReadonlySet<string>): FleetTotals | null {
  if (!day) return null;
  const active = new Set([...day.active, ...usedVehicleIds]);
  const unavailable = new Set(day.unavailable.filter((id) => !usedVehicleIds.has(id)));
  const crewless = new Set(day.crewless.filter((id) => !usedVehicleIds.has(id) && !unavailable.has(id)));
  return {
    active: active.size,
    unavailable: unavailable.size,
    crewless: crewless.size,
    available: active.size - unavailable.size - crewless.size,
    used: usedVehicleIds.size,
  };
}
