import { describe, expect, it } from "vitest";
import type { RouteRow, StopRow, TripUpdate } from "@/lib/optimizer/persist";
import { keepDoneMinutes, planStartedWrite, planStopWrites, type StartedStoredRoute } from "./route-writes";

const DONE = new Date("2026-11-14T08:10:00Z");

function storedStop(tripId: string, kind: "PICKUP" | "DROPOFF", sequence: number, completedAt: Date | null = null) {
  return { id: `${tripId}-${kind}`, tripId, kind, sequence, completedAt };
}

function stopRow(tripId: string, kind: "PICKUP" | "DROPOFF", sequence: number): StopRow {
  return {
    sequence,
    tripId,
    kind,
    lat: 43.3,
    lng: 5.4,
    address: `${kind} ${tripId}`,
    arrivalMinute: 600 + sequence,
    startMinute: 600 + sequence,
    departureMinute: 605 + sequence,
    loadAfter: kind === "PICKUP" ? 1 : 0,
  };
}

function row(vehicleId: string, stops: [string, "PICKUP" | "DROPOFF"][], startMinute = 420): RouteRow {
  return {
    vehicleId,
    driverId: `drv-${vehicleId}`,
    crewMateId: null,
    startMinute,
    endMinute: 900,
    distanceKm: 50,
    emptyKm: 10,
    revenue: 120,
    cost: 60,
    margin: 60,
    breakStartMinute: null,
    breakEndMinute: null,
    stops: stops.map(([tripId, kind], k) => stopRow(tripId, kind, k)),
  };
}

function update(tripId: string, vehicleId: string | null): TripUpdate {
  return {
    tripId,
    vehicleId,
    data: {
      status: vehicleId ? "ASSIGNED" : "PLANNED",
      plannedPickupMinute: vehicleId ? 650 : null,
      plannedDropoffMinute: vehicleId ? 690 : null,
      shared: false,
      directKm: 12,
      detourKm: 0,
      estimatedRevenue: 40,
    },
  };
}

/** Taxi 1 under way (t1 dropped off, t2 picked up), taxi 2 not started, taxi 3 not started. */
const stored: StartedStoredRoute[] = [
  {
    id: "route-1",
    vehicleId: "taxi_1",
    startMinute: 400,
    stops: [
      storedStop("t1", "PICKUP", 0, DONE),
      storedStop("t1", "DROPOFF", 1, DONE),
      storedStop("t2", "PICKUP", 2, DONE),
      storedStop("t2", "DROPOFF", 3),
      storedStop("t3", "PICKUP", 4),
      storedStop("t3", "DROPOFF", 5),
    ],
  },
  { id: "route-2", vehicleId: "taxi_2", startMinute: 430, stops: [storedStop("t4", "PICKUP", 0), storedStop("t4", "DROPOFF", 1)] },
  { id: "route-3", vehicleId: "taxi_3", startMinute: 450, stops: [storedStop("t5", "PICKUP", 0), storedStop("t5", "DROPOFF", 1)] },
];

