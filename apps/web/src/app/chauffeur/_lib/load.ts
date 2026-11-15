import "server-only";
import { cache } from "react";
import { requireDriverAccount } from "@/lib/auth";
import { db } from "@/lib/db";
import { getRegulatorPhone } from "@/lib/domain/settings";
import { fromIsoDate, todayIso } from "@/lib/time";
import type { FieldRequestView } from "@/lib/domain/field-requests";
import { isSameEpisode } from "@/lib/domain/no-show";
import { fieldRequestView } from "@/lib/planning/live-load";
import { regulatorContact, type RegulatorContact } from "./links";
import { isReadableRoadmapDate, returnTripsAfterOutboundNoShow, townOf, type NextDaySummary } from "./roadmap";
import { NO_FIELD_CONTEXT, type FieldContext } from "./view";

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
      // The roadmap's published versions are kept per vehicle and date (DAY-04).
      vehicleId: true,
      // The day of the route: the reception hours of each facility are those of its weekday.
      serviceDate: true,
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
          // Notes: access to the depot (gate, keys, parking), shown at the departure and the return.
          depot: { select: { name: true, address: true, lat: true, lng: true, notes: true } },
        },
      },
      // Phones: the crew calls each other (one goes up for the patient, the other stays with the vehicle).
      driver: {
        select: {
          firstName: true,
          lastName: true,
          phone: true,
          breakMinutes: true,
          breakWindowStartMinute: true,
          breakWindowEndMinute: true,
        },
      },
      crewMate: { select: { firstName: true, lastName: true, phone: true } },
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
          // Planned arrival (before any wait), start and departure: the live early / late reading of the
          // next stop, measured from the planned moment of the latest status (see plannedTapMinute).
          arrivalMinute: true,
          startMinute: true,
          departureMinute: true,
          loadAfter: true,
          completedAt: true,
          // Server-side only: which crew member recorded the status (never sent to the client).
          completedBy: { select: { driverId: true } },
          trip: {
            select: {
              direction: true,
              status: true,
              appointmentMinute: true,
              readyMinute: true,
              // The regulator's note: a recurrence's instructions, copied, or typed on the trip.
              notes: true,
              // A one-off address on the home side (patient staying elsewhere): the home access notes do not apply.
              oneOffAddress: true,
              // A private client pays on board (no CPAM billing).
              payer: true,
              // A transport interrupted (DAY-03): the patient left on board is picked up again by a continuation,
              // whose time the crew is told once placed; a continuation's pickup is where the vehicle stopped.
              cancellationReason: true,
              continuesTripId: true,
              continuation: { select: { status: true, routeId: true, plannedPickupMinute: true } },
              // Server-side only: pair the return leg with its outbound leg (never sent to the client).
              patientId: true,
              recurrenceId: true,
              facilityId: true,
              patient: {
                select: { firstName: true, lastName: true, phone: true, mobility: true, accessNotes: true },
              },
              // Notes: entrance, parking, floor of the care place, shown on its stops, with its reception hours.
              facility: { select: { name: true, phone: true, notes: true, openingHours: true, earliestArrivalMinute: true } },
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

/**
 * What the crew's signals and requests need (DAY-05): the return the same day of each outbound dropped off on these
 * routes (on any vehicle: only its id, status and end of session come out; a cancelled one when there is no other, so
 * that the answer to « Annuler le retour » still shows), and the crews' requests about these trips and returns. A
 * signal replaced by a newer one (an end of session or a next session typed again) is left out.
 */
export async function loadFieldContext(routes: readonly DriverRoute[], isoDate: string): Promise<FieldContext> {
  const stops = routes.flatMap((route) => route.stops);
  if (stops.length === 0) return NO_FIELD_CONTEXT;
  const serviceDate = fromIsoDate(isoDate);
  const outbound = stops.filter((stop) => stop.kind === "DROPOFF" && stop.trip.direction === "OUTBOUND");
  const patientIds = [...new Set(outbound.map((stop) => stop.trip.patientId))];
  const candidates =
    patientIds.length > 0
      ? await db.trip.findMany({
          where: { serviceDate, direction: "RETURN", patientId: { in: patientIds } },
          orderBy: { createdAt: "asc" },
          select: { id: true, status: true, readyMinute: true, patientId: true, recurrenceId: true, facilityId: true },
        })
      : [];
  const returns = new Map<string, { id: string; status: (typeof candidates)[number]["status"]; readyMinute: number | null }>();
  for (const stop of outbound) {
    const legs = candidates.filter((trip) => isSameEpisode(stop.trip, trip));
    const back = legs.find((trip) => trip.status !== "CANCELLED") ?? legs.at(-1);
    if (back) returns.set(stop.tripId, { id: back.id, status: back.status, readyMinute: back.readyMinute });
  }
  const tripIds = [...new Set([...stops.map((stop) => stop.tripId), ...[...returns.values()].map((back) => back.id)])];
  const rows = await db.fieldRequest.findMany({
    where: { serviceDate, tripId: { in: tripIds } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      kind: true,
      status: true,
      tripId: true,
      readyMinute: true,
      previousReadyMinute: true,
      cancellationReason: true,
      nextSessionDate: true,
      createdAt: true,
      createdBy: { select: { name: true } },
      resolvedById: true,
    },
  });
  const requests = new Map<string, FieldRequestView[]>();
  for (const row of rows) {
    // Closed without a regulator: replaced by a newer signal of the crew (requests route), never « pris en compte ».
    if (row.status === "NOTED" && row.resolvedById === null) continue;
    requests.set(row.tripId, [...(requests.get(row.tripId) ?? []), fieldRequestView(row)]);
  }
  return { returns, requests };
}

/**
 * Tomorrow at a glance on today's roadmap (DAY-04): when the crew starts (departure from the depot), with which
 * vehicle, and its first stop's time and town. No name, no address: the evening before, the « Demain » tab gives the rest.
 */
export async function loadNextDaySummary(driverId: string, tomorrow: string): Promise<NextDaySummary[]> {
  const routes = await db.route.findMany({
    where: { serviceDate: fromIsoDate(tomorrow), OR: [{ driverId }, { crewMateId: driverId }] },
    orderBy: [{ startMinute: "asc" }, { id: "asc" }],
    select: {
      id: true,
      status: true,
      startMinute: true,
      vehicle: { select: { label: true, depot: { select: { name: true } } } },
      stops: { orderBy: { sequence: "asc" }, take: 1, select: { startMinute: true, kind: true, address: true } },
    },
  });
  return routes.map((route) => {
    const first = route.stops[0];
    return {
      id: route.id,
      status: route.status,
      startMinute: route.startMinute,
      vehicleLabel: route.vehicle.label,
      depotName: route.vehicle.depot.name,
      firstStop: first ? { minute: first.startMinute, kind: first.kind, town: townOf(first.address) } : null,
    };
  });
}

/**
 * Regulation phone number set in Paramètres, or null. Cached per request:
 * the layout header and the page share one lookup. Also shown to a driver
 * who still has to change a provisional password (layout of that page).
 */
export const loadRegulatorContact = cache(async (): Promise<RegulatorContact | null> => {
  await requireDriverAccount();
  return regulatorContact(await getRegulatorPhone(db));
});
