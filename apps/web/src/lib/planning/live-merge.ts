/**
 * The planning page of today kept live (DAY-01): the rows and trips the page was rendered with, updated by the latest
 * poll (live-load.ts): each stop's status time, each trip's status and end of session, the returns to check. What
 * did not change keeps its object, so the timeline's memoized rows draw again only where a status came in. Then the
 * inputs of the projection (live-day.ts) from them.
 *
 * Pure: unit-tested, used by the planning board.
 */
import type { LiveRouteInput, LiveTripInput } from "./live-day";
import type { LiveSnapshot } from "./live-load";
import type { StopView, TripView, VehicleRowView } from "./types";

export type LiveFieldData = Pick<LiveSnapshot, "done" | "trips" | "returnsToCheck">;

/** `vehicles` with each stop's completion from `live` (a stop not listed has no status). */
export function liveVehicles(vehicles: readonly VehicleRowView[], live: LiveFieldData): VehicleRowView[] {
  return vehicles.map((row) => {
    const route = row.route;
    if (!route) return row;
    let changed = false;
    const stops = route.stops.map((stop): StopView => {
      const minute = live.done[stop.id] ?? null;
      if ((stop.completedMinute ?? null) === minute && stop.completed === (minute !== null)) return stop;
      changed = true;
      return { ...stop, completed: minute !== null, completedMinute: minute };
    });
    return changed ? { ...row, route: { ...route, stops } } : row;
  });
}

/** `trips` with their status and end of session from `live`, and whether the return is to check after an absence. */
export function liveTrips(trips: readonly TripView[], live: LiveFieldData): TripView[] {
  const toCheck = new Set(live.returnsToCheck);
  return trips.map((trip) => {
    const now = live.trips[trip.id];
    const status = now?.status ?? trip.status;
    const readyMinute = now ? now.readyMinute : trip.readyMinute;
    const outboundNoShow = toCheck.has(trip.id);
    if (status === trip.status && readyMinute === trip.readyMinute && outboundNoShow === trip.outboundNoShow) return trip;
    return { ...trip, status, readyMinute, outboundNoShow };
  });
}

/** The projection's routes: every row with a route, its stops as recorded now. */
export function projectionRoutes(vehicles: readonly VehicleRowView[]): LiveRouteInput[] {
  return vehicles.flatMap((row) =>
    row.route
      ? [
          {
            vehicleId: row.id,
            startMinute: row.route.startMinute,
            endMinute: row.route.endMinute,
            stops: row.route.stops.map((stop) => ({
              id: stop.id,
              tripId: stop.tripId,
              kind: stop.kind,
              sequence: stop.sequence,
              arrivalMinute: stop.arrivalMinute,
              startMinute: stop.startMinute,
              departureMinute: stop.departureMinute,
              completedMinute: stop.completedMinute ?? null,
            })),
          },
        ]
      : [],
  );
}

export function projectionTrips(trips: readonly TripView[]): LiveTripInput[] {
  return trips.map((trip) => ({
    id: trip.id,
    direction: trip.direction,
    status: trip.status,
    appointmentMinute: trip.appointmentMinute,
    readyMinute: trip.readyMinute,
    vehicleId: trip.vehicleId,
    otherLegTripId: trip.otherLegTripId ?? null,
  }));
}
