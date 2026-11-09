/**
 * Which rows of a date the history script owns (pure Prisma filters,
 * unit-tested). Trips, optimization runs and audit events it creates carry
 * the "hist-" id prefix; its routes are those of its runs. A re-run deletes
 * only its own rows, and leaves alone any date holding a trip, route or run
 * it did not create, or a change recorded by the app (an audit event of the
 * date that is not the simulation's, such as a sharing answer corrected in
 * « Courses »): regenerating the date would contradict that trace. Reads
 * ("*.view", written when a page is viewed) never make a date foreign. The
 * app's events are never deleted.
 */
import type { Prisma } from "@prisma/client";
import { toIsoDate } from "@/lib/time";
import { HISTORY_ID_PREFIX, historyDatePrefix } from "./ids";

const ownId = { startsWith: HISTORY_ID_PREFIX };

/** Suffix of the audit actions that record a read (patient.view, roadmap.view…), not a change. */
export const READ_ACTION_SUFFIX = ".view";

/** One service date, or a range of them (to find the foreign dates of a period in one query per model). */
export type ServiceDateFilter = Date | { gte: Date; lte: Date };

export type OwnershipFilters = {
  trips: Prisma.TripWhereInput;
  routes: Prisma.RouteWhereInput;
  runs: Prisma.OptimizationRunWhereInput;
};

/**
 * Rows of `serviceDate` created by the simulation (what a re-run deletes; stops go with routes and trips):
 * also the one-off prescriptions of its trips, and the absences and vehicles off the road that start on
 * the date, found by the date in their id (they have no service date).
 */
export function simulatedRowsWhere(serviceDate: Date): OwnershipFilters & {
  events: Prisma.AuditEventWhereInput;
  prescriptions: Prisma.PrescriptionWhereInput;
  absences: Prisma.StaffAbsenceWhereInput;
  unavailabilities: Prisma.VehicleUnavailabilityWhereInput;
} {
  const ofDate = { startsWith: historyDatePrefix(toIsoDate(serviceDate)) };
  return {
    trips: { serviceDate, id: ownId },
    routes: { serviceDate, optimizationRunId: ownId },
    runs: { serviceDate, id: ownId },
    events: { serviceDate, id: ownId },
    prescriptions: { id: ofDate },
    absences: { id: ofDate },
    unavailabilities: { id: ofDate },
  };
}

/**
 * Rows of `serviceDate` the simulation did not create, and the app's change
 * events of that date. A route without run (built by hand) is foreign too:
 * in SQL, NOT (NULL LIKE 'hist-%') is not true, hence the explicit null case.
 * An event without service date (a login, an account change) is about no day.
 */
export function foreignRowsWhere(serviceDate: ServiceDateFilter): OwnershipFilters & { events: Prisma.AuditEventWhereInput } {
  return {
    trips: { serviceDate, NOT: { id: ownId } },
    routes: { serviceDate, OR: [{ optimizationRunId: null }, { NOT: { optimizationRunId: ownId } }] },
    runs: { serviceDate, NOT: { id: ownId } },
    // NOT [a, b]: neither a nor b (both columns are required, so no NULL case).
    events: { serviceDate, NOT: [{ id: ownId }, { action: { endsWith: READ_ACTION_SUFFIX } }] },
  };
}
