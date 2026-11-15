/**
 * Live follow-up of the day under way (DAY-01): what each route has done, how late it runs and what it means for the
 * appointments still to come, read from the statuses the crews tap (completedAt, lot 7) and the clock. No GPS.
 *
 * Timing: the plan's own times, nothing else. Each planned leg (planned arrival at a stop minus planned departure
 * from the stop before) is the optimizer's travel time for it (its matrix, traffic factors and service times, as the
 * route was computed); the delay seen at the latest status is carried along the route through those legs, absorbed
 * by the planned waits (a stop never starts before its planned start, a return pickup never before the patient is
 * ready). The same reading as the driver's « En retard sur le planning » (app/chauffeur/_lib/punctuality.ts:
 * the latest status' real time plus the planned time from its planned moment). /evaluate with the day's progress is
 * not used here: it re-plans an empty vehicle from its last stop at « now » (right for re-planning, pessimistic for an
 * arrival estimate) and costs a full request every poll (measured, journal lot 23).
 *
 * A lateness announced by the crew on a stop still to do (« Retard +20 », FLD-01) is a floor: that stop starts no
 * earlier than its planned start plus the minutes announced, and the delay is carried on from there.
 *
 * Pure: the planning board feeds it the routes and trips as the page and the live poll know them.
 */
import type { StopKind, TripDirection, TripStatus } from "@prisma/client";
import { stopState, type StopState } from "@/lib/domain/stops";
import { isStopDone } from "./stop-done";

/** A stop whose expected status is this late is flagged « dépassé sans statut ». */
export const OVERDUE_MARGIN_MIN = 10;
/** A route that has recorded nothing this long after its first expected status is « silencieuse ». */
export const SILENT_AFTER_MIN = 15;
/** Below this, a projected delay is not shown (same margin as the driver's « À l'heure »). */
export const SHOWN_DELAY_MIN = 5;

export type LiveStopInput = {
  id: string;
  tripId: string;
  kind: StopKind;
  sequence: number;
  arrivalMinute: number;
  startMinute: number;
  departureMinute: number;
  /** Real time of the status (minute of the day, Europe/Paris), null when none was recorded. */
  completedMinute: number | null;
};

export type LiveRouteInput = {
  vehicleId: string;
  startMinute: number;
  endMinute: number;
  stops: readonly LiveStopInput[];
};

export type LiveTripInput = {
  id: string;
  direction: TripDirection;
  status: TripStatus;
  appointmentMinute: number | null;
  readyMinute: number | null;
  vehicleId: string | null;
  /** The patient's other leg the same day (same care), null when none. */
  otherLegTripId?: string | null;
};

/**
 * - done: the crew recorded it; closed: nothing left to do there (absent, cancelled, done by the trip's status);
 * - missing: still without a status while a later stop of the route has one (forgotten tap);
 * - pending: still to do.
 */
export type LiveStopState = "done" | "closed" | "missing" | "pending";

export type StopProjection = {
  stopId: string;
  tripId: string;
  kind: StopKind;
  state: LiveStopState;
  /** Start of service: real (done), projected (pending) or planned (closed without a time, missing). */
  startMinute: number;
  departureMinute: number;
  /** Projected or real start minus planned start (positive: late). */
  delayMinutes: number;
  /** Pending stop whose expected status is past by more than OVERDUE_MARGIN_MIN, or a missing one: since how long. */
  overdueMinutes: number | null;
};

export type RouteProjection = {
  vehicleId: string;
  /** Stops closed (done, absent, cancelled) over all stops. */
  closed: number;
  total: number;
  /** A status was recorded on the route. */
  started: boolean;
  finished: boolean;
  /** Minute of the latest status recorded, null before the first one. */
  lastStatusMinute: number | null;
  /** The next stop to do (after the latest status), null once finished. */
  nextStopId: string | null;
  /** Projected delay of the next stop to do (0 when on time or early), null once finished. */
  delayMinutes: number | null;
  /** Nothing recorded SILENT_AFTER_MIN after the first status was due: since that moment. */
  silentSinceMinute: number | null;
  stops: StopProjection[];
};

/** An outbound drop-off projected after the appointment. */
export type ThreatenedAppointment = {
  tripId: string;
  vehicleId: string;
  appointmentMinute: number;
  projectedMinute: number;
  lateMinutes: number;
};

