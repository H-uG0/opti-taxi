import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { OptimizeRequest, PlanResponse, PlanRoute, TripResult } from "@/lib/optimizer/contract";
import type { RouteRow } from "@/lib/optimizer/persist";
import {
  buildEvaluateRequest,
  decodeRefresh,
  encodeRefresh,
  isDayStarted,
  isStopDone,
  NOTHING_REFRESHED,
  planRefresh,
  refreshAdvice,
  refreshCallsForReoptimization,
  refreshNotice,
  refreshRoutes,
  relevantViolations,
  routeRefresh,
  sameStops,
  withRefreshNotice,
  type EvaluateResult,
  type RefreshOutcome,
  type RefreshTrip,
  type StoredRoute,
} from "./refresh-routes";

const NOW = new Date("2026-11-02T09:00:00Z");
const DONE_AT = new Date("2026-11-02T06:45:00Z");

type Kind = "PICKUP" | "DROPOFF";

/**
 * Stored route `id` of `vehicleId`; stops given as [tripId, kind], sequence =
 * position, times as planRoute evaluates them (start 420 + 20 per stop).
 */
function stored(id: string, vehicleId: string, stops: [string, Kind][], startMinute = 400): StoredRoute {
  return {
    id,
    vehicleId,
    startMinute,
    breakStartMinute: null,
    breakEndMinute: null,
    stops: stops.map(([tripId, kind], sequence) => ({
      id: `${id}-${tripId}-${kind}`,
      tripId,
      kind,
      sequence,
      arrivalMinute: 417 + 20 * sequence,
      startMinute: 420 + 20 * sequence,
      departureMinute: 425 + 20 * sequence,
      completedAt: null,
    })),
  };
}

/** Evaluated route: stops 20 min apart from 420, loads from the sequence. */
function planRoute(vehicleId: string, stops: [string, Kind][], overrides: Partial<PlanRoute> = {}): PlanRoute {
  const onBoard = new Set<string>();
  return {
    vehicleId,
    startMin: 405,
    endMin: 600,
    distanceKm: 42.5,
    emptyKm: 12.25,
    loadedKm: 30.25,
    durationMin: 195,
    revenue: 61.4,
    cost: 92.1,
    margin: -30.7,
    break: null,
    stops: stops.map(([tripId, kind], i) => {
      if (kind === "PICKUP") onBoard.add(tripId);
      else onBoard.delete(tripId);
      const minute = 420 + 20 * i;
      return {
        tripId,
        kind,
        location: { lat: 43.3, lng: 5.4 },
        arrivalMin: minute - 3,
        startMin: minute,
        departureMin: minute + 5,
        loadAfter: onBoard.size,
      };
    }),
    ...overrides,
  };
}

function tripResult(tripId: string, overrides: Partial<TripResult> = {}): TripResult {
  return {
    tripId,
    vehicleId: "veh_1",
    pickupMin: 420,
    dropoffMin: 440,
    shared: false,
    coPassengerTripIds: [],
    directKm: 12.4,
    rideKm: 12.4,
    detourKm: 0,
    revenue: 27.5,
    waitAtFacilityMin: 10,
    ...overrides,
  };
}

function response(routes: PlanRoute[], trips: TripResult[], violations: PlanResponse["validation"]["violations"] = []): PlanResponse {
  return {
    status: "OK",
    routes,
    trips,
    unassigned: [],
    kpis: {
      tripsTotal: trips.length,
      tripsServed: trips.length,
      tripsUnassigned: 0,
      vehiclesUsed: routes.length,
      tripsPerVehicle: 1,
      totalKm: 0,
      emptyKm: 0,
      emptyKmRatio: 0,
      sharedTrips: 0,
      sharedTripRatio: 0,
      revenue: 0,
      cost: 0,
      margin: 0,
    },
    validation: { valid: violations.length === 0, violations },
    meta: { matrixSource: "haversine", trafficSource: "none", solverStatus: "EVALUATE", objective: null, wallTimeMs: 12, warnings: [] },
  };
}

function refreshTrip(id: string, routeId: string | null, overrides: Partial<RefreshTrip> = {}): RefreshTrip {
  return {
    id,
    status: "ASSIGNED",
    sharingStatus: "NOT_PROPOSED",
    pickupAddress: `Domicile ${id}`,
    dropoffAddress: `Soins ${id}`,
    routeId,
    ...overrides,
  };
}

const VEHICLES = [
  { id: "veh_1", type: "TAXI" as const, costPerHour: 24 },
  { id: "veh_2", type: "VSL" as const, costPerHour: 30 },
];

function optimizeRequest(trips: { id: string; patientId: string }[] = []): OptimizeRequest {
  return {
    date: "2026-11-02",
    settings: {
      waitBeforeAppointmentMin: 30,
      waitAfterSessionMin: 15,
      maxTotalWaitMin: 45,
      maxDetourKmPerExtraPatient: 10,
      maxDetourKmTotal: 30,
      pickupServiceMin: 5,
      dropoffServiceMin: 5,
      unassignedPenalty: 10000,
      timeLimitSec: 10,
    },
    vehicles: [],
    trips: trips.map(({ id, patientId }) => ({
      id,
      patientId,
      facilityId: null,
      direction: "OUTBOUND",
      pickup: { lat: 43.3, lng: 5.4 },
      dropoff: { lat: 43.5, lng: 5.4 },
      appointmentMin: 540,
      readyMin: null,
      allowedVehicleTypes: ["TAXI"],
      shareable: true,
      lockedVehicleId: null,
    })),
    tariffs: [],
  };
}

function outcome(overrides: Partial<RefreshOutcome>): RefreshOutcome {
  return { ...NOTHING_REFRESHED, ...overrides };
}

