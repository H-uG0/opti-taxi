import { readFileSync } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { optimizeRequestSchema, planResponseSchema, type PlanResponse, type PlanRoute, type TripResult } from "./contract";
import {
  nextSharingState,
  nextTripStatus,
  PlanBlockedError,
  planRoutes,
  planTripUpdates,
  replanBlockReason,
  savePlan,
  summarizeRun,
  type CurrentTrip,
  type VehicleCrew,
} from "./persist";
import { readRunDetails, runDetailsJson } from "./run-details";

const NOW = new Date("2026-11-02T17:30:00Z");

function current(id: string, overrides: Partial<CurrentTrip> = {}): CurrentTrip {
  return {
    id,
    status: "PLANNED",
    sharingStatus: "NOT_PROPOSED",
    pickupAddress: `Domicile ${id}`,
    dropoffAddress: `Soins ${id}`,
    ...overrides,
  };
}

function result(tripId: string, overrides: Partial<TripResult> = {}): TripResult {
  return {
    tripId,
    vehicleId: "veh_1",
    pickupMin: 410,
    dropoffMin: 440,
    shared: false,
    coPassengerTripIds: [],
    directKm: 18.2,
    rideKm: 18.2,
    detourKm: 0,
    revenue: 33.4,
    waitAtFacilityMin: 10,
    ...overrides,
  };
}

function route(vehicleId: string, tripIds: string[], overrides: Partial<PlanRoute> = {}): PlanRoute {
  let minute = 400;
  return {
    vehicleId,
    startMin: 380,
    endMin: 700,
    distanceKm: 80,
    emptyKm: 20,
    loadedKm: 60,
    durationMin: 320,
    revenue: 120,
    cost: 90,
    margin: 30,
    break: { startMin: 720, endMin: 765 },
    stops: tripIds.flatMap((tripId) =>
      (["PICKUP", "DROPOFF"] as const).map((kind) => {
        minute += 20;
        return {
          tripId,
          kind,
          location: { lat: kind === "PICKUP" ? 43.3 : 43.5, lng: 5.4 },
          arrivalMin: minute - 2,
          startMin: minute,
          departureMin: minute + 5,
          loadAfter: kind === "PICKUP" ? 1 : 0,
        };
      }),
    ),
    ...overrides,
  };
}

const crews: ReadonlyMap<string, VehicleCrew> = new Map<string, VehicleCrew>([
  ["veh_1", { id: "veh_1", type: "VSL", defaultDriverId: "drv_1", defaultCrewMateId: null }],
  ["veh_2", { id: "veh_2", type: "AMBULANCE", defaultDriverId: "drv_2", defaultCrewMateId: "drv_3" }],
  // Stale crew mate left on a taxi (legacy data): never copied to the route.
  ["veh_3", { id: "veh_3", type: "TAXI", defaultDriverId: "drv_4", defaultCrewMateId: "drv_5" }],
]);

