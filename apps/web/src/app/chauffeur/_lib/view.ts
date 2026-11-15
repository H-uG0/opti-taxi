/**
 * Turns a loaded route into what the roadmap renders: one StopView per stop
 * (state, next stop, shared ride, buttons) and the route header. Pure (the
 * import from ./load is type-only), so it is unit-tested with plain objects.
 */
import type { Mobility, RouteStatus, StopKind, TripStatus, VehicleType } from "@prisma/client";
import { fieldRequestCrewText, OPEN_TRIP_STATUSES, type FieldRequestView } from "@/lib/domain/field-requests";
import { roadmapSnapshot, stopKey } from "@/lib/planning/roadmap-version";
import { dayHoursText, facilityHoursOn } from "@/lib/domain/facility-hours";
import { addDays, formatMinute, minuteOfDay, toIsoDate } from "@/lib/time";
import type { DriverRoute, DriverRouteStop } from "./load";
import { phoneContact, telHref, type PhoneContact } from "./links";
import { plannedTapMinute, recordedLateness, type RecordedLateness } from "./punctuality";
import {
  buildTimeline,
  coPassengers,
  isFacilityStop,
  latestCompletedStopId,
  nextStopId,
  displayName,
  routeProgress,
  stopKeyTime,
  stopState,
  type StopLike,
  type StopState,
  type TimelineItem,
} from "./roadmap";
import { stopControls, type StopControls } from "./transitions";

/**
 * What the crew may signal or ask from a stop (DAY-05), and what it already sent. Today only, never on a stop of an
 * absent patient or a cancelled trip.
 */
export type StopFieldView = {
  /** Outbound drop-off: end of session of the patient's return still to do (null: none, or no time). */
  readyMinute: number | null;
  /** The appointment of the outbound: a session never ends before it. */
  appointmentMinute: number | null;
  /** « Patient prêt à HH:MM »: the return is still to do. */
  signalReady: boolean;
  /** Ask for the return's cancellation (none asked yet). */
  cancelReturn: boolean;
  /** Ask for a return when none is planned (none asked yet). */
  askReturn: boolean;
  /** The next session of the series (a trip of a recurrence). */
  nextSession: boolean;
  /** Earliest date of the next session (the day after the route's), YYYY-MM-DD. */
  nextSessionMin: string | null;
  /** A pickup still to do: ask for the trip's cancellation (none asked yet). */
  askCancel: boolean;
  /** What was sent already, with where it stands. */
  sent: string[];
};

/** The crew's requests and the patient's return, read for the stops of today (load.ts loadFieldContext). */
export type FieldContext = {
  /** Outbound trip id -> its return the same day (same care), when there is one: a cancelled one only when no other. */
  returns: ReadonlyMap<string, { id: string; status: TripStatus; readyMinute: number | null }>;
  /** Trip id -> the crews' requests about it, oldest first. */
  requests: ReadonlyMap<string, readonly FieldRequestView[]>;
};

export const NO_FIELD_CONTEXT: FieldContext = { returns: new Map(), requests: new Map() };

