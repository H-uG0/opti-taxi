import { readFileSync } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
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
/** When the run being saved was created (its computation started). */
const RUN_STARTED = new Date("2026-11-02T17:29:40Z");

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

  type RunWrite = { where: unknown; data: Record<string, unknown> };
  type InPlaceRoute = {
    id: string;
    vehicleId: string;
    driverId: string | null;
    crewMateId: string | null;
    revenue: number;
    margin: number;
    distanceKm: number;
    optimizationRunId: string | null;
    vehicle: { label: string } | null;
    stops: { tripId: string; kind: "PICKUP" | "DROPOFF"; sequence: number }[];
  };

  /**
   * Just enough of a transaction client for savePlan: nothing locked, nothing
   * started; `inPlace` are the routes already saved for the date (serving the
   * trips of their stops), with `violationsInPlace` on their run. Each vehicle
   * of the request is crewed by `drv_<vehicle id>`.
   */
  function fakeClient(inPlace: InPlaceRoute[] = [], violationsInPlace = 0, earlierOsrmRuns = 0, trafficChangedAt: Date | null = null) {
    const servedInPlace = inPlace.flatMap((r) => [...new Set(r.stops.map((s) => s.tripId))].map((id) => ({ id, routeId: r.id })));
    const runWrites: RunWrite[] = [];
    const deleted: unknown[] = [];
    const createdData: Record<string, unknown>[] = [];
    const settingsWrites: unknown[] = [];
    let createdRoutes = 0;
    const tx = {
      $queryRaw: async () => [],
      $executeRaw: async () => 1,
      trip: {
        count: async () => 0,
        findMany: async (args: { where: { routeId?: unknown } }) =>
          args.where.routeId ? servedInPlace : request.trips.map((t) => current(t.id)),
        update: async () => ({}),
        updateMany: async () => ({ count: 0 }),
      },
      vehicle: {
        findMany: async () =>
          request.vehicles.map((v) => ({ id: v.id, type: v.type, defaultDriverId: `drv_${v.id}`, defaultCrewMateId: null })),
      },
      route: {
        findMany: async () => inPlace,
        deleteMany: async (args: unknown) => {
          deleted.push(args);
          return { count: inPlace.length };
        },
        create: async (args: { data: Record<string, unknown> }) => {
          createdData.push(args.data);
          return { id: `route_${++createdRoutes}` };
        },
      },
      appSettings: {
        findUnique: async () => ({ trafficChangedAt }),
        updateMany: async (args: unknown) => {
          settingsWrites.push(args);
          return { count: 1 };
        },
      },
      optimizationRun: {
        count: async () => earlierOsrmRuns,
        findUnique: async () => ({ startedAt: RUN_STARTED }),
        findFirst: async () =>
          inPlace.length > 0
            ? {
                id: "run_0",
                valid: violationsInPlace === 0,
                kpis: null,
                details: {
                  ...runDetailsJson(response),
                  violations: Array.from({ length: violationsInPlace }, () => ({
                    code: "TIME_WINDOW",
                    message: "Retard",
                    tripId: null,
                    vehicleId: null,
                  })),
                },
              }
            : null,
        update: async (args: RunWrite) => {
          runWrites.push(args);
          return {};
        },
      },
    };
    const prisma = { $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient;
    return { prisma, runWrites, deleted, createdData, settingsWrites };
  }

  it("stores the distance source with each route, and starts the traffic calibration over when OSRM is first used", async () => {
    const straight = fakeClient();
    await savePlan(straight.prisma, { runId: "run_1", isoDate: request.date, request, response, now: NOW });
    expect(straight.createdData.every((data) => data.matrixSource === "haversine")).toBe(true);
    expect(straight.settingsWrites).toEqual([]);

    const osrm = { ...response, meta: { ...response.meta, matrixSource: "osrm" as const } };
    const first = fakeClient();
    const onTrafficReset = vi.fn(async () => {});
    await savePlan(first.prisma, { runId: "run_2", isoDate: request.date, request, response: osrm, now: NOW, onTrafficReset });
    expect(first.createdData.every((data) => data.matrixSource === "osrm")).toBe(true);
    // From the run's start, not the save: the routes of this first OSRM run count in the calibration.
    expect(first.settingsWrites).toEqual([{ where: { id: 1 }, data: { trafficChangedAt: RUN_STARTED } }]);
    expect(onTrafficReset).toHaveBeenCalledTimes(1);

    // Factors changed by the regulator while the run computed: that change stays the start.
    const changedSince = new Date(RUN_STARTED.getTime() + 60_000);
    const changed = fakeClient([], 0, 0, changedSince);
    await savePlan(changed.prisma, { runId: "run_2", isoDate: request.date, request, response: osrm, now: NOW });
    expect(changed.settingsWrites).toEqual([{ where: { id: 1 }, data: { trafficChangedAt: changedSince } }]);

    const again = fakeClient([], 0, 4);
    await savePlan(again.prisma, { runId: "run_3", isoDate: request.date, request, response: osrm, now: NOW, onTrafficReset });
    expect(again.settingsWrites).toEqual([]);
    expect(onTrafficReset).toHaveBeenCalledTimes(1);
  });

  it("saves the run with exactly the optimizer KPIs and the details in their own column", async () => {
    const { prisma, runWrites } = fakeClient();

    await savePlan(prisma, { runId: "run_1", isoDate: request.date, request, response, now: NOW });

    expect(runWrites).toHaveLength(1);
    const write = runWrites[0];
    expect(write?.where).toEqual({ id: "run_1" });
    expect(write?.data).toMatchObject({ status: "SUCCESS", error: null, ...summarizeRun(request, response) });
    expect(write?.data.kpis).toStrictEqual(response.kpis);
    // No routes in place: nothing to compare with, nothing to keep.
    expect(write?.data.details).toMatchObject(runDetailsJson(response));
    expect(write?.data.details).toMatchObject({ comparison: { current: null, lostTripIds: [] } });
    expect(write?.data.details).not.toHaveProperty("previous");

    const stored = JSON.parse(JSON.stringify({ id: "run_1", kpis: write?.data.kpis, details: write?.data.details }));
    expect(readRunDetails(stored)).toEqual({
      runId: "run_1",
      solverStatus: response.meta.solverStatus,
      violations: response.validation.violations,
      warnings: response.meta.warnings,
      unassigned: response.unassigned,
      trafficSource: response.meta.trafficSource,
      comparison: expect.objectContaining({ current: null }),
    });
  });

  // A route in place that can still be driven: a vehicle of the request, with the crew it gets today.
  const taxi = request.vehicles.find((v) => v.type === "TAXI")!;
  const inPlaceRoute: InPlaceRoute = {
    id: "route_old",
    vehicleId: taxi.id,
    driverId: `drv_${taxi.id}`,
    crewMateId: null,
    revenue: 500,
    margin: 200,
    distanceKm: 120,
    optimizationRunId: "run_0",
    vehicle: { label: taxi.label },
    stops: [
      { tripId: "old_trip", kind: "DROPOFF", sequence: 1 },
      { tripId: "old_trip", kind: "PICKUP", sequence: 0 },
    ],
  };

  it("compares the new plan with the routes in place and keeps their stop sequences", async () => {
    const { prisma, runWrites } = fakeClient([inPlaceRoute], 1);
    const checks: unknown[] = [];
    const saved = await savePlan(prisma, {
      runId: "run_1",
      isoDate: request.date,
      request,
      response,
      kind: "optimize",
      check: (context) => {
        checks.push(context.comparison);
      },
      now: NOW,
    });
    expect(checks).toEqual([saved.comparison]);
    expect(saved.comparison.current).toEqual({ served: 1, violations: 1, revenue: 500, margin: 200, km: 120 });
    expect(saved.comparison.next.violations).toBe(response.validation.violations.length);
    // The trip of the old plan is not part of the new request: lost.
    expect(saved.comparison.lostTripIds).toEqual(["old_trip"]);
    expect(saved.comparison).not.toHaveProperty("undrivable");
    expect(runWrites[0]?.data.details).toMatchObject({
      kind: "optimize",
      previous: {
        runId: "run_0",
        figures: { served: 1 },
        routes: [{ vehicleId: taxi.id, stops: [{ tripId: "old_trip", kind: "PICKUP" }, { tripId: "old_trip", kind: "DROPOFF" }] }],
      },
    });
  });

  it("does not count the routes in place that can no longer be driven (vehicle gone, crew changed)", async () => {
    const stops = (tripId: string) => [
      { tripId, kind: "PICKUP" as const, sequence: 0 },
      { tripId, kind: "DROPOFF" as const, sequence: 1 },
    ];
    const vsl = request.vehicles.find((v) => v.type === "VSL")!;
    const { prisma, runWrites } = fakeClient([
      inPlaceRoute,
      // Vehicle no longer sent to the optimizer (unavailable or deactivated since the computation).
      { ...inPlaceRoute, id: "route_gone", vehicleId: "veh_gone", driverId: "drv_x", vehicle: { label: "Taxi 9" }, stops: stops("gone_trip") },
      // Driver of the route absent, replaced in the crew of the day.
      { ...inPlaceRoute, id: "route_vsl", vehicleId: vsl.id, driverId: "drv_absent", vehicle: { label: vsl.label }, stops: stops("vsl_trip") },
    ]);
    const lockChange = { tripId: "t", from: null, to: "v" };
    const saved = await savePlan(prisma, { runId: "run_1", isoDate: request.date, request, response, lockChange, now: NOW });
    expect(saved.comparison.current).toEqual({ served: 1, violations: 0, revenue: 500, margin: 200, km: 120 });
    expect(saved.comparison.lostTripIds).toEqual(["old_trip"]);
    expect(saved.comparison.undrivable).toEqual({ vehicles: ["Taxi 9", vsl.label], trips: 2 });
    // Every route is kept for « Revenir au planning précédent », with the figures of what could be driven.
    expect(runWrites[0]?.data.details).toMatchObject({
      previous: { figures: { served: 1 }, routes: [{ vehicleId: taxi.id }, { vehicleId: "veh_gone" }, { vehicleId: vsl.id }] },
      lockChange,
    });
  });

  it("writes nothing when the guard refuses the new plan", async () => {
    const { prisma, runWrites, deleted } = fakeClient([inPlaceRoute]);
    const refusal = new Error("moins bon");
    await expect(
      savePlan(prisma, {
        runId: "run_1",
        isoDate: request.date,
        request,
        response,
        check: () => {
          throw refusal;
        },
        now: NOW,
      }),
    ).rejects.toBe(refusal);
    expect(deleted).toEqual([]);
    expect(runWrites).toEqual([]);
  });
});