describe("planRoutes", () => {
  it("maps a route, its crew and its stops with the trips' addresses", () => {
    const trips = new Map([["a", current("a")]]);
    const [row] = planRoutes({ routes: [route("veh_2", ["a"])] }, crews, trips);
    expect(row).toMatchObject({
      vehicleId: "veh_2",
      driverId: "drv_2",
      crewMateId: "drv_3",
      startMinute: 380,
      endMinute: 700,
      distanceKm: 80,
      emptyKm: 20,
      revenue: 120,
      cost: 90,
      margin: 30,
      breakStartMinute: 720,
      breakEndMinute: 765,
    });
    expect(row?.stops).toEqual([
      {
        sequence: 0,
        tripId: "a",
        kind: "PICKUP",
        lat: 43.3,
        lng: 5.4,
        address: "Domicile a",
        arrivalMinute: 418,
        startMinute: 420,
        departureMinute: 425,
        loadAfter: 1,
      },
      {
        sequence: 1,
        tripId: "a",
        kind: "DROPOFF",
        lat: 43.5,
        lng: 5.4,
        address: "Soins a",
        arrivalMinute: 438,
        startMinute: 440,
        departureMinute: 445,
        loadAfter: 0,
      },
    ]);
  });

  it("records a crew mate on an ambulance only", () => {
    const trips = new Map([
      ["a", current("a")],
      ["b", current("b")],
    ]);
    const rows = planRoutes({ routes: [route("veh_3", ["a"]), route("veh_2", ["b"])] }, crews, trips);
    expect(rows.map((r) => [r.vehicleId, r.driverId, r.crewMateId])).toEqual([
      ["veh_3", "drv_4", null],
      ["veh_2", "drv_2", "drv_3"],
    ]);
  });

  it("drops stops of trips cancelled or deleted meanwhile and renumbers the sequence", () => {
    const trips = new Map([
      ["a", current("a", { status: "CANCELLED" })],
      ["c", current("c")],
    ]);
    const [row] = planRoutes({ routes: [route("veh_1", ["a", "b", "c"])] }, crews, trips);
    expect(row?.stops.map((s) => [s.sequence, s.tripId, s.kind])).toEqual([
      [0, "c", "PICKUP"],
      [1, "c", "DROPOFF"],
    ]);
  });

  it("skips empty routes, unknown vehicles and duplicates, and keeps a null break", () => {
    const trips = new Map([
      ["a", current("a")],
      ["b", current("b")],
    ]);
    const rows = planRoutes(
      {
        routes: [
          route("veh_1", [], {}),
          route("veh_unknown", ["a"]),
          route("veh_2", ["a"], { break: null }),
          route("veh_2", ["b"]),
        ],
      },
      crews,
      trips,
    );
    expect(rows.map((r) => r.vehicleId)).toEqual(["veh_2"]);
    expect(rows[0]).toMatchObject({ breakStartMinute: null, breakEndMinute: null });
  });
});

describe("replanBlockReason", () => {
  const clear = { validatedRoutes: 0, startedTrips: 0, completedStops: 0 };

  it("lets a proposed, not started day be replanned", () => {
    expect(replanBlockReason("2026-11-03", clear)).toBeNull();
  });

  it("protects a validated planning", () => {
    expect(replanBlockReason("2026-11-03", { ...clear, validatedRoutes: 2 })).toMatch(/est validé : rouvrez-le/);
  });

  it("protects the drivers' field timestamps", () => {
    expect(replanBlockReason("2026-11-03", { ...clear, startedTrips: 1 })).toMatch(/journée a commencé/);
    expect(replanBlockReason("2026-11-03", { ...clear, completedStops: 1 })).toMatch(/journée a commencé/);
  });

  it("explains, when raised at save time, that the day changed during the solve", () => {
    const reason = replanBlockReason("2026-11-03", { ...clear, validatedRoutes: 1 }) ?? "";
    const error = new PlanBlockedError(reason);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("pendant l'optimisation");
    expect(error.message).toContain(reason);
  });
});

describe("trip status", () => {
  it("assigns served trips and puts unassigned ones back to plan", () => {
    expect(nextTripStatus("PLANNED", true)).toBe("ASSIGNED");
    expect(nextTripStatus("ASSIGNED", false)).toBe("PLANNED");
    expect(nextTripStatus("ASSIGNED", true)).toBe("ASSIGNED");
  });

  it("never touches field or cancellation statuses", () => {
    for (const status of ["PICKED_UP", "DROPPED_OFF", "CANCELLED", "NO_SHOW"] as const) {
      expect(nextTripStatus(status, true)).toBe(status);
      expect(nextTripStatus(status, false)).toBe(status);
    }
  });
});

