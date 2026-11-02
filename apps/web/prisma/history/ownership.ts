/**
 * Which rows of a date the history script owns (pure Prisma filters,
 * unit-tested). Trips and optimization runs it creates carry the "hist-" id
 * prefix; its routes are those of its runs. A re-run deletes only its own
 * rows, and leaves alone any date holding a row it did not create.
 */
import type { Prisma } from "@prisma/client";
import { HISTORY_ID_PREFIX } from "./ids";

const ownId = { startsWith: HISTORY_ID_PREFIX };

export type OwnershipFilters = {
  trips: Prisma.TripWhereInput;
  routes: Prisma.RouteWhereInput;
  runs: Prisma.OptimizationRunWhereInput;
};

/** Rows of `serviceDate` created by the simulation (what a re-run deletes). */
export function simulatedRowsWhere(serviceDate: Date): OwnershipFilters {
  return {
    trips: { serviceDate, id: ownId },
    routes: { serviceDate, optimizationRunId: ownId },
    runs: { serviceDate, id: ownId },
  };
}

/**
 * Rows of `serviceDate` the simulation did not create. A route without run
 * (built by hand) is foreign too: in SQL, NOT (NULL LIKE 'hist-%') is not
 * true, hence the explicit null case.
 */
export function foreignRowsWhere(serviceDate: Date): OwnershipFilters {
  return {
    trips: { serviceDate, NOT: { id: ownId } },
    routes: { serviceDate, OR: [{ optimizationRunId: null }, { NOT: { optimizationRunId: ownId } }] },
    runs: { serviceDate, NOT: { id: ownId } },
  };
}
