import { describe, expect, it } from "vitest";
import type { StopKind, TripDirection, TripStatus } from "@prisma/client";
import type { DriverRoute, DriverRouteStop } from "./load";
import { buildRouteView } from "./view";

const DRIVER = "drv_1";
const CREW = "drv_2";

function makeStop(
  sequence: number,
  tripId: string,
  kind: StopKind,
  trip: { direction: TripDirection; status?: TripStatus; patient: string; appointmentMinute?: number; readyMinute?: number },
  completedAt: string | null = null,
): DriverRouteStop {
  const [firstName = "", lastName = ""] = trip.patient.split(" ");
  return {
    id: `stop_${sequence}`,
    sequence,
    kind,
    tripId,
    lat: 43.3 + sequence / 100,
    lng: 5.4,
    address: `${sequence} rue de Test, 13001 Marseille`,
    startMinute: 480 + sequence * 15,
    loadAfter: 0,
    completedAt: completedAt ? new Date(completedAt) : null,
    trip: {
      direction: trip.direction,
      status: trip.status ?? "ASSIGNED",
      appointmentMinute: trip.appointmentMinute ?? null,
      readyMinute: trip.readyMinute ?? null,
      notes: null,
      patientId: `patient_${tripId}`,
      recurrenceId: null,
      facilityId: "facility_1",
      patient: { firstName, lastName, phone: "06 12 34 56 78", mobility: "SEATED", accessNotes: "  " },
      facility: { name: "Centre de dialyse du Prado", phone: "04 91 00 00 00" },
    },
  };
}

function makeRoute(stops: DriverRouteStop[], overrides: Partial<DriverRoute> = {}): DriverRoute {
  return {
    id: "route_1",
    status: "PROPOSED",
    startMinute: 450,
    endMinute: 600,
    distanceKm: 41.3,
    breakStartMinute: null,
    breakEndMinute: null,
    driverId: DRIVER,
    crewMateId: CREW,
    vehicle: {
      label: "Taxi 1",
      registration: "AB-123-CD",
      type: "TAXI",
      depotLabel: "Dépôt Marseille",
      depotAddress: "1 bd du Dépôt, 13010 Marseille",
      depotLat: 43.28,
      depotLng: 5.42,
    },
    driver: { firstName: "Karim", lastName: "Benali", breakMinutes: 45, breakWindowStartMinute: 720, breakWindowEndMinute: 840 },
    crewMate: { firstName: "Lucie", lastName: "Roux" },
    stops,
    ...overrides,
  };
}

// A and B ride together to the facility (outbound); C comes back home (return).
const A = { direction: "OUTBOUND", patient: "Jeanne Martin", appointmentMinute: 540 } as const;
const B = { direction: "OUTBOUND", patient: "Paul Durand", appointmentMinute: 540 } as const;
const C = { direction: "RETURN", patient: "Rose Blanc", readyMinute: 570 } as const;

function sharedRoute(): DriverRoute {
  return makeRoute([
    makeStop(0, "trip_a", "PICKUP", { ...A, status: "PICKED_UP" }, "2026-11-02T07:02:00Z"),
    makeStop(1, "trip_b", "PICKUP", B),
    makeStop(2, "trip_a", "DROPOFF", { ...A, status: "PICKED_UP" }),
    makeStop(3, "trip_b", "DROPOFF", B),
    makeStop(4, "trip_c", "PICKUP", C),
    makeStop(5, "trip_c", "DROPOFF", C),
  ]);
}

