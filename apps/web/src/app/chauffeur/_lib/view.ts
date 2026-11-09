/**
 * Turns a loaded route into what the roadmap renders: one StopView per stop
 * (state, next stop, shared ride, buttons) and the route header. Pure (the
 * import from ./load is type-only), so it is unit-tested with plain objects.
 */
import type { Mobility, RouteStatus, StopKind, VehicleType } from "@prisma/client";
import { minuteOfDay } from "@/lib/time";
import type { DriverRoute } from "./load";
import { phoneContact, telHref, type PhoneContact } from "./links";
import { recordedLateness, type RecordedLateness } from "./punctuality";
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

export type StopView = {
  id: string;
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
   * Real time against the appointment (outbound dropoff with one) or the
   * planned time (any other stop), null when not recorded.
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
  /** The patient's home access notes (code, floor, lift), on the stops at home only. */
  accessNotes: string | null;
  tripNotes: string | null;
  /** Facility of a facility stop (outbound dropoff, return pickup), with its instructions (entrance, parking, floor). */
  facility: { name: string; phone: string | null; phoneHref: string | null; notes: string | null } | null;
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
  controls: StopControls;
};

export type RouteView = {
  id: string;
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
  nextStop: StopView | null;
  timeline: TimelineItem<StopView>[];
};

const NOT_RIDING = new Set(["NO_SHOW", "CANCELLED"]);

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

/**
 * `editable` is true on the service day only (see stopControls).
 * `returnTripsAfterOutboundNoShow` comes from loadReturnTripsAfterOutboundNoShow.
 */
export function buildRouteView(
  route: DriverRoute,
  driverId: string,
  editable: boolean,
  returnTripsAfterOutboundNoShow: ReadonlySet<string> = new Set(),
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
      // Outbound dropoff or return pickup: the care place (or a private client's free address), never the home.
      const careStop = isFacilityStop(stop.kind, trip.direction);
      const facilityStop = careStop && trip.facility !== null;
      const state = stopState({ kind: stop.kind, completedAt: stop.completedAt, tripStatus: trip.status });
      // The appointment an outbound dropoff is judged against.
      const appointmentMinute = trip.direction === "OUTBOUND" && stop.kind === "DROPOFF" ? trip.appointmentMinute : null;
      const completedMinute = stop.completedAt ? minuteOfDay(stop.completedAt) : null;
      // The latest status recorded before this stop: its real time plus the planned time from it to here.
      const anchorArrivalMinute =
        latestStop?.completedAt && latestStop.sequence < stop.sequence
          ? minuteOfDay(latestStop.completedAt) + (stop.arrivalMinute - latestStop.startMinute)
          : null;
      return {
        id: stop.id,
        position: index + 1,
        kind: stop.kind,
        state,
        isNext: stop.id === nextId,
        plannedMinute: stop.startMinute,
        plannedArrivalMinute: stop.arrivalMinute,
        completedMinute,
        lateness:
          completedMinute !== null
            ? recordedLateness({ completedMinute, plannedMinute: stop.startMinute, appointmentMinute })
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
        accessNotes: careStop ? null : trip.patient.accessNotes?.trim() || null,
        tripNotes: trip.notes?.trim() || null,
        facility:
          facilityStop && trip.facility
            ? {
                name: trip.facility.name,
                phone: trip.facility.phone,
                phoneHref: telHref(trip.facility.phone),
                notes: trip.facility.notes?.trim() || null,
              }
            : null,
        payOnBoard: trip.payer === "PRIVATE",
        keyTime: stopKeyTime({
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
    nextStop: stops.find((stop) => stop.isNext) ?? null,
    timeline: buildTimeline(
      stops.map((stop) => ({ ...stop, sequence: stop.position, startMinute: stop.plannedMinute })),
      route,
    ),
  };
}