/** A patient whose wait at the care place goes over the limit (before the appointment plus after the session). */
export type LongWait = {
  /** The return trip still to pick up (or without a vehicle). */
  tripId: string;
  vehicleId: string | null;
  waitMinutes: number;
  /** Wait after the session (pickup projected, or now for a return without a vehicle). */
  afterMinutes: number;
  /** Wait before the appointment (outbound drop-off, real or projected). */
  beforeMinutes: number;
};

/** A stop past its time without a status, or a route silent since its first expected status. */
export type OverdueStop = { stopId: string; tripId: string; vehicleId: string; kind: StopKind; minutes: number; missing: boolean };
export type SilentRoute = { vehicleId: string; sinceMinute: number; minutes: number };

export type DayProjection = {
  nowMinute: number;
  routes: Map<string, RouteProjection>;
  threatened: ThreatenedAppointment[];
  overdue: OverdueStop[];
  silent: SilentRoute[];
  longWaits: LongWait[];
};

/** Planned moment of the status of a stop: « Pris en charge » once on board (departure), the others at the start. */
function tapOf(kind: StopKind, state: StopState, start: number, departure: number): number {
  return kind === "PICKUP" && state !== "no_show" ? departure : start;
}

/** Lateness announced by the crews: « tripId/KIND » of the stop -> minutes (LiveSnapshot.lateness). */
export type AnnouncedLateness = Readonly<Record<string, number>>;

/**
 * The projection of one route at `nowMinute`. `tripOf` gives each stop's trip as known now (status, ready time
 * updated from the field). A stop without its trip is read as still planned.
 */