describe("buildEvaluateRequest", () => {
  it("adds the stored sequence of every route of the day, in stop order, to the day's request", () => {
    const base = optimizeRequest();
    const shuffled = stored("r1", "veh_1", [
      ["A", "PICKUP"],
      ["B", "PICKUP"],
      ["A", "DROPOFF"],
    ]);
    shuffled.stops.reverse();
    const request = buildEvaluateRequest(base, [shuffled, stored("r2", "veh_2", [["C", "PICKUP"], ["C", "DROPOFF"]]), stored("r3", "veh_3", [])]);
    expect(request).toEqual({
      ...base,
      routes: [
        {
          vehicleId: "veh_1",
          stops: [
            { tripId: "A", kind: "PICKUP" },
            { tripId: "B", kind: "PICKUP" },
            { tripId: "A", kind: "DROPOFF" },
          ],
        },
        { vehicleId: "veh_2", stops: [{ tripId: "C", kind: "PICKUP" }, { tripId: "C", kind: "DROPOFF" }] },
      ],
    });
  });
});

describe("sameStops", () => {
  const before = stored("r1", "veh_1", [
    ["A", "PICKUP"],
    ["A", "DROPOFF"],
  ]);

  it("accepts the same stops listed in another order", () => {
    expect(sameStops(before, { ...before, stops: [...before.stops].reverse() })).toBe(true);
  });

  it("rejects a route whose stops were removed or renumbered meanwhile", () => {
    expect(sameStops(before, { ...before, stops: before.stops.slice(1) })).toBe(false);
    expect(sameStops(before, { ...before, stops: before.stops.map((s) => ({ ...s, sequence: s.sequence + 1 })) })).toBe(false);
  });
});

describe("isStopDone", () => {
  it("is done when recorded by the crew, or implied by the trip's field status", () => {
    expect(isStopDone({ kind: "DROPOFF", completedAt: DONE_AT }, "ASSIGNED")).toBe(true);
    expect(isStopDone({ kind: "PICKUP", completedAt: null }, "PICKED_UP")).toBe(true);
    expect(isStopDone({ kind: "DROPOFF", completedAt: null }, "PICKED_UP")).toBe(false);
    expect(isStopDone({ kind: "DROPOFF", completedAt: null }, "DROPPED_OFF")).toBe(true);
    expect(isStopDone({ kind: "PICKUP", completedAt: null }, "ASSIGNED")).toBe(false);
    expect(isStopDone({ kind: "PICKUP", completedAt: null }, undefined)).toBe(false);
  });
});

describe("isDayStarted", () => {
  it("is started once a stop is done or a trip picked up", () => {
    const route = stored("r1", "veh_1", [["A", "PICKUP"], ["A", "DROPOFF"]]);
    expect(isDayStarted([route], ["ASSIGNED", "PLANNED"])).toBe(false);
    expect(isDayStarted([route], ["ASSIGNED", "PICKED_UP"])).toBe(true);
    expect(isDayStarted([{ stops: [{ completedAt: DONE_AT }] }], [])).toBe(true);
  });
});

describe("routeRefresh", () => {
  const route = stored("r1", "veh_1", [
    ["B", "PICKUP"],
    ["B", "DROPOFF"],
  ]);
  const row: RouteRow = {
    vehicleId: "veh_1",
    driverId: "drv_9",
    crewMateId: null,
    startMinute: 405,
    endMinute: 560,
    distanceKm: 30.5,
    emptyKm: 10.25,
    revenue: 27.5,
    cost: 70.2,
    margin: -42.7,
    breakStartMinute: 700,
    breakEndMinute: 745,
    stops: [
      { sequence: 0, tripId: "B", kind: "PICKUP", lat: 0, lng: 0, address: "x", arrivalMinute: 417, startMinute: 420, departureMinute: 425, loadAfter: 1 },
      { sequence: 1, tripId: "B", kind: "DROPOFF", lat: 0, lng: 0, address: "y", arrivalMinute: 450, startMinute: 450, departureMinute: 455, loadAfter: 0 },
    ],
  };

  it("takes the totals and break of the evaluated route and each stop's times and load, never its crew nor positions", () => {
    expect(routeRefresh(route, row)).toEqual({
      routeId: "r1",
      data: {
        startMinute: 405,
        endMinute: 560,
        distanceKm: 30.5,
        emptyKm: 10.25,
        revenue: 27.5,
        cost: 70.2,
        margin: -42.7,
        breakStartMinute: 700,
        breakEndMinute: 745,
      },
      stops: [
        { id: "r1-B-PICKUP", data: { arrivalMinute: 417, startMinute: 420, departureMinute: 425, loadAfter: 1 } },
        { id: "r1-B-DROPOFF", data: { arrivalMinute: 450, startMinute: 450, departureMinute: 455, loadAfter: 0 } },
      ],
      keptStops: [],
    });
  });

  it("keeps the stored values when the evaluation does not hold the same stops in the same order", () => {
    expect(routeRefresh(route, undefined)).toBeNull();
    expect(routeRefresh(route, { ...row, stops: row.stops.slice(0, 1) })).toBeNull();
    expect(routeRefresh(route, { ...row, stops: [...row.stops].reverse() })).toBeNull();
  });

  it("zeroes a route left without stops", () => {
    expect(routeRefresh(stored("r9", "veh_2", [], 380), undefined)).toEqual({
      routeId: "r9",
      data: {
        startMinute: 380,
        endMinute: 380,
        distanceKm: 0,
        emptyKm: 0,
        revenue: 0,
        cost: 0,
        margin: 0,
        breakStartMinute: null,
        breakEndMinute: null,
      },
      stops: [],
      keptStops: [],
    });
  });
});

