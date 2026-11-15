import { describe, expect, it } from "vitest";
import { projectDay, projectRoute, type LiveRouteInput, type LiveStopInput, type LiveTripInput } from "./live-day";

/** A stop: arrival, start, departure (service = departure - start). */
function stop(id: string, tripId: string, kind: "PICKUP" | "DROPOFF", sequence: number, arrival: number, start: number, departure: number, completed: number | null = null): LiveStopInput {
  return { id, tripId, kind, sequence, arrivalMinute: arrival, startMinute: start, departureMinute: departure, completedMinute: completed };
}

function trip(id: string, direction: "OUTBOUND" | "RETURN", extra: Partial<LiveTripInput> = {}): LiveTripInput {
  return { id, direction, status: "ASSIGNED", appointmentMinute: null, readyMinute: null, vehicleId: "v1", ...extra };
}

// 07:00 depot; A picked up 07:20-07:25, dropped 07:50-07:55 (RDV 08:00); B (return, ready 09:00) picked up 09:00-09:05, home 09:30.
const A = trip("a", "OUTBOUND", { appointmentMinute: 480 });
const B = trip("b", "RETURN", { readyMinute: 540 });
function route(completed: { a1?: number; a2?: number; b1?: number; b2?: number } = {}): LiveRouteInput {
  return {
    vehicleId: "v1",
    startMinute: 420,
    endMinute: 590,
    stops: [
      stop("s1", "a", "PICKUP", 1, 440, 440, 445, completed.a1 ?? null),
      stop("s2", "a", "DROPOFF", 2, 470, 470, 475, completed.a2 ?? null),
      // Planned wait: arrives 08:40 at the care place, starts at the end of the session (09:00).
      stop("s3", "b", "PICKUP", 3, 520, 540, 545, completed.b1 ?? null),
      stop("s4", "b", "DROPOFF", 4, 570, 570, 575, completed.b2 ?? null),
    ],
  };
}
const tripsOf = (list: LiveTripInput[]) => (id: string) => list.find((t) => t.id === id);

describe("projectRoute", () => {
  it("starts a stop no earlier than the lateness the crew announced on it, and carries it on (FLD-01)", () => {
    // 07:30: A picked up on time at 07:25; the crew announces +20 on the drop-off (planned 07:50).
    const p = projectRoute(route({ a1: 445 }), tripsOf([A, B]), 450, { "a/DROPOFF": 20 });
    expect(p.stops[1]).toMatchObject({ state: "pending", startMinute: 490, delayMinutes: 20 });
    expect(p.delayMinutes).toBe(20);
    // A lateness on a stop already done changes nothing.
    const done = projectRoute(route({ a1: 445, a2: 471 }), tripsOf([A, B]), 480, { "a/DROPOFF": 30 });
    expect(done.stops[1]).toMatchObject({ state: "done", startMinute: 471 });
    // Without an announcement, the drop-off is on time.
    expect(projectRoute(route({ a1: 445 }), tripsOf([A, B]), 450).stops[1]?.startMinute).toBe(470);
  });

  it("puts an appointment at risk from an announced lateness", () => {
    const day = projectDay({ routes: [route({ a1: 445 })], trips: [A, B], nowMinute: 450, maxTotalWaitMin: 45, lateness: { "a/DROPOFF": 20 } });
    expect(day.threatened).toEqual([{ tripId: "a", vehicleId: "v1", appointmentMinute: 480, projectedMinute: 490, lateMinutes: 10 }]);
  });

  it("reads a route not started yet, before its first stop, as on time", () => {
    const p = projectRoute(route(), tripsOf([A, B]), 430);
    expect(p.started).toBe(false);
    expect(p.delayMinutes).toBe(0);
    expect(p.silentSinceMinute).toBeNull();
    expect(p.stops.map((s) => s.startMinute)).toEqual([440, 470, 540, 570]);
    expect(p.nextStopId).toBe("s1");
  });

  it("flags a route silent 15 min after the first status was due, and pushes what follows to now", () => {
    // First tap due at 07:25 (« Pris en charge » once on board); 07:45 and nothing recorded.
    const p = projectRoute(route(), tripsOf([A, B]), 465);
    expect(p.silentSinceMinute).toBe(445);
    expect(p.stops[0]?.overdueMinutes).toBe(20);
    // Loading now at the earliest (departure 07:45), then the planned leg (25 min): drop-off 08:10, after the RDV.
    expect(p.stops[1]?.startMinute).toBe(490);
    expect(p.delayMinutes).toBe(20);
  });

  it("carries the delay of the latest status along the planned legs, absorbed by a planned wait", () => {
    // « Pris en charge » at 07:37 instead of 07:25: 12 min late.
    const p = projectRoute(route({ a1: 457 }), tripsOf([A, B]), 458);
    expect(p.started).toBe(true);
    expect(p.lastStatusMinute).toBe(457);
    expect(p.stops[0]).toMatchObject({ state: "done", startMinute: 452, departureMinute: 457, delayMinutes: 12 });
    expect(p.stops[1]).toMatchObject({ state: "pending", startMinute: 482, delayMinutes: 12 });
    // The 20 min waited before the return pickup absorb the 12 min.
    expect(p.stops[2]).toMatchObject({ startMinute: 540, delayMinutes: 0 });
    expect(p.closed).toBe(1);
    expect(p.total).toBe(4);
  });

  it("reads a stop without status before a recorded one as forgotten, anchored on the later status", () => {
    const p = projectRoute(route({ a2: 470 }), tripsOf([A, B]), 480);
    expect(p.stops[0]).toMatchObject({ state: "missing", overdueMinutes: 35 });
    expect(p.stops[1]).toMatchObject({ state: "done" });
    expect(p.nextStopId).toBe("s3");
    expect(p.finished).toBe(false);
  });

  it("starts a return pickup no earlier than the end of session the field signalled", () => {
    const later = { ...B, readyMinute: 570 };
    const p = projectRoute(route({ a1: 445, a2: 470 }), tripsOf([A, later]), 500);
    expect(p.stops[2]).toMatchObject({ startMinute: 570, delayMinutes: 30 });
    expect(p.stops[3]).toMatchObject({ startMinute: 600, delayMinutes: 30 });
  });

  it("goes on past an absent patient and a cancelled trip", () => {
    const absent = { ...A, status: "NO_SHOW" as const };
    const p = projectRoute(route({ a1: 450 }), tripsOf([absent, B]), 455);
    expect(p.stops[0]?.state).toBe("done");
    expect(p.stops[1]?.state).toBe("closed");
    expect(p.closed).toBe(2);
    expect(p.nextStopId).toBe("s3");
  });

  it("reads a stop done by its trip's status alone as closed at its planned times", () => {
    const dropped = { ...A, status: "DROPPED_OFF" as const };
    const p = projectRoute(route(), tripsOf([dropped, B]), 500);
    expect(p.stops.slice(0, 2).map((s) => s.state)).toEqual(["closed", "closed"]);
    expect(p.started).toBe(false);
    expect(p.nextStopId).toBe("s3");
  });

  it("is finished once every stop is closed", () => {
    const p = projectRoute(route({ a1: 445, a2: 470, b1: 545, b2: 570 }), tripsOf([A, B]), 600);
    expect(p.finished).toBe(true);
    expect(p.nextStopId).toBeNull();
    expect(p.delayMinutes).toBeNull();
  });
});

