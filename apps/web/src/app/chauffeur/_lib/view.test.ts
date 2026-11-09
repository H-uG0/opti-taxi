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
  trip: {
    direction: TripDirection;
    status?: TripStatus;
    patient: string;
    appointmentMinute?: number;
    readyMinute?: number;
    payer?: "CPAM" | "PRIVATE";
    accessNotes?: string;
    facilityNotes?: string | null;
  },
  completedAt: string | null = null,
  /** Driver id of the account that recorded completedAt (null: a regulator, or not recorded). */
  completedByDriverId: string | null = null,
  /** Service time above the default 5 min (a lying patient, a wheelchair). */
  options: { extraServiceMin?: number } = {},
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
    // Planned 3 min of wait before each stop: arrival 477, start 480, departure after 5 min of service (485);
    // then +15 min per stop.
    arrivalMinute: 477 + sequence * 15,
    startMinute: 480 + sequence * 15,
    departureMinute: 485 + sequence * 15 + (options.extraServiceMin ?? 0),
    loadAfter: 0,
    completedAt: completedAt ? new Date(completedAt) : null,
    completedBy: completedAt ? { driverId: completedByDriverId } : null,
    trip: {
      direction: trip.direction,
      status: trip.status ?? "ASSIGNED",
      appointmentMinute: trip.appointmentMinute ?? null,
      readyMinute: trip.readyMinute ?? null,
      notes: null,
      payer: trip.payer ?? "CPAM",
      patientId: `patient_${tripId}`,
      recurrenceId: null,
      facilityId: "facility_1",
      patient: { firstName, lastName, phone: "06 12 34 56 78", mobility: "SEATED", accessNotes: trip.accessNotes ?? "  " },
      facility: { name: "Centre de dialyse du Prado", phone: "04 91 00 00 00", notes: trip.facilityNotes ?? null },
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
      depot: { name: "Dépôt Marseille", address: "1 bd du Dépôt, 13010 Marseille", lat: 43.28, lng: 5.42, notes: null },
    },
    driver: {
      firstName: "Karim",
      lastName: "Benali",
      phone: "06 11 22 33 44",
      breakMinutes: 45,
      breakWindowStartMinute: 720,
      breakWindowEndMinute: 840,
    },
    crewMate: { firstName: "Lucie", lastName: "Roux", phone: " 07 55 66 77 88 " },
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

    // 07:02 UTC is 08:02 in Paris (winter time): 3 min before the planned departure (08:05, patient on board).
    expect(aPickup).toMatchObject({ state: "done", completedMinute: 482, lateness: { minutes: -3, reference: "planned" } });
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

  it("gives the other crew member's phone to call them, none without a usable number or a crew mate", () => {
    expect(buildRouteView(sharedRoute(), DRIVER, true).partnerPhone).toEqual({ number: "07 55 66 77 88", href: "tel:0755667788" });
    expect(buildRouteView(sharedRoute(), CREW, true).partnerPhone).toEqual({ number: "06 11 22 33 44", href: "tel:0611223344" });
    const noPhone = makeRoute(sharedRoute().stops, { crewMate: { firstName: "Lucie", lastName: "Roux", phone: null } });
    expect(buildRouteView(noPhone, DRIVER, true).partnerPhone).toBeNull();
    const solo = makeRoute(sharedRoute().stops, { crewMateId: null, crewMate: null });
    expect(buildRouteView(solo, DRIVER, true).partnerPhone).toBeNull();
  });

  it("judges a recorded outbound dropoff against the appointment, any other stop against the planned time", () => {
    const route = makeRoute([
      // Appointment 540 (09:00), dropoff planned 495 (08:15), recorded 09:10 Paris: 10 min after the appointment.
      makeStop(0, "trip_a", "PICKUP", { ...A, status: "DROPPED_OFF" }, "2026-11-02T07:01:00Z"),
      makeStop(1, "trip_a", "DROPOFF", { ...A, status: "DROPPED_OFF" }, "2026-11-02T08:10:00Z"),
      makeStop(2, "trip_c", "PICKUP", { ...C, status: "DROPPED_OFF" }, "2026-11-02T07:50:00Z"),
      makeStop(3, "trip_c", "DROPOFF", { ...C, status: "DROPPED_OFF" }, "2026-11-02T08:10:00Z"),
    ]);
    const [pickup, dropoff, returnPickup, returnDropoff] = buildRouteView(route, DRIVER, true).stops;
    // A pickup is tapped with the patient on board: measured from its planned departure (08:05), shown next to the plan.
    expect(pickup).toMatchObject({ plannedMinute: 480, plannedDepartureMinute: 485, lateness: { minutes: -4, reference: "planned" } });
    expect(dropoff?.lateness).toEqual({ minutes: 10, reference: "appointment" });
    expect(dropoff?.plannedDepartureMinute).toBeNull();
    expect(returnPickup?.lateness).toEqual({ minutes: 15, reference: "planned" });
    expect(returnDropoff?.lateness).toEqual({ minutes: 25, reference: "planned" });
  });

  it("measures an absence from the planned start of the pickup", () => {
    const route = makeRoute([makeStop(0, "trip_a", "PICKUP", { ...A, status: "NO_SHOW" }, "2026-11-02T07:06:00Z")]);
    expect(buildRouteView(route, DRIVER, true).stops[0]).toMatchObject({
      plannedDepartureMinute: null,
      lateness: { minutes: 6, reference: "planned" },
    });
  });

  it("gives the next stop of today its live reading: the appointment and the arrival after the latest status", () => {
    const view = buildRouteView(sharedRoute(), DRIVER, true);
    const [aPickup, bPickup, aDropoff] = view.stops;
    // Latest status: A's pickup at 08:02, tapped with the patient on board (planned departure 08:05);
    // B's pickup is planned to be reached 7 min after that departure (492 - 485): 3 min early.
    expect(bPickup?.timing).toEqual({ appointmentMinute: null, anchorArrivalMinute: 482 + (492 - 485) });
    expect(aPickup?.timing).toBeNull();
    expect(aDropoff?.timing).toBeNull();

    // Next stop an outbound dropoff: judged against its appointment.
    const atDropoff = makeRoute([
      makeStop(0, "trip_a", "PICKUP", { ...A, status: "PICKED_UP" }, "2026-11-02T07:02:00Z"),
      makeStop(1, "trip_a", "DROPOFF", { ...A, status: "PICKED_UP" }),
    ]);
    expect(buildRouteView(atDropoff, DRIVER, true).stops[1]?.timing).toEqual({ appointmentMinute: 540, anchorArrivalMinute: 489 });

    // An ambulance pickup with 15 min of service (departure 08:15), tapped on time at 08:15: the next stop
    // is reached as planned, not 10 min late.
    const longService = makeRoute([
      makeStop(0, "trip_a", "PICKUP", { ...A, status: "PICKED_UP" }, "2026-11-02T07:15:00Z", null, { extraServiceMin: 10 }),
      makeStop(1, "trip_a", "DROPOFF", { ...A, status: "PICKED_UP" }),
    ]);
    const [, longDropoff] = buildRouteView(longService, DRIVER, true).stops;
    expect(longDropoff?.timing).toEqual({ appointmentMinute: 540, anchorArrivalMinute: 492 });
    expect(longDropoff?.plannedArrivalMinute).toBe(492);

    // After an absence (tapped at the planned start, after waiting), the anchor is the planned start.
    const afterNoShow = makeRoute([
      makeStop(0, "trip_a", "PICKUP", { ...A, status: "NO_SHOW" }, "2026-11-02T07:00:00Z"),
      makeStop(1, "trip_b", "PICKUP", B),
    ]);
    expect(buildRouteView(afterNoShow, DRIVER, true).stops[1]?.timing).toEqual({ appointmentMinute: null, anchorArrivalMinute: 492 });

    // Before any status: no anchor. Tomorrow (read-only): no live reading.
    const fresh = makeRoute([makeStop(0, "trip_b", "PICKUP", B), makeStop(1, "trip_b", "DROPOFF", B)]);
    expect(buildRouteView(fresh, DRIVER, true).stops[0]?.timing).toEqual({ appointmentMinute: null, anchorArrivalMinute: null });
    expect(buildRouteView(fresh, DRIVER, false).stops.every((stop) => stop.timing === null)).toBe(true);
  });

  it("links each dropoff to its trip's pickup on the route", () => {
    const view = buildRouteView(sharedRoute(), DRIVER, true);
    expect(view.stops.map((stop) => stop.pickupStopId)).toEqual([null, null, "stop_0", "stop_1", null, "stop_4"]);
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

  it("names the other crew member on the statuses they recorded", () => {
    const route = makeRoute([
      makeStop(0, "trip_a", "PICKUP", { ...A, status: "PICKED_UP" }, "2026-11-02T07:02:00Z", CREW),
      makeStop(1, "trip_b", "PICKUP", { ...B, status: "NO_SHOW" }, "2026-11-02T07:20:00Z", CREW),
      makeStop(2, "trip_a", "DROPOFF", { ...A, status: "DROPPED_OFF" }, "2026-11-02T07:40:00Z", DRIVER),
      makeStop(3, "trip_b", "DROPOFF", { ...B, status: "NO_SHOW" }),
      // Recorded before the author was kept, or by a regulator account (no driver link).
      makeStop(4, "trip_c", "PICKUP", { ...C, status: "PICKED_UP" }, "2026-11-02T09:35:00Z"),
      makeStop(5, "trip_c", "DROPOFF", C),
    ]);
    const asDriver = buildRouteView(route, DRIVER, true);
    expect(asDriver.stops.map((stop) => stop.recordedBy)).toEqual(["Lucie", "Lucie", null, null, null, null]);

    const asCrew = buildRouteView(route, CREW, true);
    expect(asCrew.stops.map((stop) => stop.recordedBy)).toEqual([null, null, "Karim", null, null, null]);
  });

  it("names nobody without a crew mate, nor on a status later cancelled by the regulator", () => {
    const solo = makeRoute(
      [makeStop(0, "trip_a", "PICKUP", { ...A, status: "PICKED_UP" }, "2026-11-02T07:02:00Z", CREW)],
      { crewMateId: null, crewMate: null },
    );
    expect(buildRouteView(solo, DRIVER, true).stops[0]?.recordedBy).toBeNull();

    const cancelled = makeRoute([makeStop(0, "trip_a", "PICKUP", { ...A, status: "CANCELLED" }, "2026-11-02T07:02:00Z", CREW)]);
    expect(buildRouteView(cancelled, DRIVER, true).stops[0]?.recordedBy).toBeNull();
  });

  it("ignores blank access notes", () => {
    const view = buildRouteView(sharedRoute(), DRIVER, true);
    expect(view.stops[0]?.accessNotes).toBeNull();
  });

  it("shows the home access notes at home and the facility's instructions at the care place", () => {
    const home = "Code 4521B, 2e étage\nAscenseur au fond de la cour";
    const care = "Entrée des transports par le parking arrière (portail B).";
    const leg = { ...A, accessNotes: home, facilityNotes: ` ${care} ` };
    const back = { ...C, accessNotes: home, facilityNotes: care };
    const view = buildRouteView(
      makeRoute([
        makeStop(0, "trip_a", "PICKUP", leg),
        makeStop(1, "trip_a", "DROPOFF", leg),
        makeStop(2, "trip_c", "PICKUP", back),
        makeStop(3, "trip_c", "DROPOFF", back),
      ]),
      DRIVER,
      true,
    );
    const [homePickup, careDropoff, carePickup, homeDropoff] = view.stops;

    expect(homePickup).toMatchObject({ accessNotes: home, facility: null });
    expect(careDropoff?.accessNotes).toBeNull();
    expect(careDropoff?.facility?.notes).toBe(care);
    expect(carePickup?.accessNotes).toBeNull();
    expect(carePickup?.facility?.notes).toBe(care);
    expect(homeDropoff).toMatchObject({ accessNotes: home, facility: null });
  });

  it("keeps the home access notes off a private client's free destination", () => {
    const station = { ...A, payer: "PRIVATE" as const, accessNotes: "Interphone « Martin »" };
    const view = buildRouteView(
      makeRoute([makeStop(0, "trip_a", "PICKUP", station), makeStop(1, "trip_a", "DROPOFF", station)]),
      DRIVER,
      true,
    );
    expect(view.stops.map((stop) => stop.accessNotes)).toEqual(["Interphone « Martin »", null]);
  });

  it("flags the private client's fare to collect on board, not a CPAM trip", () => {
    const view = buildRouteView(
      makeRoute([
        makeStop(0, "trip_a", "PICKUP", { ...A, payer: "PRIVATE" }),
        makeStop(1, "trip_b", "PICKUP", B),
        makeStop(2, "trip_a", "DROPOFF", { ...A, payer: "PRIVATE" }),
        makeStop(3, "trip_b", "DROPOFF", B),
      ]),
      DRIVER,
      true,
    );
    expect(view.stops.map((stop) => stop.payOnBoard)).toEqual([true, false, true, false]);
  });

  it("carries the depot's access notes, trimmed, for the departure and the return", () => {
    const depot = { name: "Dépôt Gap", address: "5 rue des Alpes, 05000 Gap", lat: 44.55, lng: 6.07 };
    const withNotes = makeRoute([], { vehicle: { ...makeRoute([]).vehicle, depot: { ...depot, notes: " Badge portail : 0425 \n" } } });
    expect(buildRouteView(withNotes, DRIVER, true).vehicle.depot.notes).toBe("Badge portail : 0425");
    const blank = makeRoute([], { vehicle: { ...makeRoute([]).vehicle, depot: { ...depot, notes: "   " } } });
    expect(buildRouteView(blank, DRIVER, true).vehicle.depot.notes).toBeNull();
  });
});