describe("routeRefresh on a route the crew has started", () => {
  // A (picked up, stop done at 402-407) then C; B, between them, was cancelled.
  // /evaluate re-times everything from the depot: A's pick-up would move to 412-417.
  const started: StoredRoute = {
    id: "r1",
    vehicleId: "veh_1",
    startMinute: 400,
    breakStartMinute: null,
    breakEndMinute: null,
    stops: [
      { id: "s-A+", tripId: "A", kind: "PICKUP", sequence: 0, arrivalMinute: 402, startMinute: 402, departureMinute: 407, completedAt: DONE_AT },
      { id: "s-A-", tripId: "A", kind: "DROPOFF", sequence: 1, arrivalMinute: 440, startMinute: 440, departureMinute: 445, completedAt: null },
      { id: "s-C+", tripId: "C", kind: "PICKUP", sequence: 2, arrivalMinute: 470, startMinute: 470, departureMinute: 475, completedAt: null },
      { id: "s-C-", tripId: "C", kind: "DROPOFF", sequence: 3, arrivalMinute: 500, startMinute: 500, departureMinute: 505, completedAt: null },
    ],
  };
  const stop = (sequence: number, tripId: string, kind: Kind, start: number, loadAfter: number) => ({
    sequence,
    tripId,
    kind,
    lat: 0,
    lng: 0,
    address: "x",
    arrivalMinute: start,
    startMinute: start,
    departureMinute: start + 5,
    loadAfter,
  });
  const evaluated: RouteRow = {
    vehicleId: "veh_1",
    driverId: null,
    crewMateId: null,
    startMinute: 410,
    endMinute: 520,
    distanceKm: 40,
    emptyKm: 12,
    revenue: 60,
    cost: 56,
    margin: 4,
    breakStartMinute: null,
    breakEndMinute: null,
    stops: [stop(0, "A", "PICKUP", 412, 1), stop(1, "A", "DROPOFF", 420, 0), stop(2, "C", "PICKUP", 450, 1), stop(3, "C", "DROPOFF", 480, 0)],
  };
  const statusOf = (tripId: string) => (tripId === "A" ? ("PICKED_UP" as const) : ("ASSIGNED" as const));

  it("keeps the departure and the stops done as planned, takes the following stops and the totals", () => {
    const refresh = routeRefresh(started, evaluated, statusOf, 24);
    expect(refresh).toEqual({
      routeId: "r1",
      data: {
        startMinute: 400,
        endMinute: 520,
        distanceKm: 40,
        emptyKm: 12,
        revenue: 60,
        // 10 more minutes than evaluated (departure kept at 400) at 24 €/h.
        cost: 60,
        margin: 0,
        breakStartMinute: null,
        breakEndMinute: null,
      },
      stops: [
        { id: "s-A-", data: { arrivalMinute: 420, startMinute: 420, departureMinute: 425, loadAfter: 0 } },
        { id: "s-C+", data: { arrivalMinute: 450, startMinute: 450, departureMinute: 455, loadAfter: 1 } },
        { id: "s-C-", data: { arrivalMinute: 480, startMinute: 480, departureMinute: 485, loadAfter: 0 } },
      ],
      keptStops: ["A/PICKUP"],
    });
  });

  it("keeps every stop up to the last one done, even one skipped before it", () => {
    const outOfOrder: StoredRoute = {
      ...started,
      // C picked up before A was dropped off (stop done at 445-450).
      stops: started.stops.map((s) =>
        s.id === "s-C+" ? { ...s, arrivalMinute: 445, startMinute: 445, departureMinute: 450, completedAt: DONE_AT } : s,
      ),
    };
    const refresh = routeRefresh(outOfOrder, evaluated, () => "ASSIGNED", 24);
    expect(refresh?.keptStops).toEqual(["A/PICKUP", "A/DROPOFF", "C/PICKUP"]);
    expect(refresh?.stops.map((s) => s.id)).toEqual(["s-C-"]);
  });

  it("is not recomputed when the evaluation leaves the last stop done earlier than planned", () => {
    const earlier: RouteRow = { ...evaluated, stops: [stop(0, "A", "PICKUP", 395, 1), ...evaluated.stops.slice(1)] };
    expect(routeRefresh(started, earlier, statusOf, 24)).toBeNull();
  });

  it("takes a break still to come, keeps a break already behind, and gives up on a break moved among the stops done", () => {
    const later = { ...evaluated, breakStartMinute: 700, breakEndMinute: 745 };
    expect(routeRefresh(started, later, statusOf, 24)?.data).toMatchObject({ breakStartMinute: 700, breakEndMinute: 745 });

    const behind: StoredRoute = { ...started, breakStartMinute: 360, breakEndMinute: 400 };
    // Evaluated before the depot departure too, or not placed at all: the stored one stays.
    expect(routeRefresh(behind, { ...evaluated, breakStartMinute: 365, breakEndMinute: 410 }, statusOf, 24)?.data).toMatchObject({
      breakStartMinute: 360,
      breakEndMinute: 400,
    });
    expect(routeRefresh(behind, evaluated, statusOf, 24)?.data).toMatchObject({ breakStartMinute: 360, breakEndMinute: 400 });

    // Planned later, but evaluated among the stops done: cannot be reconciled.
    const ahead: StoredRoute = { ...started, breakStartMinute: 700, breakEndMinute: 745 };
    expect(routeRefresh(ahead, { ...evaluated, breakStartMinute: 365, breakEndMinute: 410 }, statusOf, 24)).toBeNull();
    // Planned later and no longer placed by the evaluation: dropped.
    expect(routeRefresh(ahead, evaluated, statusOf, 24)?.data).toMatchObject({ breakStartMinute: null, breakEndMinute: null });
  });
});