export type StopView = {
  id: string;
  /** « tripId/KIND »: what a change of the roadmap highlights (lib/planning/roadmap-version.ts). */
  changeKey: string;
  /** Signals and requests of the crew from this stop (DAY-05), null when none applies. */
  field: StopFieldView | null;
  /** 1-based position in the route. */
  position: number;
  kind: StopKind;
  state: StopState;
  isNext: boolean;
  plannedMinute: number;
  /** Planned arrival (before any planned wait), minutes since midnight. */
  plannedArrivalMinute: number;
  /** Real time of the recorded status, minutes since midnight Europe/Paris. */
  completedMinute: number | null;
  /**
   * Planned departure of a pickup whose patient is on board, when it differs
   * from plannedMinute (the status was due then, after the service time); null otherwise.
   */
  plannedDepartureMinute: number | null;
  /**
   * Real time against the appointment (outbound dropoff with one) or the
   * planned moment of the status (any other stop: plannedTapMinute), null when not recorded.
   */
  lateness: RecordedLateness | null;
  /**
   * Live early / on time / late reading, on the next stop of today's route
   * only: the appointment of an outbound dropoff, and the earliest arrival
   * given the latest status recorded before it (null before the first one).
   */
  timing: { appointmentMinute: number | null; anchorArrivalMinute: number | null } | null;
  /** On a dropoff: the pickup stop of the same trip on the route (a pickup still on the phone unlocks the dropoff). */
  pickupStopId: string | null;
  /**
   * First name of the other crew member when they recorded the status (pickup,
   * dropoff or absence); null when the signed-in driver did, or when unknown.
   */
  recordedBy: string | null;
  address: string;
  lat: number;
  lng: number;
  patient: string;
  phone: string | null;
  phoneHref: string | null;
  mobility: Mobility;
  /** The patient's home access notes (code, floor, lift), on the stops at home only (not at a one-off address). */
  accessNotes: string | null;
  /** A home-side stop at an address typed for this trip only (the patient is staying elsewhere). */
  oneOffAddress: boolean;
  tripNotes: string | null;
  /**
   * Facility of a facility stop (outbound dropoff, return pickup), with its instructions (entrance, parking,
   * floor) and its reception hours that day (« Accueil de 07:00 à 19:00 »; null when none entered).
   */
  facility: { name: string; phone: string | null; phoneHref: string | null; notes: string | null; hours: string | null } | null;
  /** Private client (no CPAM billing): the crew collects the fare on board. */
  payOnBoard: boolean;
  keyTime: { label: string; minute: number } | null;
  /** Other patients on board at the same time as this one (shared transport). */
  sharedWith: string[];
  /** Patients on board after the stop, corrected for absent and cancelled patients. */
  onBoardAfter: number;
  /**
   * Return pickup still to do whose outbound leg the same day was closed as
   * "patient absent": the patient is probably not at the facility.
   */
  outboundNoShow: boolean;
  /**
   * The transport of this patient was interrupted (breakdown, crew unavailable: DAY-03) while they were on board:
   * another vehicle picks them up again, at `pickupMinute` once placed (null: not yet). Null otherwise.
   */
  interrupted: { pickupMinute: number | null } | null;
  /** Pickup of a continuation: the patient waits where their transport was interrupted (never the care place). */
  resumesInterrupted: boolean;
  controls: StopControls;
};

export type RouteView = {
  id: string;
  /** The vehicle: the roadmap's published versions are kept per vehicle and date (DAY-04). */
  vehicleId: string;
  /** Fingerprint of the roadmap as drawn: the page is stale when the server's differs. */
  fingerprint: string;
  status: RouteStatus;
  vehicle: {
    label: string;
    registration: string;
    type: VehicleType;
    /** notes: access to the depot (gate, keys, parking), shown at the departure and the return. */
    depot: { name: string; address: string; lat: number; lng: number; notes: string | null };
  };
  startMinute: number;
  endMinute: number;
  distanceKm: number;
  /** Break placed by the planner. */
  plannedBreak: { startMinute: number; endMinute: number } | null;
  /** Break window of the driver when the planner placed none. */
  breakWindow: { minutes: number; startMinute: number; endMinute: number } | null;
  /** Crew role of the signed-in driver on this route. */
  role: "DRIVER" | "CREW_MATE";
  /** The other crew member, if any. */
  partner: string | null;
  /** Phone of the other crew member (employee data), to call them from the roadmap. */
  partnerPhone: PhoneContact | null;
  progress: { closed: number; total: number };
  stops: StopView[];
  /**
   * Patients of the route whose transport was interrupted and who still wait for the vehicle that picks them up
   * again: the crew stays with them (the roadmap does not say « retour au dépôt » yet).
   */
  waitingPatients: { patient: string; pickupMinute: number | null }[];
  nextStop: StopView | null;
  timeline: TimelineItem<StopView>[];
};

const NOT_RIDING = new Set(["NO_SHOW", "CANCELLED"]);

/** The continuation of an interrupted transport, as the crew left with the patient is told of it. */
function interruptionOf(trip: DriverRouteStop["trip"]): StopView["interrupted"] {
  if (trip.status !== "CANCELLED" || trip.cancellationReason !== "INTERRUPTED") return null;
  const placed = trip.continuation?.routeId ? trip.continuation.plannedPickupMinute : null;
  return { pickupMinute: placed ?? null };
}

/** The continuation of the trip of this stop is picked up (or done, or closed): the patient no longer waits. */
function continuationPickedUp(route: DriverRoute, stopId: string): boolean {
  const status = route.stops.find((stop) => stop.id === stopId)?.trip.continuation?.status;
  return status !== undefined && status !== "PLANNED" && status !== "ASSIGNED";
}

