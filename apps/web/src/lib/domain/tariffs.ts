/** Tariff grid selection. Amounts live in the database, never in code. */
import type { TariffGrid, VehicleType } from "@prisma/client";
import { addDays, toIsoDate } from "@/lib/time";

/**
 * What grid selection reads: full rows, or the subset the optimizer request is
 * built from. createdAt and id only break same-day ties (see supersedes); they
 * are required so a caller selecting a subset of columns cannot leave them out.
 */
type DatedGrid = Pick<TariffGrid, "vehicleType" | "department" | "validFrom" | "validTo" | "createdAt" | "id">;

/**
 * Does `grid` supersede `current`? The later start wins; on the same start day
 * (e.g. a grid duplicated the same day to fix a typo) the one created last
 * wins, then the greater id, so the result never depends on the input order.
 */
function supersedes(grid: DatedGrid, current: DatedGrid): boolean {
  const byStart = grid.validFrom.getTime() - current.validFrom.getTime();
  if (byStart !== 0) return byStart > 0;
  const byCreation = grid.createdAt.getTime() - current.createdAt.getTime();
  if (byCreation !== 0) return byCreation > 0;
  return grid.id > current.id;
}

/**
 * Grids in force on isoDate, one per (vehicleType, department): when several
 * overlap, the one that started most recently wins (ties: last created).
 */
export function tariffsInForce<T extends DatedGrid>(grids: T[], isoDate: string): T[] {
  const best = new Map<string, T>();
  for (const grid of grids) {
    const from = toIsoDate(grid.validFrom);
    const to = grid.validTo ? toIsoDate(grid.validTo) : null;
    if (from > isoDate || (to !== null && to < isoDate)) continue;
    const key = `${grid.vehicleType}/${grid.department}`;
    const current = best.get(key);
    if (!current || supersedes(grid, current)) best.set(key, grid);
  }
  return [...best.values()];
}

/** Grid for a vehicle: exact department first, then the "*" catch-all. */
export function tariffFor<T extends Pick<TariffGrid, "vehicleType" | "department">>(
  grids: T[],
  vehicleType: TariffGrid["vehicleType"],
  department: string,
): T | undefined {
  return (
    grids.find((g) => g.vehicleType === vehicleType && g.department === department) ??
    grids.find((g) => g.vehicleType === vehicleType && g.department === "*")
  );
}

/** A vehicle as tariff coverage reads it. */
export type TariffedVehicle = { label: string; type: VehicleType; department: string };

/** Vehicles of one (type, department) that no grid covers. */
export type TariffGap = { vehicleType: VehicleType; department: string; vehicles: string[] };

/** Vehicles grouped by (type, department), in the given order. */
function byTariffZone(vehicles: readonly TariffedVehicle[]): TariffGap[] {
  const groups = new Map<string, TariffGap>();
  for (const vehicle of vehicles) {
    const key = `${vehicle.type}/${vehicle.department}`;
    const group = groups.get(key) ?? { vehicleType: vehicle.type, department: vehicle.department, vehicles: [] };
    group.vehicles.push(vehicle.label);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * Vehicles that no grid of `inForce` covers (exact department or the "*"
 * catch-all, as tariffFor): the optimizer estimates their revenue at 0 €.
 * Grouped by (type, department), vehicles in the given order.
 */
export function tariffGaps<G extends Pick<TariffGrid, "vehicleType" | "department">>(
  vehicles: readonly TariffedVehicle[],
  inForce: G[],
): TariffGap[] {
  return byTariffZone(vehicles.filter((vehicle) => !tariffFor(inForce, vehicle.type, vehicle.department)));
}

/**
 * A (type, department) of vehicles left without grid on a day of the window:
 * - "missing": no grid on the first day of the window;
 * - "expires": covered at first, until `expiring` ends (its validTo), with no
 *   grid taking over the next day.
 * `resumesOn` is the first later day of the window covered again, if any.
 */
export type TariffCoverageAlert = TariffGap & {
  kind: "missing" | "expires";
  /** First day without grid. */
  uncoveredFrom: string;
  /** "expires": the grid in force the day before. */
  expiring: (Pick<TariffGrid, "id" | "department" | "label"> & { validTo: string }) | null;
  resumesOn: string | null;
};

/**
 * Coverage of every (type, department) of `vehicles` from `fromIso` to
 * `fromIso + days` included: one alert per pair left without grid on a day of
 * the window (the planner works on tomorrow and the days after, a grid ending
 * today leaves tomorrow at 0 €). Days are checked with tariffsInForce and
 * tariffFor, as the optimizer request does.
 */
export function tariffCoverageAlerts<G extends DatedGrid & Pick<TariffGrid, "label">>(
  vehicles: readonly TariffedVehicle[],
  grids: G[],
  fromIso: string,
  days: number,
): TariffCoverageAlert[] {
  const window = Array.from({ length: days + 1 }, (_, i) => addDays(fromIso, i));
  const inForceByDay = window.map((day) => tariffsInForce(grids, day));
  const alerts: TariffCoverageAlert[] = [];
  for (const gap of byTariffZone(vehicles)) {
    const covering = inForceByDay.map((inForce) => tariffFor(inForce, gap.vehicleType, gap.department) ?? null);
    const firstGap = covering.findIndex((grid) => grid === null);
    if (firstGap < 0) continue;
    const resumes = covering.findIndex((grid, i) => i > firstGap && grid !== null);
    const before = firstGap > 0 ? covering[firstGap - 1] : null;
    alerts.push({
      ...gap,
      kind: before ? "expires" : "missing",
      uncoveredFrom: window[firstGap]!,
      expiring:
        before && before.validTo
          ? { id: before.id, department: before.department, label: before.label, validTo: toIsoDate(before.validTo) }
          : null,
      resumesOn: resumes < 0 ? null : window[resumes]!,
    });
  }
  return alerts;
}