describe("sharing traceability", () => {
  it("proposes sharing to a newly shared trip, with a timestamp", () => {
    expect(nextSharingState("NOT_PROPOSED", true, NOW)).toEqual({ sharingStatus: "PROPOSED", sharingProposedAt: NOW });
  });

  it("withdraws a proposal that is no longer shared", () => {
    expect(nextSharingState("PROPOSED", false, NOW)).toEqual({ sharingStatus: "NOT_PROPOSED", sharingProposedAt: null });
  });

  it("keeps a pending proposal that is still shared", () => {
    expect(nextSharingState("PROPOSED", true, NOW)).toBeNull();
  });

  it("never overrides the patient's answer or the prescription", () => {
    for (const status of ["ACCEPTED", "REFUSED", "NOT_ELIGIBLE"] as const) {
      expect(nextSharingState(status, true, NOW)).toBeNull();
      expect(nextSharingState(status, false, NOW)).toBeNull();
    }
  });
});

describe("planTripUpdates", () => {
  const response: Pick<PlanResponse, "trips"> = {
    trips: [
      result("shared1", { shared: true, coPassengerTripIds: ["shared2"], detourKm: 4.2, revenue: 25.1 }),
      result("shared2", { shared: true, coPassengerTripIds: ["shared1"], revenue: 25.1 }),
      result("solo"),
      result("late", { vehicleId: null, pickupMin: null, dropoffMin: null, revenue: 0, waitAtFacilityMin: null }),
      result("accepted", { shared: false }),
      result("field"),
    ],
  };
  const routes = planRoutes(
    { routes: [route("veh_1", ["shared1", "shared2", "solo", "accepted", "field"])] },
    crews,
    new Map(["shared1", "shared2", "solo", "accepted", "field"].map((id) => [id, current(id)])),
  );
  const trips = new Map<string, CurrentTrip>([
    ["shared1", current("shared1")],
    ["shared2", current("shared2", { sharingStatus: "PROPOSED" })],
    ["solo", current("solo", { status: "ASSIGNED", sharingStatus: "PROPOSED" })],
    ["late", current("late", { status: "ASSIGNED", sharingStatus: "PROPOSED" })],
    ["accepted", current("accepted", { sharingStatus: "ACCEPTED" })],
    ["field", current("field", { status: "PICKED_UP" })],
    ["cancelled", current("cancelled", { status: "CANCELLED" })],
  ]);
  const ids = ["shared1", "shared2", "solo", "late", "accepted", "field", "cancelled", "deleted"];
  const updates = new Map(planTripUpdates(ids, response, routes, trips, NOW).map((u) => [u.tripId, u]));

  it("skips cancelled and deleted trips", () => {
    expect(updates.has("cancelled")).toBe(false);
    expect(updates.has("deleted")).toBe(false);
    expect(updates.size).toBe(6);
  });

  it("writes the planned times, revenue and vehicle of served trips", () => {
    expect(updates.get("shared1")).toEqual({
      tripId: "shared1",
      vehicleId: "veh_1",
      data: {
        status: "ASSIGNED",
        plannedPickupMinute: 410,
        plannedDropoffMinute: 440,
        shared: true,
        directKm: 18.2,
        detourKm: 4.2,
        estimatedRevenue: 25.1,
        sharingStatus: "PROPOSED",
        sharingProposedAt: NOW,
      },
    });
  });

  it("clears the plan of unassigned trips and withdraws their sharing proposal", () => {
    expect(updates.get("late")).toEqual({
      tripId: "late",
      vehicleId: null,
      data: {
        status: "PLANNED",
        plannedPickupMinute: null,
        plannedDropoffMinute: null,
        shared: false,
        directKm: 18.2,
        detourKm: null,
        estimatedRevenue: null,
        sharingStatus: "NOT_PROPOSED",
        sharingProposedAt: null,
      },
    });
  });

  it("applies the sharing transitions", () => {
    expect(updates.get("shared2")?.data.sharingStatus).toBeUndefined();
    expect(updates.get("solo")?.data).toMatchObject({ sharingStatus: "NOT_PROPOSED", sharingProposedAt: null });
    expect(updates.get("accepted")?.data.sharingStatus).toBeUndefined();
  });

  it("keeps the status of trips already picked up", () => {
    expect(updates.get("field")?.data.status).toBe("PICKED_UP");
    expect(updates.get("field")?.vehicleId).toBe("veh_1");
  });
});

