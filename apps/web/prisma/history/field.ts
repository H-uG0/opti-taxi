/**
 * What happened on the road (pure, unit-tested): cancellations, absent
 * patients and the times the crews recorded on the roadmap (/chauffeur).
 *
 * - « Pris en charge » is tapped once the patient is on board (planned
 *   departure from the pickup stop), « Déposé » on arrival at the drop-off.
 * - « Patient absent » is tapped on the pickup stop after waiting a few
 *   minutes; the drop-off of that trip is skipped (no time recorded).
 * - Each vehicle carries a lag that drifts from leg to leg (traffic, an
 *   incident now and then, a session that ends late) and is absorbed by the
 *   waits of the plan. A crew never catches up faster than physically
 *   possible: between two taps it takes at least FIELD_BEHAVIOUR.minTimeRatio
 *   of the planned drive and service time, plus the minutes of an incident on
 *   that leg.
 * - An outbound patient arrives after the appointment only when the delay
 *   cannot be made up: even the fastest catch-up (earliestTap, plus the
 *   minutes of an incident on the last leg) reaches the facility after the
 *   appointment, which takes a thin margin in the plan and an incident on
 *   the way, or a vehicle already well behind. Any smaller delay is absorbed
 *   (the drop-off is recorded just before the appointment). About 3 % of the
 *   outbound drop-offs over the seeded days.
 */
import type { StopKind, TripDirection, TripStatus } from "@prisma/client";
import type { UserCancellationReason } from "@/lib/domain/cancellation";
import { isSameEpisode } from "@/lib/domain/no-show";
import type { Rng } from "../seed/random";
import { unitFromKey } from "./hash";

export const FIELD_BEHAVIOUR = {
  /** Patient and day: the session is cancelled the day before, before the first optimization. */
  cancelledBeforePlanning: 0.004,
  /** Patient and day: the whole day is cancelled in the morning (hospitalisation, session cancelled by the facility). */
  cancelledOnTheDay: 0.003,
  /** Pickup of an outbound leg: the patient is not at home. */
  outboundNoShow: 0.026,
  /** Pickup of a return leg: the patient is no longer at the facility. */
  returnNoShow: 0.012,
  /** After an outbound « Patient absent », the regulator cancels the return unless the patient went on their own. */
  returnCancelledAfterNoShow: 0.85,
  /**
   * Per leg: an incident (traffic jam, roadworks) delays the vehicle by 3 to
   * 12 min. Calibrated with the rest of the lag on the seeded days: about 3 %
   * of the outbound patients arrive after their appointment.
   */
  incidentPerLeg: 0.02,
  incidentMin: [3, 12],
  /**
   * Random drift per leg (± minutes) and the share of the lag still there at
   * the next stop (the rest is made up on the way, within minTimeRatio).
   */
  legDriftMin: 1.5,
  lagCarryOver: 0.7,
  /** Return legs: the session ends 3 to 15 min late (dialysis, chemotherapy). */
  sessionOverrun: 0.12,
  sessionOverrunMin: [3, 15],
  /** Minutes the crew waits for an absent patient before tapping « Patient absent ». */
  noShowWaitMin: [5, 12],
  /** Fastest catch-up: the time between two taps is at least this share of the planned drive and service time. */
  minTimeRatio: 0.8,
  /** Two-person crew (ambulance): share of the statuses the crew mate taps rather than the driver. */
  crewMateTaps: 0.3,
} as const;

/** Trips that may still be cancelled or carried. */
const OPEN_STATUSES: readonly TripStatus[] = ["PLANNED", "ASSIGNED"];

// ---------------------------------------------------------------------------
// Cancellations and absences

/** Trips of the day whose session is cancelled the day before (both legs of the patient's day). */
export function cancellationsBeforePlanning(trips: readonly { id: string; patientId: string }[], isoDate: string): Set<string> {
  const cancelled = new Set<string>();
  for (const trip of trips) {
    if (unitFromKey(`cancel-before:${isoDate}:${trip.patientId}`) < FIELD_BEHAVIOUR.cancelledBeforePlanning) {
      cancelled.add(trip.id);
    }
  }
  return cancelled;
}

/**
 * Why a patient's session was cancelled (the day before or in the morning), as
 * the regulator records it in « Annuler la course »: the patient's own call
 * about half the time, a hospitalisation, or a session cancelled by the facility.
 */
export function patientCancellationReason(isoDate: string, patientId: string): UserCancellationReason {
  const unit = unitFromKey(`cancel-reason:${isoDate}:${patientId}`);
  if (unit < 0.5) return "PATIENT";
  return unit < 0.8 ? "HOSPITALIZATION" : "FACILITY";
}

/** A return cancelled because its outbound was declared absent: the regulation's decision, not the patient's call. */
export const AFTER_NO_SHOW_REASON: UserCancellationReason = "REGULATION";
export const AFTER_NO_SHOW_NOTE = "aller : patient absent";

export type DayTrip = {
  id: string;
  patientId: string;
  recurrenceId: string | null;
  facilityId: string | null;
  direction: TripDirection;
  status: TripStatus;
  routeId: string | null;
};