describe("planStartedWrite (« Réoptimiser la suite », DAY-02)", () => {
  // The plan: t3 goes from taxi 1 to taxi 2, taxi 3 keeps its route, a new route for taxi 4 takes t6.
  const rows = [
    row("taxi_1", [["t1", "PICKUP"], ["t1", "DROPOFF"], ["t2", "PICKUP"], ["t2", "DROPOFF"]], 398),
    row("taxi_2", [["t4", "PICKUP"], ["t3", "PICKUP"], ["t3", "DROPOFF"], ["t4", "DROPOFF"]]),
    row("taxi_3", [["t5", "PICKUP"], ["t5", "DROPOFF"]]),
    row("taxi_4", [["t6", "PICKUP"], ["t6", "DROPOFF"]]),
  ];
  const updates = [update("t1", "taxi_1"), update("t2", "taxi_1"), update("t3", "taxi_2"), update("t4", "taxi_2"), update("t5", "taxi_3"), update("t6", "taxi_4")];
  const write = planStartedWrite({ rows, updates, stored, statusOf: (id) => (id === "t1" ? "DROPPED_OFF" : id === "t2" ? "PICKED_UP" : "ASSIGNED") });

  it("writes only the routes the plan touches: an untouched route keeps its times, a started one its start", () => {
    expect(write.untouched).toBe(1);
    expect(write.routes.map((r) => [r.routeId, r.row.vehicleId])).toEqual([
      ["route-1", "taxi_1"],
      ["route-2", "taxi_2"],
      [null, "taxi_4"],
    ]);
    // Its stops done are behind it: the stored departure stays.
    expect(write.routes[0]!.row.startMinute).toBe(400);
    expect(write.routes[1]!.row.startMinute).toBe(420);
    expect(write.deletedRouteIds).toEqual([]);
  });

  it("never rewrites a stop done, and writes the trips of the routes touched without the planned minutes of what was done", () => {
    expect([...write.frozenStopIds]).toEqual(["t1-PICKUP", "t1-DROPOFF", "t2-PICKUP"]);
    expect(write.trips.map((t) => t.tripId)).toEqual(["t1", "t2", "t3", "t4", "t6"]);
    const t1 = write.trips.find((t) => t.tripId === "t1")!;
    expect(t1.data).not.toHaveProperty("plannedPickupMinute");
    expect(t1.data).not.toHaveProperty("plannedDropoffMinute");
    const t2 = write.trips.find((t) => t.tripId === "t2")!;
    expect(t2.data).not.toHaveProperty("plannedPickupMinute");
    expect(t2.data.plannedDropoffMinute).toBe(690);
  });

  it("deletes a route left without stops, never one with a stop done", () => {
    const gone = planStartedWrite({ rows: rows.slice(0, 1), updates: [], stored, statusOf: () => undefined });
    expect(gone.deletedRouteIds).toEqual(["route-2", "route-3"]);
    const kept = planStartedWrite({ rows: [], updates: [], stored, statusOf: () => undefined });
    expect(kept.deletedRouteIds).toEqual(["route-2", "route-3"]);
  });
});

describe("planStopWrites with stops done", () => {
  it("only moves a stop done to its new position, never rewrites its times, never deletes it", () => {
    const writes = planStopWrites(
      stored[0]!.stops,
      [stopRow("t1", "PICKUP", 0), stopRow("t1", "DROPOFF", 1), stopRow("t2", "PICKUP", 2), stopRow("t7", "PICKUP", 3), stopRow("t2", "DROPOFF", 4), stopRow("t7", "DROPOFF", 5)],
      new Set(["t1-PICKUP", "t1-DROPOFF", "t2-PICKUP"]),
    );
    expect(writes.updates.slice(0, 3)).toEqual([
      { id: "t1-PICKUP", data: { sequence: 0 } },
      { id: "t1-DROPOFF", data: { sequence: 1 } },
      { id: "t2-PICKUP", data: { sequence: 2 } },
    ]);
    expect(writes.updates[3]).toMatchObject({ id: "t2-DROPOFF", data: { sequence: 4, startMinute: 604 } });
    expect(writes.deleteIds).toEqual(["t3-PICKUP", "t3-DROPOFF"]);
    expect(writes.creates.map((c) => `${c.tripId}:${c.kind}`)).toEqual(["t7:PICKUP", "t7:DROPOFF"]);
    // A stop done the plan leaves out stays (never the case: the optimizer heads each started route with its stops done).
    expect(planStopWrites(stored[0]!.stops, [], new Set(["t1-PICKUP"])).deleteIds).not.toContain("t1-PICKUP");
  });
});

describe("keepDoneMinutes", () => {
  it("leaves out the planned minute of a stop done, keeps the others", () => {
    const [out] = keepDoneMinutes([update("t2", "taxi_1")], new Set(["t2/PICKUP"]));
    expect(out!.data).toMatchObject({ plannedDropoffMinute: 690, status: "ASSIGNED" });
    expect(out!.data).not.toHaveProperty("plannedPickupMinute");
    expect(keepDoneMinutes([update("t2", "taxi_1")], new Set())[0]!.data.plannedPickupMinute).toBe(650);
  });
});
