/**
 * Turns a loaded route into what the roadmap renders: one StopView per stop
 * (state, next stop, shared ride, buttons) and the route header. Pure (the
 * import from ./load is type-only), so it is unit-tested with plain objects.
 */
import type { Mobility, RouteStatus, StopKind, VehicleType } from "@prisma/client";
import { minuteOfDay } from "@/lib/time";
import type { DriverRoute } from "./load";
import { telHref } from "./links";
import {
  buildTimeline,
  coPassengers,
  isFacilityStop,
  latestCompletedStopId,
  minutesLate,
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
  /** Real time of the recorded status, minutes since midnight Europe/Paris. */
  completedMinute: number | null;
  /** Real minus planned time, null when not recorded. */
  lateMinutes: number | null;
  address: string;
  lat: number;
  lng: number;
  patient: string;
  phone: string | null;
  phoneHref: string | null;
  mobility: Mobility;
  accessNotes: string | null;
  tripNotes: string | null;
  /** Facility of a facility stop (outbound dropoff, return pickup). */
  facility: { name: string; phone: string | null; phoneHref: string | null } | null;
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
    depotLabel: string;
    depotAddress: string;
    depotLat: number;
    depotLng: number;
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
  const shared = coPassengers(like);
  const onBoard = onBoardAfterStops(like);
  const nameOfTrip = new Map(route.stops.map((stop) => [stop.tripId, displayName(stop.trip.patient)]));

  const stops: StopView[] = [...route.stops]
    .sort((a, b) => a.sequence - b.sequence)
    .map((stop, index) => {
      const { trip } = stop;
      const facilityStop = isFacilityStop(stop.kind, trip.direction) && trip.facility !== null;
      const state = stopState({ kind: stop.kind, completedAt: stop.completedAt, tripStatus: trip.status });
      return {
        id: stop.id,
        position: index + 1,
        kind: stop.kind,
        state,
        isNext: stop.id === nextId,
        plannedMinute: stop.startMinute,
        completedMinute: stop.completedAt ? minuteOfDay(stop.completedAt) : null,
        lateMinutes: stop.completedAt ? minutesLate(stop.startMinute, stop.completedAt) : null,
        address: stop.address,
        lat: stop.lat,
        lng: stop.lng,
        patient: displayName(trip.patient),
        phone: trip.patient.phone,
        phoneHref: telHref(trip.patient.phone),
        mobility: trip.patient.mobility,
        accessNotes: trip.patient.accessNotes?.trim() || null,
        tripNotes: trip.notes?.trim() || null,
        facility:
          facilityStop && trip.facility
            ? { name: trip.facility.name, phone: trip.facility.phone, phoneHref: telHref(trip.facility.phone) }
            : null,
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

  const isDriver = route.driverId === driverId;
  const partner = isDriver ? route.crewMate : route.driver;
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
    vehicle: route.vehicle,
    startMinute: route.startMinute,
    endMinute: route.endMinute,
    distanceKm: route.distanceKm,
    plannedBreak,
    breakWindow,
    role: isDriver ? "DRIVER" : "CREW_MATE",
    partner: partner ? displayName(partner) : null,
    progress: routeProgress(like),
    stops,
    nextStop: stops.find((stop) => stop.isNext) ?? null,
    timeline: buildTimeline(
      stops.map((stop) => ({ ...stop, sequence: stop.position, startMinute: stop.plannedMinute })),
      route,
    ),
  };
}