export type CancellationReason = "ON_THE_DAY" | "AFTER_NO_SHOW";

export type DayEvents = {
  /** Trips whose pickup ends with « Patient absent ». */
  noShows: Set<string>;
  /** Trips the regulator cancels during the day (they leave their route). */
  cancellations: Map<string, CancellationReason>;
};

/**
 * Cancellations and absences of a service day. Only trips still open
 * (PLANNED or ASSIGNED) are concerned; only a trip on a route can be
 * declared absent (the crew taps it on the pickup stop).
 */
export function decideDayEvents(trips: readonly DayTrip[], isoDate: string): DayEvents {
  const open = [...trips].filter((trip) => OPEN_STATUSES.includes(trip.status)).sort((a, b) => a.id.localeCompare(b.id));
  const noShows = new Set<string>();
  const cancellations = new Map<string, CancellationReason>();

  const patients = [...new Set(open.map((trip) => trip.patientId))].sort();
  for (const patientId of patients) {
    if (unitFromKey(`cancel-on-day:${isoDate}:${patientId}`) < FIELD_BEHAVIOUR.cancelledOnTheDay) {
      for (const trip of open) if (trip.patientId === patientId) cancellations.set(trip.id, "ON_THE_DAY");
    }
  }
  const carried = (trip: DayTrip) => trip.routeId !== null && trip.status === "ASSIGNED" && !cancellations.has(trip.id);

  for (const trip of open) {
    if (trip.direction !== "OUTBOUND" || !carried(trip)) continue;
    if (unitFromKey(`no-show:${trip.id}`) >= FIELD_BEHAVIOUR.outboundNoShow) continue;
    noShows.add(trip.id);
    // The patient never reached the facility: the return of the same care is cancelled, unless they went on their own.
    for (const back of open) {
      if (back.direction !== "RETURN" || cancellations.has(back.id) || !isSameEpisode(trip, back)) continue;
      if (unitFromKey(`return-after-no-show:${back.id}`) < FIELD_BEHAVIOUR.returnCancelledAfterNoShow) {
        cancellations.set(back.id, "AFTER_NO_SHOW");
      }
    }
  }
  for (const trip of open) {
    if (trip.direction !== "RETURN" || !carried(trip)) continue;
    if (unitFromKey(`no-show:${trip.id}`) < FIELD_BEHAVIOUR.returnNoShow) noShows.add(trip.id);
  }
  return { noShows, cancellations };
}

// ---------------------------------------------------------------------------
// Times recorded by the crew

export type PlannedStop = {
  id: string;
  tripId: string;
  kind: StopKind;
  sequence: number;
  lat: number;
  lng: number;
  arrivalMinute: number;
  startMinute: number;
  departureMinute: number;
};

export type TripTiming = {
  direction: TripDirection;
  /** OUTBOUND: the appointment (arrival at the latest). */
  appointmentMinute: number | null;
  /** RETURN: end of the session (pickup at the earliest). */
  readyMinute: number | null;
};

/** A status tapped on the roadmap: minute of the service day (Europe/Paris) and second. */
export type StopTime = { stopId: string; tripId: string; kind: StopKind; minute: number; second: number };

export type RouteTimes = {
  times: StopTime[];
  /** Outbound trips dropped off after their appointment minute. */
  lateTripIds: string[];
};

function samePlace(a: PlannedStop, b: PlannedStop): boolean {
  return a.lat === b.lat && a.lng === b.lng;
}

function isLate(minute: number, appointment: number): boolean {
  // The dashboard compares whole minutes: 08:00:40 for an 08:00 appointment is on time.
  return Math.floor(minute) > appointment;
}

/** Planned minute of the status tapped at a stop: « Pris en charge » on departure, « Déposé » on arrival. */
export function plannedTapMinute(stop: Pick<PlannedStop, "kind" | "startMinute" | "departureMinute">): number {
  return stop.kind === "PICKUP" ? stop.departureMinute : stop.startMinute + 1;
}

/**
 * Earliest tap at `stop` after a tap at `previous` (minutes): the planned
 * drive and service time between the two taps, without the planned wait at
 * `stop` (a crew behind schedule skips it), shortened at most to
 * FIELD_BEHAVIOUR.minTimeRatio; at least one minute between two places.
 */
export function earliestTap(previous: { stop: PlannedStop; tap: number }, stop: PlannedStop): number {
  const wait = Math.max(0, stop.startMinute - stop.arrivalMinute);
  const planned = Math.max(0, plannedTapMinute(stop) - plannedTapMinute(previous.stop) - wait);
  return previous.tap + Math.max(samePlace(previous.stop, stop) ? 0 : 1, FIELD_BEHAVIOUR.minTimeRatio * planned);
}

/**
 * Times the crew of one route records, stop by stop in sequence order. Stops
 * of a trip unknown to `trips` are ignored; the drop-off of an absent patient
 * gets no time. Times never go backwards along the route.
 */