describe("planRefresh", () => {
  // A was cancelled: B (its co-passenger) now rides alone on veh_1; veh_2's route is not concerned.
  const affected = stored("r1", "veh_1", [
    ["B", "PICKUP"],
    ["B", "DROPOFF"],
    ["C", "PICKUP"],
    ["C", "DROPOFF"],
  ]);
  const evaluation = response(
    [
      planRoute("veh_1", [
        ["B", "PICKUP"],
        ["B", "DROPOFF"],
        ["C", "PICKUP"],
        ["C", "DROPOFF"],
      ]),
      planRoute("veh_2", [
        ["D", "PICKUP"],
        ["D", "DROPOFF"],
      ]),
    ],
    [
      tripResult("B", { pickupMin: 420, dropoffMin: 440, directKm: 12.4, detourKm: 0, revenue: 27.5 }),
      tripResult("C", { pickupMin: 460, dropoffMin: 480, revenue: 31 }),
      tripResult("D", { vehicleId: "veh_2" }),
    ],
  );

  it("rewrites the route and the results of its trips, withdrawing a sharing proposal that no longer holds", () => {
    const trips = new Map([
      ["B", refreshTrip("B", "r1", { sharingStatus: "PROPOSED", status: "ASSIGNED" })],
      ["C", refreshTrip("C", "r1", { sharingStatus: "ACCEPTED", status: "ASSIGNED" })],
    ]);
    const plan = planRefresh([affected], evaluation, VEHICLES, trips, NOW);

    expect(plan.keptRouteIds).toEqual([]);
    expect(plan.routes).toHaveLength(1);
    expect(plan.routes[0]).toMatchObject({
      routeId: "r1",
      data: { startMinute: 405, endMinute: 600, distanceKm: 42.5, emptyKm: 12.25, revenue: 61.4, cost: 92.1, margin: -30.7 },
    });
    expect(plan.routes[0]?.stops.map((s) => [s.id, s.data.startMinute, s.data.loadAfter])).toEqual([
      ["r1-B-PICKUP", 420, 1],
      ["r1-B-DROPOFF", 440, 0],
      ["r1-C-PICKUP", 460, 1],
      ["r1-C-DROPOFF", 480, 0],
    ]);

    expect(plan.trips).toEqual([
      {
        tripId: "B",
        routeId: "r1",
        sharingStatus: "PROPOSED",
        data: {
          plannedPickupMinute: 420,
          plannedDropoffMinute: 440,
          shared: false,
          directKm: 12.4,
          detourKm: 0,
          estimatedRevenue: 27.5,
          sharingStatus: "NOT_PROPOSED",
          sharingProposedAt: null,
        },
      },
      {
        // The patient's answer stays.
        tripId: "C",
        routeId: "r1",
        sharingStatus: "ACCEPTED",
        data: {
          plannedPickupMinute: 460,
          plannedDropoffMinute: 480,
          shared: false,
          directKm: 12.4,
          detourKm: 0,
          estimatedRevenue: 31,
        },
      },
    ]);
    for (const trip of plan.trips) expect(trip.data).not.toHaveProperty("status");
  });

  it("keeps the planned minutes of the stops the crew has done, and the route's departure", () => {
    const startedRoute: StoredRoute = {
      ...affected,
      // C is picked up (stop done); B, before it, is dropped off.
      stops: affected.stops.map((s) => (s.tripId === "B" || s.kind === "PICKUP" ? { ...s, completedAt: DONE_AT } : s)),
    };
    const trips = new Map([
      ["B", refreshTrip("B", "r1", { status: "DROPPED_OFF" })],
      ["C", refreshTrip("C", "r1", { status: "PICKED_UP" })],
    ]);
    const plan = planRefresh([startedRoute], evaluation, VEHICLES, trips, NOW);

    expect(plan.keptRouteIds).toEqual([]);
    expect(plan.routes[0]?.data.startMinute).toBe(400);
    expect(plan.routes[0]?.stops.map((s) => s.id)).toEqual(["r1-C-DROPOFF"]);
    expect(plan.trips.map((t) => [t.tripId, t.data])).toEqual([
      ["B", { shared: false, directKm: 12.4, detourKm: 0, estimatedRevenue: 27.5 }],
      ["C", { plannedDropoffMinute: 480, shared: false, directKm: 12.4, detourKm: 0, estimatedRevenue: 31 }],
    ]);
  });

  it("keeps a trip still shared shared, and proposes the sharing like the planner does", () => {
    const route = stored("r1", "veh_1", [
      ["B", "PICKUP"],
      ["C", "PICKUP"],
      ["B", "DROPOFF"],
      ["C", "DROPOFF"],
    ]);
    const shared = response(
      [
        planRoute("veh_1", [
          ["B", "PICKUP"],
          ["C", "PICKUP"],
          ["B", "DROPOFF"],
          ["C", "DROPOFF"],
        ]),
      ],
      [tripResult("B", { shared: true, coPassengerTripIds: ["C"], detourKm: 1.5, revenue: 21.2 }), tripResult("C", { shared: true, coPassengerTripIds: ["B"] })],
    );
    const plan = planRefresh(
      [route],
      shared,
      VEHICLES,
      new Map([
        ["B", refreshTrip("B", "r1")],
        ["C", refreshTrip("C", "r1", { sharingStatus: "PROPOSED" })],
      ]),
      NOW,
    );
    expect(plan.trips.map((t) => [t.tripId, t.data.shared, t.data.detourKm, t.data.sharingStatus])).toEqual([
      ["B", true, 1.5, "PROPOSED"],
      ["C", true, 0, undefined],
    ]);
    expect(plan.trips[0]?.data.sharingProposedAt).toEqual(NOW);
  });

  it("keeps a route the evaluation does not describe, and leaves alone a trip moved to another route", () => {
    const missing = stored("r2", "veh_3", [
      ["E", "PICKUP"],
      ["E", "DROPOFF"],
    ]);
    const plan = planRefresh(
      [affected, missing],
      evaluation,
      VEHICLES,
      new Map([
        ["B", refreshTrip("B", "r1")],
        ["C", refreshTrip("C", "r7")],
        ["E", refreshTrip("E", "r2")],
      ]),
      NOW,
    );
    expect(plan.keptRouteIds).toEqual(["r2"]);
    expect(plan.routes.map((r) => r.routeId)).toEqual(["r1"]);
    expect(plan.trips.map((t) => t.tripId)).toEqual(["B"]);
  });

  it("keeps a route holding the stop of a trip cancelled meanwhile, or of a patient absent", () => {
    for (const status of ["CANCELLED", "NO_SHOW"] as const) {
      const plan = planRefresh(
        [affected],
        evaluation,
        VEHICLES,
        new Map([
          ["B", refreshTrip("B", "r1")],
          ["C", refreshTrip("C", "r1", { status })],
        ]),
        NOW,
      );
      expect(plan).toEqual({ routes: [], trips: [], keptRouteIds: ["r1"] });
    }
  });
});