export function projectRoute(
  route: LiveRouteInput,
  tripOf: (tripId: string) => LiveTripInput | undefined,
  nowMinute: number,
  lateness: AnnouncedLateness = {},
): RouteProjection {
  const stops = [...route.stops].sort((a, b) => a.sequence - b.sequence);
  const states = stops.map((stop): StopState => {
    const tripStatus = tripOf(stop.tripId)?.status ?? "ASSIGNED";
    const state = stopState({ kind: stop.kind, completedAt: stop.completedMinute !== null ? new Date(0) : null, tripStatus });
    // Done by the trip's field status alone (no time recorded on the stop): closed, read at its planned times.
    return state === "pending" && isStopDone({ kind: stop.kind }, tripStatus) ? "done" : state;
  });
  // The latest stop with a real time: what the crew has reached for sure.
  let lastTimed = -1;
  stops.forEach((stop, i) => {
    if (stop.completedMinute !== null && (states[i] === "done" || states[i] === "no_show")) lastTimed = i;
  });

  const projections: StopProjection[] = [];
  // The latest departure known (projected) and its planned counterpart: each leg keeps its planned length.
  let anchorProjected = route.startMinute;
  let anchorPlanned = route.startMinute;
  let nextIndex = -1;
  let lastStatusMinute: number | null = null;
  for (const [i, stop] of stops.entries()) {
    const state = states[i] ?? "pending";
    const service = stop.departureMinute - stop.startMinute;
    if (state !== "pending") {
      if (stop.completedMinute !== null && (state === "done" || state === "no_show")) {
        const tap = stop.completedMinute;
        lastStatusMinute = lastStatusMinute === null ? tap : Math.max(lastStatusMinute, tap);
        // « Pris en charge » is tapped on board (the departure); « Déposé » on arrival; « Patient absent » when leaving.
        const start = stop.kind === "PICKUP" && state === "done" ? tap - service : tap;
        const departure = stop.kind === "PICKUP" ? tap : tap + service;
        projections.push({ stopId: stop.id, tripId: stop.tripId, kind: stop.kind, state: "done", startMinute: start, departureMinute: departure, delayMinutes: start - stop.startMinute, overdueMinutes: null });
        // As the driver's reading: the real tap against its planned moment, carried through the planned legs.
        anchorProjected = tap;
        anchorPlanned = tapOf(stop.kind, state, stop.startMinute, stop.departureMinute);
        continue;
      }
      // Closed without a time (cancelled, absent's drop-off, done by the trip's status): the vehicle goes on as planned.
      projections.push({ stopId: stop.id, tripId: stop.tripId, kind: stop.kind, state: "closed", startMinute: stop.startMinute, departureMinute: stop.departureMinute, delayMinutes: 0, overdueMinutes: null });
      continue;
    }
    if (i < lastTimed) {
      // Forgotten: a later stop has its status. Read at its planned time; the later status anchors what follows.
      const due = tapOf(stop.kind, state, stop.startMinute, stop.departureMinute);
      projections.push({ stopId: stop.id, tripId: stop.tripId, kind: stop.kind, state: "missing", startMinute: stop.startMinute, departureMinute: stop.departureMinute, delayMinutes: 0, overdueMinutes: Math.max(0, nowMinute - due) });
      continue;
    }
    const trip = tripOf(stop.tripId);
    // Before any status the vehicle is read as on time (anchors: the planned departure from the depot).
    const arrival = anchorProjected + (stop.arrivalMinute - anchorPlanned);
    // Never before the planned start (the patient was told), a return pickup never before the patient is ready.
    const ready = stop.kind === "PICKUP" && trip?.direction === "RETURN" && trip.readyMinute !== null ? trip.readyMinute : -Infinity;
    // A lateness the crew announced on this stop: never before its planned start plus the minutes announced.
    const announced = lateness[`${stop.tripId}/${stop.kind}`];
    const expectedStart = Math.max(arrival, stop.startMinute, ready, announced ? stop.startMinute + announced : -Infinity);
    let start = expectedStart;
    let overdue: number | null = null;
    if (nextIndex === -1) {
      nextIndex = i;
      const due = tapOf(stop.kind, state, expectedStart, expectedStart + service);
      if (nowMinute > due + OVERDUE_MARGIN_MIN) overdue = nowMinute - due;
      // Not done yet: it happens now at the earliest (the crew may also have forgotten to tap).
      start = Math.max(expectedStart, stop.kind === "PICKUP" ? nowMinute - service : nowMinute);
    }
    const departure = start + service;
    projections.push({ stopId: stop.id, tripId: stop.tripId, kind: stop.kind, state: "pending", startMinute: start, departureMinute: departure, delayMinutes: start - stop.startMinute, overdueMinutes: overdue });
    anchorProjected = departure;
    anchorPlanned = stop.departureMinute;
  }

  const closed = projections.filter((p) => p.state === "done" || p.state === "closed").length;
  const next = nextIndex >= 0 ? projections[nextIndex] : undefined;
  const started = lastStatusMinute !== null;
  // Silent: no status at all, SILENT_AFTER_MIN after the first one was due (the first stop's tap as planned).
  const first = stops[0];
  const firstDue = first ? tapOf(first.kind, "pending", first.startMinute, first.departureMinute) : null;
  const silentSinceMinute =
    !started && next && firstDue !== null && nowMinute >= firstDue + SILENT_AFTER_MIN ? firstDue : null;
  return {
    vehicleId: route.vehicleId,
    closed,
    total: projections.length,
    started,
    finished: next === undefined && projections.every((p) => p.state !== "missing"),
    lastStatusMinute,
    nextStopId: next?.stopId ?? null,
    delayMinutes: next ? Math.max(0, next.delayMinutes) : null,
    silentSinceMinute,
    stops: projections,
  };
}

/** Outbound drop-offs still to do whose projected start is after the appointment. */
function threatenedOf(routes: readonly RouteProjection[], tripOf: (tripId: string) => LiveTripInput | undefined): ThreatenedAppointment[] {
  const list: ThreatenedAppointment[] = [];
  for (const route of routes) {
    for (const stop of route.stops) {
      if (stop.kind !== "DROPOFF" || stop.state !== "pending") continue;
      const trip = tripOf(stop.tripId);
      if (trip?.direction !== "OUTBOUND" || trip.appointmentMinute === null) continue;
      const late = stop.startMinute - trip.appointmentMinute;
      if (late > 0) {
        list.push({ tripId: trip.id, vehicleId: route.vehicleId, appointmentMinute: trip.appointmentMinute, projectedMinute: stop.startMinute, lateMinutes: late });
      }
    }
  }
  return list.sort((a, b) => a.appointmentMinute - b.appointmentMinute || b.lateMinutes - a.lateMinutes);
}