describe("projectDay", () => {
  it("lists the appointments the projection puts late, the overdue stops and the silent routes", () => {
    const silentRoute: LiveRouteInput = { ...route(), vehicleId: "v2", stops: route().stops.map((s) => ({ ...s, id: `x${s.id}`, tripId: `x${s.tripId}` })) };
    const day = projectDay({
      routes: [route({ a1: 470 }), silentRoute],
      trips: [A, B, { ...A, id: "xa", vehicleId: "v2" }, { ...B, id: "xb", vehicleId: "v2" }],
      nowMinute: 471,
      maxTotalWaitMin: 45,
    });
    // Picked up 25 min late: drop-off projected 08:15 for an 08:00 appointment.
    // Same appointment: the latest first (the silent route, loading now at the earliest).
    expect(day.threatened).toEqual([
      { tripId: "xa", vehicleId: "v2", appointmentMinute: 480, projectedMinute: 496, lateMinutes: 16 },
      { tripId: "a", vehicleId: "v1", appointmentMinute: 480, projectedMinute: 495, lateMinutes: 15 },
    ]);
    expect(day.silent).toEqual([{ vehicleId: "v2", sinceMinute: 445, minutes: 26 }]);
    // The silent route's first stop is not listed again.
    expect(day.overdue).toEqual([]);
  });

  it("lists a return whose wait at the care place goes over the limit, with or without a vehicle", () => {
    // B ready at 08:00 (session ended early), picked up at 09:00 as planned; A dropped 07:50 for 08:00 (10 min before).
    const early = { ...B, readyMinute: 480, otherLegTripId: "a" };
    const loose = trip("c", "RETURN", { readyMinute: 470, vehicleId: null });
    const day = projectDay({ routes: [route({ a1: 445, a2: 470 })], trips: [{ ...A, otherLegTripId: "b" }, early, loose], nowMinute: 530, maxTotalWaitMin: 45 });
    expect(day.longWaits).toEqual([
      { tripId: "b", vehicleId: "v1", waitMinutes: 70, afterMinutes: 60, beforeMinutes: 10 },
      { tripId: "c", vehicleId: null, waitMinutes: 60, afterMinutes: 60, beforeMinutes: 0 },
    ]);
  });

  it("leaves out the return of a patient absent on the outbound leg", () => {
    const absent = { ...A, status: "NO_SHOW" as const, otherLegTripId: "b" };
    const day = projectDay({ routes: [route({ a1: 450 })], trips: [absent, { ...B, readyMinute: 480, otherLegTripId: "a" }], nowMinute: 530, maxTotalWaitMin: 45 });
    expect(day.longWaits).toEqual([]);
  });

  it("lists an overdue next stop of a started route", () => {
    // Dropped off at 07:50 as planned; the return pickup was due at 09:05, it is 09:20.
    const day = projectDay({ routes: [route({ a1: 445, a2: 470 })], trips: [A, B], nowMinute: 560, maxTotalWaitMin: 45 });
    expect(day.overdue).toEqual([{ stopId: "s3", tripId: "b", vehicleId: "v1", kind: "PICKUP", minutes: 15, missing: false }]);
    expect(day.silent).toEqual([]);
  });
});