describe("relevantViolations", () => {
  const request = optimizeRequest([
    { id: "B", patientId: "pat_1" },
    { id: "B_ret", patientId: "pat_1" },
    { id: "D", patientId: "pat_2" },
  ]);
  const violations: PlanResponse["validation"]["violations"] = [
    { code: "BREAK", message: "pause", tripId: null, vehicleId: "veh_1" },
    { code: "TIME_WINDOW", message: "retard", tripId: "B", vehicleId: null },
    { code: "TOTAL_WAIT", message: "attente", tripId: "B_ret", vehicleId: "veh_2" },
    { code: "TIME_WINDOW", message: "retard ailleurs", tripId: "B_ret", vehicleId: "veh_2" },
    { code: "SHIFT", message: "autre tournée", tripId: null, vehicleId: "veh_2" },
    { code: "UNKNOWN_REFERENCE", message: "inconnu", tripId: "D", vehicleId: "veh_2" },
  ];

  it("keeps the violations of the recomputed routes and the total wait of their patients", () => {
    const kept = relevantViolations(response([], [], violations), request, new Set(["veh_1"]), new Set(["B"]));
    expect(kept.map((v) => v.message)).toEqual(["pause", "retard", "attente"]);
  });
});

describe("refreshNotice and refreshAdvice", () => {
  it("say nothing when no route was concerned", () => {
    expect(refreshNotice(NOTHING_REFRESHED)).toBe("");
    expect(refreshAdvice(NOTHING_REFRESHED)).toBe("");
    expect(refreshCallsForReoptimization(NOTHING_REFRESHED)).toBe(false);
  });

  it("report a recomputed route, with nothing left to do", () => {
    const done = outcome({ refreshed: 1 });
    expect(refreshNotice(done)).toBe("Horaires et totaux de la tournée recalculés.");
    expect(refreshAdvice(done)).toBe("");
    expect(refreshCallsForReoptimization(done)).toBe(false);
  });

  it("report the rules the recomputed routes break without blaming the change for them", () => {
    const broken = outcome({ refreshed: 1, violations: 1 });
    expect(refreshNotice(broken)).toBe("Horaires et totaux de la tournée recalculés ; 1 contrainte n'est pas respectée.");
    expect(refreshNotice({ ...broken, refreshed: 2, violations: 3 })).toBe(
      "Horaires et totaux de 2 tournées recalculés ; 3 contraintes ne sont pas respectées.",
    );
    expect(refreshAdvice(broken)).toBe("Réoptimisez le planning.");
    expect(refreshCallsForReoptimization(broken)).toBe(true);
  });

  it("announce the update at the next optimization when the optimizer is unavailable or failed", () => {
    const down = outcome({ kept: 1, unavailable: true });
    expect(refreshNotice(down)).toBe(
      "Les horaires et totaux de la tournée seront mis à jour à la prochaine optimisation (service d'optimisation indisponible).",
    );
    expect(refreshNotice({ ...down, kept: 3 })).toBe(
      "Les horaires et totaux des 3 tournées concernées seront mis à jour à la prochaine optimisation (service d'optimisation indisponible).",
    );
    expect(refreshNotice(outcome({ kept: 1, failed: true }))).toBe(
      "Les horaires et totaux de la tournée n'ont pas pu être recalculés : ils seront mis à jour à la prochaine optimisation.",
    );
    expect(refreshAdvice(down)).toBe("Réoptimisez le planning.");
    expect(refreshCallsForReoptimization(down)).toBe(true);
  });

  it("report a partial recomputation", () => {
    expect(refreshNotice(outcome({ refreshed: 1, kept: 1 }))).toBe(
      "Horaires et totaux de 1 tournée recalculés. Les horaires et totaux d'une autre tournée seront mis à jour à la prochaine optimisation.",
    );
  });

  it("promise no re-optimization on a day under way", () => {
    const kept = outcome({ kept: 1, dayStarted: true });
    expect(refreshNotice(kept)).toBe(
      "Les horaires et totaux de la tournée n'ont pas pu être recalculés : ils restent ceux du dernier calcul, la journée ayant commencé.",
    );
    expect(refreshNotice({ ...kept, unavailable: true })).toBe(
      "Les horaires et totaux de la tournée n'ont pas pu être recalculés (service d'optimisation indisponible) : ils restent ceux du dernier calcul, la journée ayant commencé.",
    );
    expect(refreshAdvice(kept)).toBe("Prévenez le chauffeur.");
    expect(refreshCallsForReoptimization(kept)).toBe(false);

    const broken = outcome({ refreshed: 1, violations: 2, dayStarted: true });
    expect(refreshAdvice(broken)).toBe("Vérifiez la tournée dans le planning et prévenez le chauffeur.");
    expect(refreshCallsForReoptimization(broken)).toBe(false);
    expect(refreshAdvice(outcome({ refreshed: 1, dayStarted: true }))).toBe("");
  });
});

