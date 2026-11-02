/** Tariff grid selection. Amounts live in the database, never in code. */
import type { TariffGrid } from "@prisma/client";
import { toIsoDate } from "@/lib/time";

/**
 * What grid selection reads: full rows, or the subset the optimizer request is
 * built from. createdAt and id only break same-day ties (see supersedes): a
 * caller that selects a subset of columns must keep them, or two grids
 * starting the same day fall back to input order.
 */
type DatedGrid = Pick<TariffGrid, "vehicleType" | "department" | "validFrom" | "validTo"> &
  Partial<Pick<TariffGrid, "createdAt" | "id">>;

/**
 * Does `grid` supersede `current`? The later start wins; on the same start day
 * (e.g. a grid duplicated the same day to fix a typo) the one created last
 * wins, then the greater id, so with createdAt and id supplied the result never
 * depends on the input order. A grid without them counts as created at the
 * epoch with an empty id: between two such grids the first one in input order
 * is kept.
 */
function supersedes(grid: DatedGrid, current: DatedGrid): boolean {
  const byStart = grid.validFrom.getTime() - current.validFrom.getTime();
  if (byStart !== 0) return byStart > 0;
  const byCreation = (grid.createdAt?.getTime() ?? 0) - (current.createdAt?.getTime() ?? 0);
  if (byCreation !== 0) return byCreation > 0;
  return (grid.id ?? "") > (current.id ?? "");
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