const OPEN: readonly TripStatus[] = ["PLANNED", "ASSIGNED"];

/**
 * Patients still to bring back whose wait at the care place (before their appointment plus after their session) goes
 * over `maxTotalWaitMin`: the return pickup as projected, or now for a return without a vehicle once the session is over.
 */
function longWaitsOf(
  routes: readonly RouteProjection[],
  trips: readonly LiveTripInput[],
  tripOf: (tripId: string) => LiveTripInput | undefined,
  nowMinute: number,
  maxTotalWaitMin: number,
): LongWait[] {
  const stopOf = new Map<string, StopProjection & { vehicleId: string }>();
  for (const route of routes) for (const stop of route.stops) stopOf.set(`${stop.tripId}/${stop.kind}`, { ...stop, vehicleId: route.vehicleId });
  const list: LongWait[] = [];
  for (const trip of trips) {
    if (trip.direction !== "RETURN" || !OPEN.includes(trip.status) || trip.readyMinute === null) continue;
    const pickup = stopOf.get(`${trip.id}/PICKUP`);
    if (pickup && pickup.state !== "pending") continue;
    // Without a vehicle, the patient waits from the end of the session until one is found (not before it ends).
    if (!pickup && nowMinute <= trip.readyMinute) continue;
    const after = Math.max(0, (pickup ? pickup.startMinute : nowMinute) - trip.readyMinute);
    const outbound = trip.otherLegTripId ? tripOf(trip.otherLegTripId) : undefined;
    const dropoff = outbound ? stopOf.get(`${outbound.id}/DROPOFF`) : undefined;
    // A patient absent on the outbound leg never reached the care place: « Retours à vérifier » says it.
    if (outbound?.status === "NO_SHOW") continue;
    const before =
      outbound?.appointmentMinute != null && dropoff && dropoff.state !== "closed" && dropoff.state !== "missing"
        ? Math.max(0, outbound.appointmentMinute - dropoff.startMinute)
        : 0;
    const wait = before + after;
    if (wait > maxTotalWaitMin) {
      list.push({ tripId: trip.id, vehicleId: pickup?.vehicleId ?? null, waitMinutes: wait, afterMinutes: after, beforeMinutes: before });
    }
  }
  return list.sort((a, b) => b.waitMinutes - a.waitMinutes);
}

/** The whole day: each route, then what the regulator should look at now. */
export function projectDay(args: {
  routes: readonly LiveRouteInput[];
  trips: readonly LiveTripInput[];
  nowMinute: number;
  maxTotalWaitMin: number;
  /** Lateness announced by the crews on stops still to do (« tripId/KIND » -> minutes). */
  lateness?: AnnouncedLateness;
}): DayProjection {
  const { routes, trips, nowMinute, maxTotalWaitMin, lateness = {} } = args;
  const byId = new Map(trips.map((trip) => [trip.id, trip]));
  const tripOf = (id: string) => byId.get(id);
  const projected = routes.map((route) => projectRoute(route, tripOf, nowMinute, lateness));
  const silent: SilentRoute[] = [];
  const overdue: OverdueStop[] = [];
  for (const route of projected) {
    if (route.silentSinceMinute !== null) {
      silent.push({ vehicleId: route.vehicleId, sinceMinute: route.silentSinceMinute, minutes: nowMinute - route.silentSinceMinute });
      // A silent route says it once: its first stop is not listed again as overdue.
      continue;
    }
    for (const stop of route.stops) {
      if (stop.overdueMinutes === null || (stop.state === "pending" && stop.overdueMinutes <= 0)) continue;
      if (stop.state === "missing" || stop.state === "pending") {
        overdue.push({ stopId: stop.stopId, tripId: stop.tripId, vehicleId: route.vehicleId, kind: stop.kind, minutes: stop.overdueMinutes, missing: stop.state === "missing" });
      }
    }
  }
  return {
    nowMinute,
    routes: new Map(projected.map((route) => [route.vehicleId, route])),
    threatened: threatenedOf(projected, tripOf),
    overdue: overdue.sort((a, b) => b.minutes - a.minutes),
    silent: silent.sort((a, b) => b.minutes - a.minutes),
    longWaits: longWaitsOf(projected, trips, tripOf, nowMinute, maxTotalWaitMin),
  };
}
