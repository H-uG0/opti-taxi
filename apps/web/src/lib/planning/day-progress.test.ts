import { describe, expect, it } from "vitest";
import { buildProgress, doneKeys, doneOnRoutes, minuteOn, planHoldsProgress, startedOutsideProgress, type ProgressRoute } from "./day-progress";

/** 11:00 in Paris on 2026-11-14 (UTC+1). */
const NOW = new Date("2026-11-14T10:00:00Z");
const at = (hhmm: string) => new Date(`2026-11-14T${hhmm}:00+01:00`);

const request = {
  vehicles: [{ id: "taxi_1" }, { id: "taxi_2" }],
  trips: [{ id: "t1" }, { id: "t2", pickupServiceMin: 10 }, { id: "t3" }],
  settings: { pickupServiceMin: 5, dropoffServiceMin: 5 },
} as never;

function route(overrides: Partial<ProgressRoute> = {}): ProgressRoute {
  return {
    vehicleId: "taxi_1",
    breakStartMinute: 720,
    breakEndMinute: 765,
    stops: [
      { tripId: "t1", kind: "PICKUP", sequence: 0, startMinute: 480, departureMinute: 485, completedAt: at("08:07") },
      { tripId: "t1", kind: "DROPOFF", sequence: 1, startMinute: 510, departureMinute: 515, completedAt: at("08:31") },
      { tripId: "t2", kind: "PICKUP", sequence: 2, startMinute: 600, departureMinute: 610, completedAt: at("10:12") },
      { tripId: "t2", kind: "DROPOFF", sequence: 3, startMinute: 640, departureMinute: 645, completedAt: null },
      { tripId: "t3", kind: "PICKUP", sequence: 4, startMinute: 700, departureMinute: 705, completedAt: null },
      { tripId: "t3", kind: "DROPOFF", sequence: 5, startMinute: 730, departureMinute: 735, completedAt: null },
    ],
    ...overrides,
  };
}

describe("buildProgress", () => {
  it("gives the stops done with their real times, the minute of now, and nothing for the other days", () => {
    const progress = buildProgress({ isoDate: "2026-11-14", now: NOW, routes: [route()], statusOf: () => undefined, request });
    expect(progress?.nowMin).toBe(660);
    expect(progress?.routes).toEqual([
      {
        vehicleId: "taxi_1",
        done: [
          // « Pris en charge » at 08:07 is the departure; « Déposé » at 08:31 the start.
          { tripId: "t1", kind: "PICKUP", startMin: 482, departureMin: 487 },
          { tripId: "t1", kind: "DROPOFF", startMin: 511, departureMin: 516 },
          { tripId: "t2", kind: "PICKUP", startMin: 602, departureMin: 612 },
        ],
        // Planned at 12:00: not taken yet at 11:00.
        breakTaken: null,
      },
    ]);
    expect(buildProgress({ isoDate: "2026-11-15", now: NOW, routes: [route()], statusOf: () => undefined, request })).toBeNull();
  });

  it("counts a planned break as taken once it has begun, and a stop done by its trip's status at its planned times", () => {
    const noon = new Date("2026-11-14T11:10:00Z");
    const progress = buildProgress({
      isoDate: "2026-11-14",
      now: noon,
      routes: [route()],
      statusOf: (id) => (id === "t2" ? "DROPPED_OFF" : undefined),
      request,
    });
    const done = progress?.routes?.[0];
    expect(done?.breakTaken).toEqual({ startMin: 720, endMin: 765 });
    expect(done?.done.at(-1)).toEqual({ tripId: "t2", kind: "DROPOFF", startMin: 640, departureMin: 645 });
  });

  it("leaves out the routes without a stop done, the vehicles and trips not sent, and a dropoff without its pickup", () => {
    const progress = buildProgress({
      isoDate: "2026-11-14",
      now: NOW,
      routes: [
        route({ vehicleId: "taxi_2", stops: route().stops.map((s) => ({ ...s, completedAt: null })) }),
        route({ vehicleId: "taxi_9" }),
        route({
          vehicleId: "taxi_1",
          stops: [
            { tripId: "t9", kind: "PICKUP", sequence: 0, startMinute: 480, departureMinute: 485, completedAt: at("08:00") },
            { tripId: "t3", kind: "DROPOFF", sequence: 1, startMinute: 500, departureMinute: 505, completedAt: at("08:20") },
          ],
        }),
      ],
      statusOf: () => undefined,
      request,
    });
    expect(progress).toEqual({ nowMin: 660, routes: [] });
  });

  it("reads a minute past midnight as the next day's, and clamps the days before", () => {
    expect(minuteOn(new Date("2026-11-14T23:30:00Z"), "2026-11-14")).toBe(24 * 60 + 30);
    expect(minuteOn(new Date("2026-11-13T22:00:00Z"), "2026-11-14")).toBe(0);
  });
});