describe("buildRouteView", () => {
  it("marks the recorded stop, the next stop and the buttons of each stop", () => {
    const view = buildRouteView(sharedRoute(), DRIVER, true);
    const [aPickup, bPickup, aDropoff, bDropoff] = view.stops;

    expect(aPickup).toMatchObject({ state: "done", completedMinute: 482, lateMinutes: 2 });
    expect(aPickup?.controls).toEqual({ primary: null, blockedReason: null, noShow: false, undo: true });
    expect(bPickup).toMatchObject({ isNext: true, state: "pending" });
    expect(bPickup?.controls).toMatchObject({ primary: "PICKUP", noShow: true });
    expect(aDropoff?.controls).toMatchObject({ primary: "DROPOFF", blockedReason: null });
    expect(bDropoff?.controls.blockedReason).not.toBeNull();
    expect(view.nextStop?.id).toBe("stop_1");
    expect(view.progress).toEqual({ closed: 1, total: 6 });
  });

  it("shows the facility, the appointment and the end of session only on facility stops", () => {
    const view = buildRouteView(sharedRoute(), DRIVER, true);
    const [aPickup, , aDropoff, , cPickup, cDropoff] = view.stops;

    expect(aPickup?.facility).toBeNull();
    expect(aPickup?.keyTime).toBeNull();
    expect(aDropoff?.facility?.name).toBe("Centre de dialyse du Prado");
    expect(aDropoff?.facility?.phoneHref).toBe("tel:0491000000");
    expect(aDropoff?.keyTime).toEqual({ label: "RDV", minute: 540 });
    expect(cPickup?.facility).not.toBeNull();
    expect(cPickup?.keyTime).toEqual({ label: "Fin de séance", minute: 570 });
    expect(cDropoff?.facility).toBeNull();
  });

  it("lists co-passengers and the real load after each stop", () => {
    const view = buildRouteView(sharedRoute(), DRIVER, true);
    expect(view.stops.map((stop) => stop.sharedWith)).toEqual([
      ["Paul DURAND"],
      ["Jeanne MARTIN"],
      ["Paul DURAND"],
      ["Jeanne MARTIN"],
      [],
      [],
    ]);
    expect(view.stops.map((stop) => stop.onBoardAfter)).toEqual([1, 2, 1, 0, 1, 0]);
  });

  it("drops an absent patient from the shared ride and skips the dropoff", () => {
    const route = makeRoute([
      makeStop(0, "trip_a", "PICKUP", { ...A, status: "NO_SHOW" }, "2026-11-02T07:02:00Z"),
      makeStop(1, "trip_b", "PICKUP", B),
      makeStop(2, "trip_a", "DROPOFF", { ...A, status: "NO_SHOW" }),
      makeStop(3, "trip_b", "DROPOFF", B),
    ]);
    const view = buildRouteView(route, DRIVER, true);
    expect(view.stops.map((stop) => stop.state)).toEqual(["no_show", "pending", "skipped", "pending"]);
    expect(view.stops[1]?.sharedWith).toEqual([]);
    expect(view.stops.map((stop) => stop.onBoardAfter)).toEqual([0, 1, 1, 0]);
    expect(view.stops[0]?.controls.undo).toBe(true);
  });

  it("is read-only outside the service day", () => {
    const view = buildRouteView(sharedRoute(), DRIVER, false);
    for (const stop of view.stops) {
      expect(stop.controls).toEqual({ primary: null, blockedReason: null, noShow: false, undo: false });
    }
  });

  it("names the other crew member and falls back to the driver's break window", () => {
    const asDriver = buildRouteView(sharedRoute(), DRIVER, true);
    expect(asDriver).toMatchObject({ role: "DRIVER", partner: "Lucie ROUX", plannedBreak: null });
    expect(asDriver.breakWindow).toEqual({ minutes: 45, startMinute: 720, endMinute: 840 });

    const asCrew = buildRouteView(sharedRoute(), CREW, true);
    expect(asCrew).toMatchObject({ role: "CREW_MATE", partner: "Karim BENALI" });
  });

  it("places the planned break in the timeline", () => {
    const view = buildRouteView(makeRoute(sharedRoute().stops, { breakStartMinute: 530, breakEndMinute: 545 }), DRIVER, true);
    expect(view.plannedBreak).toEqual({ startMinute: 530, endMinute: 545 });
    expect(view.breakWindow).toBeNull();
    // Stops start at 480, 495, 510, 525, 540, 555: the break goes before the 540 stop.
    expect(view.timeline.map((item) => (item.type === "stop" ? item.stop.position : item.type))).toEqual([
      "depart",
      1,
      2,
      3,
      4,
      "break",
      5,
      6,
      "return",
    ]);
  });

  it("warns on a return pickup still to do when the outbound leg was a no-show", () => {
    const flagged = new Set(["trip_c"]);
    const view = buildRouteView(sharedRoute(), DRIVER, true, flagged);
    // Only the return pickup (stop 5) carries the warning, not its dropoff.
    expect(view.stops.map((stop) => stop.outboundNoShow)).toEqual([false, false, false, false, true, false]);

    // Without the set (default), nothing is flagged.
    expect(buildRouteView(sharedRoute(), DRIVER, true).stops.some((stop) => stop.outboundNoShow)).toBe(false);

    // Once the return pickup is closed (here: also absent), the warning goes away.
    const closed = makeRoute([
      makeStop(0, "trip_c", "PICKUP", { ...C, status: "NO_SHOW" }, "2026-11-02T09:35:00Z"),
      makeStop(1, "trip_c", "DROPOFF", { ...C, status: "NO_SHOW" }),
    ]);
    expect(buildRouteView(closed, DRIVER, true, flagged).stops.some((stop) => stop.outboundNoShow)).toBe(false);
  });

  it("ignores blank access notes", () => {
    const view = buildRouteView(sharedRoute(), DRIVER, true);
    expect(view.stops[0]?.accessNotes).toBeNull();
  });
});
