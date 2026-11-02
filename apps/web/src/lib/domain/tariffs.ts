/** Tariff grid selection. Amounts live in the database, never in code. */
import type { TariffGrid } from "@prisma/client";
import { toIsoDate } from "@/lib/time";

/**
 * Grids in force on isoDate, one per (vehicleType, department): when several
 * overlap, the one that started most recently wins.
 */
export function tariffsInForce(grids: TariffGrid[], isoDate: string): TariffGrid[] {
  const best = new Map<string, TariffGrid>();
  for (const grid of grids) {
    const from = toIsoDate(grid.validFrom);
    const to = grid.validTo ? toIsoDate(grid.validTo) : null;
    if (from > isoDate || (to !== null && to < isoDate)) continue;
    const key = `${grid.vehicleType}/${grid.department}`;
    const current = best.get(key);
    if (!current || current.validFrom < grid.validFrom) best.set(key, grid);
  }
  return [...best.values()];
}

/** Grid for a vehicle: exact department first, then the "*" catch-all. */
export function tariffFor(
  grids: TariffGrid[],
  vehicleType: TariffGrid["vehicleType"],
  department: string,
): TariffGrid | undefined {
  return (
    grids.find((g) => g.vehicleType === vehicleType && g.department === department) ??
    grids.find((g) => g.vehicleType === vehicleType && g.department === "*")
  );
}