/** « Accueil de 07:00 à 19:00 » on the route's day, null when the facility has no hours (or when not loaded). */
function facilityHoursText(
  facility: { openingHours?: unknown; earliestArrivalMinute?: number | null },
  serviceDate: Date | undefined,
): string | null {
  if (!serviceDate || facility.openingHours === undefined) return null;
  const hours = facilityHoursOn(
    { openingHours: facility.openingHours, earliestArrivalMinute: facility.earliestArrivalMinute ?? null },
    toIsoDate(serviceDate),
  );
  return hours ? dayHoursText(hours) : null;
}

/** Patients on board after each stop, walking the route with riding patients only. */
function onBoardAfterStops(stops: readonly StopLike[]): Map<string, number> {
  const onBoard = new Set<string>();
  const result = new Map<string, number>();
  for (const stop of [...stops].sort((a, b) => a.sequence - b.sequence)) {
    if (!NOT_RIDING.has(stop.tripStatus)) {
      if (stop.kind === "PICKUP") onBoard.add(stop.tripId);
      else onBoard.delete(stop.tripId);
    }
    result.set(stop.id, onBoard.size);
  }
  return result;
}

/** « 10:05 » of an ISO instant (Europe/Paris). */
function sentAt(iso: string): string {
  return formatMinute(minuteOfDay(new Date(iso)));
}

const hasPending = (requests: readonly FieldRequestView[] | undefined, kind: FieldRequestView["kind"]) =>
  (requests ?? []).some((request) => request.kind === kind && request.status === "PENDING");