describe("planHoldsProgress", () => {
  const progress = {
    nowMin: 660,
    routes: [{ vehicleId: "taxi_1", done: [{ tripId: "t1", kind: "PICKUP" as const, startMin: 480, departureMin: 485 }] }],
  };
  const stops = (...keys: string[]) => keys.map((key) => ({ tripId: key.split("/")[0]!, kind: key.split("/")[1] as "PICKUP" | "DROPOFF" }));

  it("holds while every stop done heads its vehicle's route in the plan", () => {
    expect(planHoldsProgress({ routes: [{ vehicleId: "taxi_1", stops: stops("t1/PICKUP", "t2/PICKUP", "t1/DROPOFF", "t2/DROPOFF") }] }, progress)).toBe(true);
    expect(planHoldsProgress({ routes: [] }, null)).toBe(true);
  });

  it("fails once a driver did a stop the plan moves away, puts later or leaves out", () => {
    expect(planHoldsProgress({ routes: [{ vehicleId: "taxi_2", stops: stops("t1/PICKUP", "t1/DROPOFF") }] }, progress)).toBe(false);
    expect(planHoldsProgress({ routes: [{ vehicleId: "taxi_1", stops: stops("t2/PICKUP", "t1/PICKUP", "t1/DROPOFF", "t2/DROPOFF") }] }, progress)).toBe(false);
    expect(planHoldsProgress({ routes: [{ vehicleId: "taxi_1", stops: stops("t2/PICKUP", "t2/DROPOFF") }] }, progress)).toBe(false);
  });

  it("lists the stops done as keys", () => {
    expect([...doneKeys(progress)]).toEqual(["t1/PICKUP"]);
  });
});

describe("startedOutsideProgress (a vehicle the request no longer sends)", () => {
  it("leaves out of the request the trips started on a route the progress does not carry, and those recorded by the field alone", () => {
    // Taxi 2 was made unavailable for the whole day after t1 was dropped off and t2 picked up: it is not sent.
    const routes = [route({ vehicleId: "taxi_9" })];
    const statusOf = (id: string) => (({ t1: "DROPPED_OFF", t2: "PICKED_UP", t3: "ASSIGNED" }) as const)[id as "t1" | "t2" | "t3"];
    const progress = buildProgress({ isoDate: "2026-11-14", now: NOW, routes, statusOf, request });
    expect(progress?.routes).toEqual([]);
    expect([...startedOutsideProgress({ routes, statusOf, tripIds: ["t1", "t2", "t3"], progress: progress! })]).toEqual(["t1", "t2"]);
    // Carried by the progress of a vehicle sent: nothing left out; a trip picked up with no stop on any route is.
    const sentRoutes = [route()];
    const carried = buildProgress({ isoDate: "2026-11-14", now: NOW, routes: sentRoutes, statusOf, request })!;
    expect([...startedOutsideProgress({ routes: sentRoutes, statusOf, tripIds: ["t1", "t2", "t3"], progress: carried })]).toEqual([]);
    const loose = (id: string) => (id === "t3" ? "PICKED_UP" : statusOf(id));
    expect([...startedOutsideProgress({ routes: sentRoutes, statusOf: loose, tripIds: ["t1", "t2", "t3"], progress: carried })]).toEqual(["t3"]);
  });
});

describe("doneOnRoutes (a held plan checked under the locks)", () => {
  it("reads the stops done as the progress would carry them, without their times", () => {
    expect(doneOnRoutes({ routes: [route(), route({ vehicleId: "taxi_9" })], statusOf: () => undefined, request })).toEqual({
      routes: [
        {
          vehicleId: "taxi_1",
          done: [
            { tripId: "t1", kind: "PICKUP" },
            { tripId: "t1", kind: "DROPOFF" },
            { tripId: "t2", kind: "PICKUP" },
          ],
        },
      ],
    });
    // A stop done since the request was built: a plan that moved that trip no longer holds.
    const now = doneOnRoutes({ routes: [route()], statusOf: (id) => (id === "t3" ? "PICKED_UP" : undefined), request });
    const plan = { routes: [{ vehicleId: "taxi_1", stops: route().stops.filter((s) => s.tripId !== "t3") }, { vehicleId: "taxi_2", stops: route().stops.filter((s) => s.tripId === "t3") }] };
    expect(planHoldsProgress(plan, now)).toBe(false);
  });
});