describe("encodeRefresh / decodeRefresh / withRefreshNotice", () => {
  it("carry the outcome across a redirect", () => {
    const all = outcome({ refreshed: 2, kept: 1, violations: 3, unavailable: true, failed: true, dayStarted: true });
    expect(encodeRefresh(all)).toBe("2-1-3-7");
    expect(decodeRefresh("2-1-3-7")).toEqual(all);
    expect(decodeRefresh(encodeRefresh(outcome({ kept: 1, unavailable: true })))).toEqual(outcome({ kept: 1, unavailable: true }));
    expect(decodeRefresh(encodeRefresh(outcome({ refreshed: 1 })))).toEqual(outcome({ refreshed: 1 }));
  });

  it("carry nothing when no route was concerned, and reject anything else", () => {
    expect(encodeRefresh(NOTHING_REFRESHED)).toBeNull();
    expect(decodeRefresh("0-0-0-0")).toBeNull();
    expect(decodeRefresh("1-0-0-8")).toBeNull();
    expect(decodeRefresh("abc")).toBeNull();
    expect(decodeRefresh(undefined)).toBeNull();
  });

  it("add the parameter before the fragment, after any other parameter", () => {
    const one = outcome({ refreshed: 1 });
    expect(withRefreshNotice("/patients/x", one)).toBe("/patients/x?tournees=1-0-0-0");
    expect(withRefreshNotice("/patients/x?courses=0-1-1-0#recurrences", one)).toBe(
      "/patients/x?courses=0-1-1-0&tournees=1-0-0-0#recurrences",
    );
    expect(withRefreshNotice("/patients/x#prescriptions", NOTHING_REFRESHED)).toBe("/patients/x#prescriptions");
  });
});

// ---------------------------------------------------------------------------
// refreshRoutes, against an in-memory stand-in of the Prisma client
// ---------------------------------------------------------------------------

type FakeRoute = StoredRoute & { serviceDate: Date };

const SETTINGS_ROW = {
  id: 1,
  waitBeforeAppointmentMin: 30,
  waitAfterSessionMin: 15,
  maxTotalWaitMin: 45,
  maxDetourKmPerExtraPatient: 10,
  maxDetourKmTotal: 30,
  pickupServiceMin: 5,
  dropoffServiceMin: 5,
  unassignedPenalty: 10000,
  solverTimeLimitSec: 10,
  regulatorPhone: null,
  updatedAt: NOW,
};

function driver(id: string) {
  return {
    id,
    firstName: "Chauffeur",
    lastName: id,
    active: true,
    workDays: [1, 2, 3, 4, 5],
    shiftStartMinute: 360,
    shiftEndMinute: 1140,
    breakWindowStartMinute: null,
    breakWindowEndMinute: null,
    breakMinutes: 0,
    hourlyCost: 24,
    // Read by the crews of the day (lib/staff/day-crews.ts): qualified for every seat.
    qualifications: ["TAXI_CARD", "DEA"] as ("TAXI_CARD" | "DEA")[],
    depotId: "depot_1",
  };
}

/**
 * Vehicles working on Monday 2026-11-02: VehicleInput of build-request.ts, plus
 * the fields the crews of the day read (depot, default crew ids).
 */
const VEHICLE_ROWS = VEHICLES.map(({ id, type }) => ({
  id,
  label: id,
  type,
  capacity: 2,
  depot: { lat: 43.3, lng: 5.4 },
  depotId: "depot_1",
  department: "13",
  costPerKm: 0.3,
  active: true,
  defaultDriver: driver(`drv_${id}`),
  defaultDriverId: `drv_${id}`,
  defaultCrewMate: null,
  defaultCrewMateId: null,
}));

type Where = { id?: string | { in: string[] }; serviceDate?: Date };

function fakePrisma(routes: FakeRoute[], trips: RefreshTrip[]) {
  const writes: { model: string; where: unknown; data: unknown }[] = [];
  const locks: string[] = [];
  // Plan version of the day (lib/planning/version.ts): bumped by a test to simulate a concurrent change.
  const version = { changes: 0 };
  const matches = (route: FakeRoute, where: Where) =>
    (where.serviceDate === undefined || route.serviceDate.getTime() === where.serviceDate.getTime()) &&
    (where.id === undefined || (typeof where.id === "string" ? route.id === where.id : where.id.in.includes(route.id)));
  const client = {
    appSettings: { upsert: async () => SETTINGS_ROW },
    trafficZone: { findMany: async () => [], createMany: async () => ({ count: 0 }) },
    vehicle: { findMany: async () => VEHICLE_ROWS },
    driver: { findMany: async () => VEHICLE_ROWS.map((v) => v.defaultDriver) },
    staffAbsence: { findMany: async () => [] },
    crewIncompatibility: { findMany: async () => [] },
    dayCrew: { findMany: async () => [] },
    vehicleUnavailability: { findMany: async () => [] },
    maintenanceDeadline: { findMany: async () => [] },
    fuelLog: { groupBy: async () => [] },
    tariffGrid: { findMany: async () => [] },
    route: {
      findMany: async ({ where }: { where: Where }) => routes.filter((r) => matches(r, where)).map((r) => ({ ...r, stops: [...r.stops] })),
      update: async (args: { where: unknown; data: unknown }) => writes.push({ model: "route", ...args }),
    },
    routeStop: { update: async (args: { where: unknown; data: unknown }) => writes.push({ model: "routeStop", ...args }) },
    trip: {
      findMany: async ({ where }: { where: { id?: { in: string[] } } }) => (where.id ? trips.filter((t) => where.id?.in.includes(t.id)) : []),
      updateMany: async (args: { where: unknown; data: unknown }) => {
        writes.push({ model: "trip", ...args });
        return { count: 1 };
      },
    },
    // The day's plan run, whose violations an evaluation replaces.
    optimizationRun: {
      findFirst: async () => ({ id: "run_plan", details: { solverStatus: "ROUTING_SUCCESS", violations: [], warnings: [], unassigned: [] } }),
      update: async (args: { where: unknown; data: unknown }) => writes.push({ model: "optimizationRun", ...args }),
    },
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (sql.includes("count(*)")) return [{ routes: version.changes, routesAt: null, stops: 0, trips: 0, tripsAt: null }];
      locks.push(/FROM "(\w+)"/.exec(sql)?.[1] ?? "?");
      return [];
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  };
  return { prisma: client as unknown as PrismaClient, writes, locks, version };
}

