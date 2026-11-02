import "server-only";
import type { Prisma } from "@prisma/client";
import { planDetach } from "@/app/(regulator)/courses/route-detach";
import { fromIsoDate, toIsoDate } from "@/lib/time";
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
 * Takes the trip's stops out of the route(s) serving it. The remaining stops
 * keep their order and times but get their load recomputed; former
 * co-passengers left alone are no longer shared and lose their shared revenue
 * and detour. Same rules as cancelling a trip in « Courses ».
 */
async function removeTripStops(tx: Prisma.TransactionClient, tripId: string): Promise<void> {
  const own = await tx.routeStop.findMany({ where: { tripId }, select: { routeId: true } });
  if (own.length === 0) return;
  const stops = await tx.routeStop.findMany({
    where: { routeId: { in: [...new Set(own.map((stop) => stop.routeId))] } },
    select: { id: true, routeId: true, tripId: true, kind: true, sequence: true, loadAfter: true },
  });
  const plan = planDetach(stops, tripId);

  await tx.routeStop.deleteMany({ where: { tripId } });
  for (const { id, loadAfter } of plan.loadUpdates) {
    await tx.routeStop.update({ where: { id }, data: { loadAfter } });
  }
  if (plan.nowAlone.length > 0) {
    await tx.trip.updateMany({
      where: { id: { in: plan.nowAlone } },
      data: { shared: false, detourKm: null, estimatedRevenue: null },
    });
  }
  if (plan.stillShared.length > 0) {
    await tx.trip.updateMany({ where: { id: { in: plan.stillShared } }, data: { detourKm: null, estimatedRevenue: null } });
  }
}

/** Applies `targetFor` to each trip and returns what was done. */
export async function syncTrips(
  tx: Prisma.TransactionClient,
  trips: SyncTrip[],
  targetFor: (trip: SyncTrip) => TripTarget,
  todayIso: string,
): Promise<SyncSummary> {
  const summary: SyncSummary = { ...EMPTY_SYNC };
  for (const trip of trips) {
    const decision = planTripChange(trip, targetFor(trip), todayIso);
    if (decision.type === "deferred") summary.deferred += 1;
    if (decision.type !== "change") continue;
    const { change } = decision;

    // Guarded on what was read: a trip started, cancelled or re-planned meanwhile is left alone.
    const { count } = await tx.trip.updateMany({
      where: { id: change.tripId, status: change.expectedStatus, routeId: trip.routeId },
      data: change.data,
    });
    if (count === 0) continue;
    if (change.detach) {
      await removeTripStops(tx, change.tripId);
      summary.detached += 1;
    }
    if (change.cancel) summary.cancelled += 1;
    else summary.updated += 1;
  }
  return summary;
}

/** Shorthand: loads the open trips matching `where` and syncs them. */
export async function syncOpenTrips(
  tx: Prisma.TransactionClient,
  where: Prisma.TripWhereInput,
  targetFor: (trip: SyncTrip) => TripTarget,
  todayIso: string,
): Promise<SyncSummary> {
  return syncTrips(tx, await loadOpenTrips(tx, where, todayIso), targetFor, todayIso);
}
