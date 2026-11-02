import "server-only";
import { db } from "@/lib/db";
import { fromIsoDate, todayIso } from "@/lib/time";
import { isReadableRoadmapDate, returnTripsAfterOutboundNoShow } from "./roadmap";

/**
 * Routes of a service date where the driver is at the wheel or crew mate,
 * with what the roadmap shows. Only the fields the crew needs are read
 * (patient health data stays minimal on the phone).
 *
 * Only today and tomorrow can be read (see roadmapDateWindow): any other date
 * gives no route, whatever the caller asks. `today` is the caller's reading of
 * the server clock, so one request uses a single "today".
 */
export async function loadDriverRoutes(driverId: string, isoDate: string, today: string = todayIso()) {
  if (!isReadableRoadmapDate(isoDate, today)) return [];
  return db.route.findMany({
    where: { serviceDate: fromIsoDate(isoDate), OR: [{ driverId }, { crewMateId: driverId }] },
    orderBy: [{ startMinute: "asc" }, { id: "asc" }],
    select: {
      id: true,
      status: true,
      startMinute: true,
      endMinute: true,
      distanceKm: true,
      breakStartMinute: true,
      breakEndMinute: true,
      driverId: true,
      crewMateId: true,
      vehicle: {
        select: {
          label: true,
          registration: true,
          type: true,
          depotLabel: true,
          depotAddress: true,
          depotLat: true,
          depotLng: true,
        },
      },
      driver: {
        select: { firstName: true, lastName: true, breakMinutes: true, breakWindowStartMinute: true, breakWindowEndMinute: true },
      },
      crewMate: { select: { firstName: true, lastName: true } },
      stops: {
        orderBy: { sequence: "asc" },
        select: {
          id: true,
          sequence: true,
          kind: true,
          tripId: true,
          lat: true,
          lng: true,
          address: true,
          startMinute: true,
          loadAfter: true,
          completedAt: true,
          trip: {
            select: {
              direction: true,
              status: true,
              appointmentMinute: true,
              readyMinute: true,
              notes: true,
              // Server-side only: pair the return leg with its outbound leg (never sent to the client).
              patientId: true,
              recurrenceId: true,
              facilityId: true,
              patient: {
                select: { firstName: true, lastName: true, phone: true, mobility: true, accessNotes: true },
              },
              facility: { select: { name: true, phone: true } },
            },
          },
        },
      },
    },
  });
}

export type DriverRoute = Awaited<ReturnType<typeof loadDriverRoutes>>[number];
export type DriverRouteStop = DriverRoute["stops"][number];

/**
 * Return trips of these routes still to collect whose outbound leg the same
 * day was closed as "patient absent", on this route or another vehicle's.
 * Only a yes/no per return trip comes out: nothing about the other route.
 */
export async function loadReturnTripsAfterOutboundNoShow(routes: readonly DriverRoute[], isoDate: string): Promise<Set<string>> {
  const returnTrips = new Map<string, { id: string; patientId: string; recurrenceId: string | null; facilityId: string | null }>();
  for (const stop of routes.flatMap((route) => route.stops)) {
    const { trip } = stop;
    if (stop.kind !== "PICKUP" || trip.direction !== "RETURN" || stop.completedAt !== null) continue;
    if (trip.status === "NO_SHOW" || trip.status === "CANCELLED") continue;
    returnTrips.set(stop.tripId, {
      id: stop.tripId,
      patientId: trip.patientId,
      recurrenceId: trip.recurrenceId,
      facilityId: trip.facilityId,
    });
  }
  if (returnTrips.size === 0) return new Set();

  const outboundNoShows = await db.trip.findMany({
    where: {
      serviceDate: fromIsoDate(isoDate),
      direction: "OUTBOUND",
      status: "NO_SHOW",
      patientId: { in: [...new Set([...returnTrips.values()].map((trip) => trip.patientId))] },
    },
    select: { patientId: true, recurrenceId: true, facilityId: true },
  });
  return returnTripsAfterOutboundNoShow([...returnTrips.values()], outboundNoShows);
}