describe("refreshRoutes", () => {
  const day = new Date("2026-11-02T00:00:00.000Z");
  const nextDay = new Date("2026-11-03T00:00:00.000Z");
  const r1: FakeRoute = { ...stored("r1", "veh_1", [["B", "PICKUP"], ["B", "DROPOFF"]]), serviceDate: day };
  const other: FakeRoute = { ...stored("r2", "veh_2", [["D", "PICKUP"], ["D", "DROPOFF"]]), serviceDate: day };
  const r3: FakeRoute = { ...stored("r3", "veh_1", [["F", "PICKUP"], ["F", "DROPOFF"]]), serviceDate: nextDay };

  it("does nothing without routes", async () => {
    const { prisma, writes } = fakePrisma([r1], []);
    const evaluate = async (): Promise<EvaluateResult> => {
      throw new Error("not called");
    };
    expect(await refreshRoutes({ prisma, evaluate }, [])).toEqual(NOTHING_REFRESHED);
    expect(writes).toEqual([]);
  });

  it("keeps the stored values, and stops calling, when the optimizer cannot be reached", async () => {
    const { prisma, writes } = fakePrisma([r1, other, r3], []);
    let calls = 0;
    const evaluate = async (): Promise<EvaluateResult> => {
      calls += 1;
      return { ok: false, error: "Le service d'optimisation ne répond pas", reason: "unreachable" };
    };
    expect(await refreshRoutes({ prisma, evaluate }, ["r1", "r3"])).toEqual(outcome({ kept: 2, unavailable: true }));
    expect(calls).toBe(1);
    expect(writes).toEqual([]);
  });

  it("reports an optimizer error as a failure, not as unavailable, and goes on with the next dates", async () => {
    const { prisma, writes } = fakePrisma([r1, r3], []);
    let calls = 0;
    // FastAPI's 422 detail quotes the rejected input: trip and patient ids, coordinates.
    const detail = 'HTTP 422 : [{"input":{"id":"B","patientId":"pat_42","pickup":{"lat":43.2965,"lng":5.3698}}}]';
    const evaluate = async (): Promise<EvaluateResult> => {
      calls += 1;
      return { ok: false, error: detail, reason: "error" };
    };
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await refreshRoutes({ prisma, evaluate }, ["r1", "r3"])).toEqual(outcome({ kept: 2, failed: true }));
      expect(warnings.mock.calls).toEqual([
        ["[planning] routes not recomputed", { serviceDate: "2026-11-02", reason: "error" }],
        ["[planning] routes not recomputed", { serviceDate: "2026-11-03", reason: "error" }],
      ]);
      expect(JSON.stringify(warnings.mock.calls)).not.toContain("pat_42");
    } finally {
      warnings.mockRestore();
    }
    expect(calls).toBe(2);
    expect(writes).toEqual([]);
  });

  it("evaluates every route of the date and rewrites only the routes trips left, under lock", async () => {
    const { prisma, writes, locks } = fakePrisma([r1, other], [refreshTrip("B", "r1", { sharingStatus: "PROPOSED" }), refreshTrip("D", "r2")]);
    const requests: unknown[] = [];
    const evaluate = async (request: unknown): Promise<EvaluateResult> => {
      requests.push(request);
      return {
        ok: true,
        data: response(
          [planRoute("veh_1", [["B", "PICKUP"], ["B", "DROPOFF"]]), planRoute("veh_2", [["D", "PICKUP"], ["D", "DROPOFF"]])],
          [tripResult("B"), tripResult("D", { vehicleId: "veh_2" })],
          [{ code: "TIME_WINDOW", message: "retard", tripId: "B", vehicleId: "veh_1" }],
        ),
      };
    };
    const result = await refreshRoutes({ prisma, evaluate, now: NOW }, ["r1"]);

    expect(result).toEqual(outcome({ refreshed: 1, violations: 1 }));
    expect(requests).toHaveLength(1);
    expect((requests[0] as { routes: { vehicleId: string }[] }).routes.map((r) => r.vehicleId)).toEqual(["veh_1", "veh_2"]);
    expect(locks).toEqual(["Route", "RouteStop"]);
    // Only r1 and its trip are written; never the status of a route or a trip, the crew, nor positions.
    expect(writes.map((w) => [w.model, w.where])).toEqual([
      ["route", { id: "r1" }],
      ["routeStop", { id: "r1-B-PICKUP" }],
      ["routeStop", { id: "r1-B-DROPOFF" }],
      ["trip", { id: "B", routeId: "r1", sharingStatus: "PROPOSED", status: { notIn: ["CANCELLED", "NO_SHOW"] } }],
      // The evaluation's violations become those of the day's plan (read by the page and validateDay).
      ["optimizationRun", { id: "run_plan" }],
    ]);
    expect(writes[4]?.data).toEqual({
      valid: false,
      details: {
        solverStatus: "ROUTING_SUCCESS",
        violations: [{ code: "TIME_WINDOW", message: "retard", tripId: "B", vehicleId: "veh_1" }],
        warnings: [],
        unassigned: [],
        evaluatedAt: NOW.toISOString(),
      },
    });
    const routeWrite = writes[0]?.data as Record<string, unknown>;
    expect(Object.keys(routeWrite).sort()).toEqual(
      ["breakEndMinute", "breakStartMinute", "cost", "distanceKm", "emptyKm", "endMinute", "margin", "revenue", "startMinute"],
    );
    expect(Object.keys(writes[1]?.data as object).sort()).toEqual(["arrivalMinute", "departureMinute", "loadAfter", "startMinute"]);
    expect(writes[3]?.data).toMatchObject({ shared: false, sharingStatus: "NOT_PROPOSED", sharingProposedAt: null });
    expect(writes[3]?.data).not.toHaveProperty("status");
  });

  it("tells a day under way, and leaves the stops done as planned", async () => {
    const startedR1: FakeRoute = { ...r1, stops: r1.stops.map((s) => (s.kind === "PICKUP" ? { ...s, completedAt: DONE_AT } : s)) };
    const { prisma, writes } = fakePrisma([startedR1], [refreshTrip("B", "r1", { status: "PICKED_UP" })]);
    const evaluate = async (): Promise<EvaluateResult> => ({
      ok: true,
      data: response([planRoute("veh_1", [["B", "PICKUP"], ["B", "DROPOFF"]])], [tripResult("B")]),
    });
    expect(await refreshRoutes({ prisma, evaluate, now: NOW }, ["r1"])).toEqual(outcome({ refreshed: 1, dayStarted: true }));
    expect(writes.map((w) => [w.model, w.where])).toEqual([
      ["route", { id: "r1" }],
      ["routeStop", { id: "r1-B-DROPOFF" }],
      ["trip", { id: "B", routeId: "r1", sharingStatus: "NOT_PROPOSED", status: { notIn: ["CANCELLED", "NO_SHOW"] } }],
      ["optimizationRun", { id: "run_plan" }],
    ]);
    expect(writes[0]?.data).toMatchObject({ startMinute: 400 });
    expect(writes[2]?.data).not.toHaveProperty("plannedPickupMinute");
    expect(writes[2]?.data).toMatchObject({ plannedDropoffMinute: 440 });
  });

  it("does not store the violations when the day changed between the evaluation and the write", async () => {
    const { prisma, writes, version } = fakePrisma([r1], [refreshTrip("B", "r1")]);
    const evaluate = async (): Promise<EvaluateResult> => {
      // Another trip of the day was cancelled meanwhile: the evaluation no longer describes the day.
      version.changes += 1;
      return { ok: true, data: response([planRoute("veh_1", [["B", "PICKUP"], ["B", "DROPOFF"]])], [tripResult("B")]) };
    };
    expect(await refreshRoutes({ prisma, evaluate, now: NOW }, ["r1"])).toEqual(outcome({ refreshed: 1 }));
    expect(writes.map((w) => w.model)).not.toContain("optimizationRun");
  });

  it("leaves a route whose stops changed between the evaluation and the write", async () => {
    const live: FakeRoute = { ...r1, stops: r1.stops.map((s) => ({ ...s })) };
    const { prisma, writes } = fakePrisma([live], [refreshTrip("B", "r1")]);
    const evaluate = async (): Promise<EvaluateResult> => {
      // A concurrent change renumbers the stops while the optimizer computes.
      live.stops = live.stops.map((s) => ({ ...s, sequence: s.sequence + 1 }));
      return { ok: true, data: response([planRoute("veh_1", [["B", "PICKUP"], ["B", "DROPOFF"]])], [tripResult("B")]) };
    };
    expect(await refreshRoutes({ prisma, evaluate, now: NOW }, ["r1"])).toEqual(outcome({ kept: 1 }));
    expect(writes).toEqual([]);
  });

  it("reports a database error as a failure and logs it without the query arguments", async () => {
    // Prisma errors print the query invocation, addresses included.
    const dbError = Object.assign(new Error('Invalid `prisma.trip.findMany()` invocation: { pickupAddress: "12 rue des Lilas" }'), {
      name: "PrismaClientKnownRequestError",
      code: "P2028",
    });
    const evaluate = async (): Promise<EvaluateResult> => {
      throw new Error("not called");
    };
    const { prisma } = fakePrisma([r1, r3], []);
    const failing = (overrides: object) => ({ ...(prisma as object), ...overrides }) as unknown as PrismaClient;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const reading = failing({ route: { findMany: async () => Promise.reject(dbError) } });
      expect(await refreshRoutes({ prisma: reading, evaluate }, ["r1"])).toEqual(outcome({ kept: 1, failed: true }));
      // Loading a date fails (settings read): that date is kept, the next one is still tried.
      const loading = failing({ appSettings: { upsert: async () => Promise.reject(dbError) } });
      expect(await refreshRoutes({ prisma: loading, evaluate }, ["r1", "r3"])).toEqual(outcome({ kept: 2, failed: true }));

      // Stack frames only ("    at …" lines): the message, with the address, never reaches the log.
      const prismaFields = { name: "PrismaClientKnownRequestError", code: "P2028", stack: expect.stringMatching(/^\s+at /) };
      expect(errors.mock.calls).toEqual([
        ["[planning] reading the routes to recompute failed", { routes: 1, ...prismaFields }],
        ["[planning] recomputing routes failed", { serviceDate: "2026-11-02", routes: 1, ...prismaFields }],
        ["[planning] recomputing routes failed", { serviceDate: "2026-11-03", routes: 1, ...prismaFields }],
      ]);
      expect(JSON.stringify(errors.mock.calls)).not.toContain("rue des Lilas");
    } finally {
      errors.mockRestore();
    }
  });
});