describe("contract fixtures", () => {
  const fixtures = path.resolve(__dirname, "../../../../../contract/fixtures");
  const load = (name: string): unknown => JSON.parse(readFileSync(path.join(fixtures, name), "utf8"));
  const request = optimizeRequestSchema.parse(load("optimize-request.json"));
  const response = planResponseSchema.parse(load("plan-response.json"));

  it("maps the fixture plan and summarizes the run", () => {
    const vehicles = new Map<string, VehicleCrew>(
      request.vehicles.map((v) => [v.id, { id: v.id, type: v.type, defaultDriverId: `drv_${v.id}`, defaultCrewMateId: null }]),
    );
    const trips = new Map(request.trips.map((t) => [t.id, current(t.id)]));
    const routes = planRoutes(response, vehicles, trips);
    expect(routes).toHaveLength(response.routes.filter((r) => r.stops.length > 0).length);

    // The fixture response only covers part of the fixture request.
    const updates = planTripUpdates(response.trips.map((t) => t.tripId), response, routes, trips, NOW);
    expect(updates).toHaveLength(response.trips.length);
    const unassigned = new Set(response.unassigned.map((u) => u.tripId));
    for (const update of updates) {
      expect(update.data.status).toBe(unassigned.has(update.tripId) ? "PLANNED" : "ASSIGNED");
    }

    expect(summarizeRun(request, response)).toEqual({
      tripsCount: request.trips.length,
      lockedCount: request.trips.filter((t) => t.lockedVehicleId).length,
      unassignedCount: response.unassigned.length,
      objective: response.meta.objective,
      wallTimeMs: response.meta.wallTimeMs,
      matrixSource: response.meta.matrixSource,
      valid: response.validation.valid,
      kpis: response.kpis,
    });
  });

  it("saves the run with exactly the optimizer KPIs and the details in their own column", async () => {
    type RunWrite = { where: unknown; data: Record<string, unknown> };
    const runWrites: RunWrite[] = [];
    let createdRoutes = 0;
    // Just enough of a transaction client for savePlan: nothing locked, nothing started.
    const tx = {
      $queryRaw: async () => [],
      trip: {
        count: async () => 0,
        findMany: async () => request.trips.map((t) => current(t.id)),
        update: async () => ({}),
        updateMany: async () => ({ count: 0 }),
      },
      vehicle: {
        findMany: async () =>
          request.vehicles.map((v) => ({ id: v.id, type: v.type, defaultDriverId: `drv_${v.id}`, defaultCrewMateId: null })),
      },
      route: {
        deleteMany: async () => ({ count: 0 }),
        create: async () => ({ id: `route_${++createdRoutes}` }),
      },
      optimizationRun: {
        update: async (args: RunWrite) => {
          runWrites.push(args);
          return {};
        },
      },
    };
    const prisma = { $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient;

    await savePlan(prisma, { runId: "run_1", isoDate: request.date, request, response, now: NOW });

    expect(runWrites).toHaveLength(1);
    const write = runWrites[0];
    expect(write?.where).toEqual({ id: "run_1" });
    expect(write?.data).toMatchObject({ status: "SUCCESS", error: null, ...summarizeRun(request, response) });
    expect(write?.data.kpis).toStrictEqual(response.kpis);
    expect(write?.data.details).toStrictEqual(runDetailsJson(response));

    const stored = JSON.parse(JSON.stringify({ id: "run_1", kpis: write?.data.kpis, details: write?.data.details }));
    expect(readRunDetails(stored)).toEqual({
      runId: "run_1",
      solverStatus: response.meta.solverStatus,
      violations: response.validation.violations,
      warnings: response.meta.warnings,
      unassigned: response.unassigned,
    });
  });
});