/** The signals and requests a stop offers (DAY-05): an outbound drop-off, or a pickup still to do. */
export function stopFieldView(
  stop: Pick<DriverRouteStop, "kind" | "tripId" | "completedAt"> & { trip: Pick<DriverRouteStop["trip"], "direction" | "status" | "appointmentMinute" | "recurrenceId"> },
  field: FieldContext,
  serviceDate: string,
): StopFieldView | null {
  const { trip } = stop;
  if (trip.status === "CANCELLED" || trip.status === "NO_SHOW") return null;
  const own = field.requests.get(stop.tripId);
  if (stop.kind === "DROPOFF" && trip.direction === "OUTBOUND") {
    const back = field.returns.get(stop.tripId) ?? null;
    const backRequests = back ? field.requests.get(back.id) : undefined;
    const open = back !== null && OPEN_TRIP_STATUSES.includes(back.status);
    // The return cancelled as the crew asked: the answer shows (below), no new return is offered as if none was planned.
    const cancelledAsAsked = back?.status === "CANCELLED" && (backRequests ?? []).some((request) => request.kind === "CANCEL" && request.status === "ACCEPTED");
    const noReturn = back === null || (back.status === "CANCELLED" && !cancelledAsAsked);
    const sent = [...(own ?? []), ...(backRequests ?? [])]
      .filter((request) => request.kind !== "CANCEL" || back?.id === request.tripId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((request) => fieldRequestCrewText(request, sentAt(request.createdAt)));
    return {
      readyMinute: open ? back.readyMinute : null,
      appointmentMinute: trip.appointmentMinute,
      signalReady: open,
      cancelReturn: open && !hasPending(backRequests, "CANCEL"),
      askReturn: noReturn && !hasPending(own, "RETURN"),
      nextSession: trip.recurrenceId !== null,
      nextSessionMin: addDays(serviceDate, 1),
      askCancel: false,
      sent,
    };
  }
  if (stop.kind === "PICKUP" && stop.completedAt === null && OPEN_TRIP_STATUSES.includes(trip.status)) {
    const sent = (own ?? []).filter((request) => request.kind === "CANCEL").map((request) => fieldRequestCrewText(request, sentAt(request.createdAt)));
    return {
      readyMinute: null,
      appointmentMinute: null,
      signalReady: false,
      cancelReturn: false,
      askReturn: false,
      nextSession: false,
      nextSessionMin: null,
      askCancel: !hasPending(own, "CANCEL"),
      sent,
    };
  }
  return null;
}

/**
 * Whether tomorrow's card (« Demain ») comes first on today's roadmap: in the evening, once every stop of the day is
 * done, and on a day without a route; after the routes otherwise. Shown once either way.
 */
export function nextDayCardFirst(views: readonly Pick<RouteView, "nextStop">[]): boolean {
  return views.every((view) => view.nextStop === null);
}

/** The route's fingerprint as the server computes it (roadmap-sync.ts): the page drawn is stale when it differs. */
function roadmapFingerprint(route: DriverRoute): string {
  const tripOf = (tripId: string) => route.stops.find((stop) => stop.tripId === tripId)?.trip;
  return roadmapSnapshot(
    route.stops,
    (tripId) => tripOf(tripId)?.status === "CANCELLED",
    (tripId) => {
      const trip = tripOf(tripId);
      return trip?.direction === "RETURN" ? trip.readyMinute : null;
    },
  ).fingerprint;
}

/**
 * `editable` is true on the service day only (see stopControls).
 * `returnTripsAfterOutboundNoShow` comes from loadReturnTripsAfterOutboundNoShow, `field` from loadFieldContext.
 */
export function buildRouteView(
  route: DriverRoute,
  driverId: string,
  editable: boolean,
  returnTripsAfterOutboundNoShow: ReadonlySet<string> = new Set(),
  field: FieldContext = NO_FIELD_CONTEXT,
): RouteView {
  const like: StopLike[] = route.stops.map((stop) => ({
    id: stop.id,
    sequence: stop.sequence,
    kind: stop.kind,
    tripId: stop.tripId,
    completedAt: stop.completedAt,
    tripStatus: stop.trip.status,
  }));
  const nextId = nextStopId(like);
  const latestId = latestCompletedStopId(like);
  const pickupOfTrip = new Map(route.stops.filter((stop) => stop.kind === "PICKUP").map((stop) => [stop.tripId, stop.id]));
  const latestStop = route.stops.find((stop) => stop.id === latestId) ?? null;
  // Planned moment of the latest status: « Pris en charge » is tapped with the patient on board
  // (planned departure), « Déposé » and « Patient absent » at the planned start.
  const latestPlannedTap = latestStop
    ? plannedTapMinute({ ...latestStop, noShow: latestStop.trip.status === "NO_SHOW" })
    : null;
  const shared = coPassengers(like);
  const onBoard = onBoardAfterStops(like);
  const nameOfTrip = new Map(route.stops.map((stop) => [stop.tripId, displayName(stop.trip.patient)]));
  const isDriver = route.driverId === driverId;
  const partner = isDriver ? route.crewMate : route.driver;
  const partnerId = isDriver ? route.crewMateId : route.driverId;
  const partnerFirstName = partner && partnerId && partnerId !== driverId ? partner.firstName.trim() || null : null;

  const stops: StopView[] = [...route.stops]
    .sort((a, b) => a.sequence - b.sequence)
    .map((stop, index) => {
      const { trip } = stop;
      // A continuation's pickup is where the transport was interrupted: a free address, never the care place.
      const resumesInterrupted = stop.kind === "PICKUP" && trip.continuesTripId !== null;
      // Outbound dropoff or return pickup: the care place (or a private client's free address), never the home.
      const careStop = isFacilityStop(stop.kind, trip.direction) && !resumesInterrupted;
      const facilityStop = careStop && trip.facility !== null;
      const state = stopState({ kind: stop.kind, completedAt: stop.completedAt, tripStatus: trip.status });
      // The appointment an outbound dropoff is judged against.
      const appointmentMinute = trip.direction === "OUTBOUND" && stop.kind === "DROPOFF" ? trip.appointmentMinute : null;
      const completedMinute = stop.completedAt ? minuteOfDay(stop.completedAt) : null;
      // The latest status recorded before this stop: its real time plus the planned time from its planned moment to here.
      const anchorArrivalMinute =
        latestStop?.completedAt && latestPlannedTap !== null && latestStop.sequence < stop.sequence
          ? minuteOfDay(latestStop.completedAt) + (stop.arrivalMinute - latestPlannedTap)
          : null;
      const plannedTap = plannedTapMinute({ ...stop, noShow: state === "no_show" });
      return {
        id: stop.id,
        changeKey: stopKey(stop.tripId, stop.kind),
        field: editable ? stopFieldView(stop, field, toIsoDate(route.serviceDate)) : null,
        position: index + 1,
        kind: stop.kind,
        state,
        isNext: stop.id === nextId,
        plannedMinute: stop.startMinute,
        plannedArrivalMinute: stop.arrivalMinute,
        completedMinute,
        plannedDepartureMinute: state === "done" && stop.kind === "PICKUP" && plannedTap !== stop.startMinute ? plannedTap : null,
        lateness:
          completedMinute !== null
            ? recordedLateness({ completedMinute, plannedTapMinute: plannedTap, appointmentMinute })
            : null,
        timing: editable && stop.id === nextId ? { appointmentMinute, anchorArrivalMinute } : null,
        pickupStopId: stop.kind === "DROPOFF" ? (pickupOfTrip.get(stop.tripId) ?? null) : null,
        recordedBy:
          (state === "done" || state === "no_show") && partnerId && stop.completedBy?.driverId === partnerId
            ? partnerFirstName
            : null,
        address: stop.address,
        lat: stop.lat,
        lng: stop.lng,
        patient: displayName(trip.patient),
        phone: trip.patient.phone,
        phoneHref: telHref(trip.patient.phone),
        mobility: trip.patient.mobility,
        accessNotes: careStop || trip.oneOffAddress ? null : trip.patient.accessNotes?.trim() || null,
        oneOffAddress: !careStop && !resumesInterrupted && trip.oneOffAddress,
        tripNotes: trip.notes?.trim() || null,
        facility:
          facilityStop && trip.facility
            ? {
                name: trip.facility.name,
                phone: trip.facility.phone,
                phoneHref: telHref(trip.facility.phone),
                notes: trip.facility.notes?.trim() || null,
                hours: facilityHoursText(trip.facility, route.serviceDate),
              }
            : null,
        payOnBoard: trip.payer === "PRIVATE",
        keyTime: resumesInterrupted
          ? null
          : stopKeyTime({
              kind: stop.kind,
              direction: trip.direction,
              appointmentMinute: trip.appointmentMinute,
              readyMinute: trip.readyMinute,
            }),
        sharedWith: (shared.get(stop.tripId) ?? []).map((tripId) => nameOfTrip.get(tripId) ?? "Autre patient"),
        onBoardAfter: onBoard.get(stop.id) ?? 0,
        outboundNoShow:
          stop.kind === "PICKUP" &&
          trip.direction === "RETURN" &&
          state === "pending" &&
          returnTripsAfterOutboundNoShow.has(stop.tripId),
        interrupted: interruptionOf(trip),
        resumesInterrupted,
        controls: stopControls(
          { kind: stop.kind, completedAt: stop.completedAt, tripStatus: trip.status, isLatestCompleted: stop.id === latestId },
          editable,
        ),
      };
    });

  const plannedBreak =
    route.breakStartMinute !== null && route.breakEndMinute !== null
      ? { startMinute: route.breakStartMinute, endMinute: route.breakEndMinute }
      : null;
  const driver = route.driver;
  const breakWindow =
    !plannedBreak &&
    driver &&
    driver.breakMinutes > 0 &&
    driver.breakWindowStartMinute !== null &&
    driver.breakWindowEndMinute !== null
      ? { minutes: driver.breakMinutes, startMinute: driver.breakWindowStartMinute, endMinute: driver.breakWindowEndMinute }
      : null;

  return {
    id: route.id,
    vehicleId: route.vehicleId,
    fingerprint: roadmapFingerprint(route),
    status: route.status,
    vehicle: { ...route.vehicle, depot: { ...route.vehicle.depot, notes: route.vehicle.depot.notes?.trim() || null } },
    startMinute: route.startMinute,
    endMinute: route.endMinute,
    distanceKm: route.distanceKm,
    plannedBreak,
    breakWindow,
    role: isDriver ? "DRIVER" : "CREW_MATE",
    partner: partner ? displayName(partner) : null,
    partnerPhone: partner ? phoneContact(partner.phone) : null,
    progress: routeProgress(like),
    stops,
    waitingPatients: stops.flatMap((stop) =>
      stop.kind === "PICKUP" && stop.interrupted && !continuationPickedUp(route, stop.id)
        ? [{ patient: stop.patient, pickupMinute: stop.interrupted.pickupMinute }]
        : [],
    ),
    nextStop: stops.find((stop) => stop.isNext) ?? null,
    timeline: buildTimeline(
      stops.map((stop) => ({ ...stop, sequence: stop.position, startMinute: stop.plannedMinute })),
      route,
    ),
  };
}
