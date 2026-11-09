import "server-only";
import type { Prisma } from "@prisma/client";
import { audit } from "@/lib/audit";
import { systemCancellation } from "@/lib/domain/cancellation";
import { removeTripStops } from "@/lib/planning/detach";
import { fromIsoDate, toIsoDate } from "@/lib/time";
import { tripCancelEvents, tripDetachEvents, type AuditActor } from "./audit-events";
import { EMPTY_SYNC, OPEN_TRIP_STATUSES, planTripChange, type SyncSummary, type SyncTrip, type TripTarget } from "./trip-sync";

/**
 * Database side of the trip sync (see trip-sync.ts). Every function runs in the
 * caller's transaction, together with the referential change itself.
 */

/** Interactive transactions that touch trips and route stops. */
export const SYNC_TX_OPTIONS = { maxWait: 15_000, timeout: 60_000 } as const;

const syncTripSelect = {
  id: true,
  serviceDate: true,
  direction: true,
  status: true,
  payer: true,
  prescriptionId: true,
  facilityId: true,
  allowedVehicleTypes: true,
  sharingAllowed: true,
  sharingStatus: true,
  shared: true,
  appointmentMinute: true,
  readyMinute: true,
  pickupAddress: true,
  pickupLat: true,
  pickupLng: true,
  dropoffAddress: true,
  dropoffLat: true,
  dropoffLng: true,
  recurrenceId: true,
  routeId: true,
  lockedVehicleId: true,
  route: { select: { vehicle: { select: { type: true } } } },
  lockedVehicle: { select: { type: true } },
  prescription: { select: { validFrom: true, validTo: true } },
} satisfies Prisma.TripSelect;

/** Where clause of the open trips (not started, not cancelled) from today on. */
export function openFutureTripsWhere(where: Prisma.TripWhereInput, todayIso: string): Prisma.TripWhereInput {
  return { AND: [where, { serviceDate: { gte: fromIsoDate(todayIso) }, status: { in: [...OPEN_TRIP_STATUSES] } }] };
}

export async function loadOpenTrips(
  tx: Prisma.TransactionClient,
  where: Prisma.TripWhereInput,
  todayIso: string,
): Promise<SyncTrip[]> {
  const rows = await tx.trip.findMany({
    where: openFutureTripsWhere(where, todayIso),
    select: syncTripSelect,
    orderBy: [{ serviceDate: "asc" }, { id: "asc" }],
  });
  return rows.map(({ serviceDate, route, lockedVehicle, prescription, ...trip }) => ({
    ...trip,
    serviceDate: toIsoDate(serviceDate),
    routeVehicleType: route?.vehicle.type ?? null,
    lockedVehicleType: lockedVehicle?.type ?? null,
    prescriptionValidity: prescription
      ? { validFrom: toIsoDate(prescription.validFrom), validTo: toIsoDate(prescription.validTo) }
      : null,
  }));
}

/**
 * Applies `targetFor` to each trip and returns what was done. A trip leaving
 * its route has its stops removed the same way as cancelling it in « Courses »
 * (lib/planning/detach.ts); the routes it left are added to `leftRoutes`, to be
 * recomputed once the transaction has committed (lib/planning/refresh-routes.ts).
 * Every trip cancelled is traced (one trip.cancel per trip, by `actor`) in the
 * same transaction, and so is every trip taken off its route but kept (trip.detach).
 * A trip cancelled here is marked as cancelled by the application (origin
 * SYSTEM, reason « synchronisation du référentiel », `options.cause` as its
 * note, `actor` as author): it comes back by itself once the cause is gone
 * (lib/domain/trip-generation.ts), unlike a trip a person cancelled.
 */
export async function syncTrips(
  tx: Prisma.TransactionClient,
  trips: SyncTrip[],
  targetFor: (trip: SyncTrip) => TripTarget,
  todayIso: string,
  leftRoutes: Set<string>,
  actor: AuditActor,
  options: SyncOptions = {},
): Promise<SyncSummary> {
  const summary: SyncSummary = { ...EMPTY_SYNC };
  const cancellation = systemCancellation(actor.id, new Date(), options.cause ?? null);
  const cancelled: SyncTrip[] = [];
  const detachedOnly: SyncTrip[] = [];
  for (const trip of trips) {
    const decision = planTripChange(trip, targetFor(trip), todayIso);
    if (decision.type === "deferred") summary.deferred += 1;
    if (decision.type !== "change") continue;
    const { change } = decision;

    // Guarded on what was read: a trip started, cancelled or re-planned meanwhile is left alone.
    const { count } = await tx.trip.updateMany({
      where: { id: change.tripId, status: change.expectedStatus, routeId: trip.routeId },
      data: change.cancel ? { ...change.data, ...cancellation } : change.data,
    });
    if (count === 0) continue;
    if (change.detach) {
      const { routeIds } = await removeTripStops(tx, change.tripId);
      for (const routeId of routeIds) leftRoutes.add(routeId);
      summary.detached += 1;
    }
    if (change.cancel) {
      summary.cancelled += 1;
      cancelled.push(trip);
    } else {
      summary.updated += 1;
      if (change.detach) detachedOnly.push(trip);
    }
  }
  await audit(tx, actor, [...tripCancelEvents(cancelled), ...tripDetachEvents(detachedOnly)]);
  return summary;
}

export type SyncOptions = {
  /** Why trips may be cancelled ("Patient désactivé"…): the note of their cancellation. */
  cause?: string;
};

/** Shorthand: loads the open trips matching `where` and syncs them (see syncTrips for `leftRoutes`, `actor` and `options`). */
export async function syncOpenTrips(
  tx: Prisma.TransactionClient,
  where: Prisma.TripWhereInput,
  targetFor: (trip: SyncTrip) => TripTarget,
  todayIso: string,
  leftRoutes: Set<string>,
  actor: AuditActor,
  options: SyncOptions = {},
): Promise<SyncSummary> {
  return syncTrips(tx, await loadOpenTrips(tx, where, todayIso), targetFor, todayIso, leftRoutes, actor, options);
}