export function simulateRouteTimes(
  stops: readonly PlannedStop[],
  trips: ReadonlyMap<string, TripTiming>,
  noShows: ReadonlySet<string>,
  rng: Rng,
): RouteTimes {
  const b = FIELD_BEHAVIOUR;
  const times: StopTime[] = [];
  const lateTripIds: string[] = [];
  // Minutes behind the plan (negative: ahead): the crew leaves the depot roughly on time.
  let lag = rng.float(-2, 3);
  let previous: { stop: PlannedStop; tap: number } | null = null;

  for (const stop of [...stops].sort((a, z) => a.sequence - z.sequence)) {
    const trip = trips.get(stop.tripId);
    if (!trip) continue;
    const absent = noShows.has(stop.tripId);
    if (stop.kind === "DROPOFF" && absent) continue;

    // An incident on the way to this stop: its minutes cannot be made up on the same leg.
    let incident = 0;
    if (previous) {
      lag = lag * b.lagCarryOver + rng.float(-b.legDriftMin, b.legDriftMin);
      if (rng.chance(b.incidentPerLeg)) incident = rng.int(b.incidentMin[0], b.incidentMin[1]);
      lag += incident;
    }
    // A planned wait absorbs a delay; arriving early at a stop with a wait means waiting until its planned start.
    const slack = Math.max(0, stop.startMinute - stop.arrivalMinute);
    const lagAtStart = lag >= 0 ? Math.max(0, lag - slack) : slack > 0 ? 0 : lag;

    let planned: number;
    let tap: number;
    if (stop.kind === "PICKUP") {
      planned = stop.departureMinute;
      if (absent) {
        tap = stop.startMinute + lagAtStart + rng.float(b.noShowWaitMin[0], b.noShowWaitMin[1]);
      } else {
        tap = planned + lagAtStart + rng.float(-1, 2);
        if (trip.direction === "RETURN" && trip.readyMinute !== null && rng.chance(b.sessionOverrun)) {
          const ready = trip.readyMinute + rng.int(b.sessionOverrunMin[0], b.sessionOverrunMin[1]);
          tap = Math.max(tap, ready + (stop.departureMinute - stop.startMinute));
        }
      }
    } else {
      planned = stop.startMinute + 1;
      tap = stop.startMinute + lagAtStart + rng.float(0, 2);
    }
    const floor = previous ? earliestTap(previous, stop) + incident : Number.NEGATIVE_INFINITY;
    tap = Math.max(tap, floor);

    const appointment = stop.kind === "DROPOFF" && trip.direction === "OUTBOUND" ? trip.appointmentMinute : null;
    if (appointment !== null) {
      // The crew hurries for the appointment: the delay is made up as far as the fastest catch-up allows.
      if (isLate(tap, appointment)) tap = Math.max(floor, appointment + 0.99 - rng.float(0, 2));
      if (isLate(tap, appointment)) lateTripIds.push(stop.tripId);
    }

    const minute = Math.floor(tap);
    times.push({ stopId: stop.id, tripId: stop.tripId, kind: stop.kind, minute, second: Math.min(59, Math.floor((tap - minute) * 60)) });
    lag = tap - planned;
    previous = { stop, tap };
  }
  return { times, lateTripIds };
}

/**
 * Account that taps a status (RouteStop.completedById, author of the audit
 * event): the route's driver, or for a two-person crew sometimes the crew
 * mate (stable for a trip and stop kind). `accounts` maps a driver id to the
 * id of its user account; a crew member without one never taps, and null
 * means neither has an account.
 */
export function stopRecorder(
  crew: { driverId: string | null; crewMateId: string | null },
  accounts: ReadonlyMap<string, string>,
  tripId: string,
  kind: StopKind,
): string | null {
  const driver = crew.driverId ? (accounts.get(crew.driverId) ?? null) : null;
  const crewMate = crew.crewMateId ? (accounts.get(crew.crewMateId) ?? null) : null;
  if (driver && crewMate) {
    return unitFromKey(`recorded-by:${tripId}:${kind}`) < FIELD_BEHAVIOUR.crewMateTaps ? crewMate : driver;
  }
  return driver ?? crewMate;
}

// ---------------------------------------------------------------------------
// Statuses at the end of the day

export type StatusUpdate = { where: { id: { in: string[] }; status: "ASSIGNED" }; data: { status: TripStatus } };

/**
 * Final statuses written from the roadmap: « Déposé » makes a trip
 * DROPPED_OFF, « Patient absent » NO_SHOW. Only a trip still ASSIGNED changes
 * (a trip cancelled during the day keeps CANCELLED); an absent patient is
 * never dropped off.
 */
export function fieldStatusUpdates(droppedOff: Iterable<string>, noShows: ReadonlySet<string>): StatusUpdate[] {
  const dropped = [...new Set(droppedOff)].filter((id) => !noShows.has(id)).sort();
  return [
    { where: { id: { in: dropped }, status: "ASSIGNED" }, data: { status: "DROPPED_OFF" } },
    { where: { id: { in: [...noShows].sort() }, status: "ASSIGNED" }, data: { status: "NO_SHOW" } },
  ];
}
