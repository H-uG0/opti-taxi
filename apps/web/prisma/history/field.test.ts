import { describe, expect, it } from "vitest";
import { Rng } from "../seed/random";
import {
  cancellationsBeforePlanning,
  decideDayEvents,
  earliestTap,
  FIELD_BEHAVIOUR,
  fieldStatusUpdates,
  plannedTapMinute,
  simulateRouteTimes,
  stopRecorder,
  type DayTrip,
  type PlannedStop,
  type TripTiming,
} from "./field";

/** A patient's day: outbound and return of one recurrence, both on a route. */
function patientDay(index: number, routeId: string | null = "route-1"): DayTrip[] {
  const common = { patientId: `patient-${index}`, recurrenceId: `rec-${index}`, facilityId: "facility", routeId };
  const status = routeId ? "ASSIGNED" : "PLANNED";
  return [
    { ...common, id: `trip-${index}-out`, direction: "OUTBOUND", status },
    { ...common, id: `trip-${index}-ret`, direction: "RETURN", status },
  ];
}

const manyTrips = Array.from({ length: 3000 }, (_, i) => patientDay(i)).flat();

describe("cancellationsBeforePlanning", () => {
  it("cancels both legs of a few patients' day", () => {
    const cancelled = cancellationsBeforePlanning(manyTrips, "2026-10-12");
    const share = cancelled.size / manyTrips.length;
    expect(share).toBeGreaterThan(0);
    expect(share).toBeLessThan(FIELD_BEHAVIOUR.cancelledBeforePlanning * 3);
    for (const id of cancelled) expect(cancelled.has(id.replace(/-(out|ret)$/, id.endsWith("out") ? "-ret" : "-out"))).toBe(true);
  });
});

describe("decideDayEvents", () => {
  const events = decideDayEvents(manyTrips, "2026-10-12");

  it("gives about 2 % of absences and 1 to 2 % of cancellations", () => {
    const noShowShare = events.noShows.size / manyTrips.length;
    expect(noShowShare).toBeGreaterThan(0.012);
    expect(noShowShare).toBeLessThan(0.026);
    const cancelShare = events.cancellations.size / manyTrips.length;
    expect(cancelShare).toBeGreaterThan(0.008);
    expect(cancelShare).toBeLessThan(0.022);
  });

  it("never marks a trip both absent and cancelled", () => {
    for (const id of events.noShows) expect(events.cancellations.has(id)).toBe(false);
  });

  it("cancels most returns of patients absent at the outbound pickup", () => {
    const absentOutbound = [...events.noShows].filter((id) => id.endsWith("-out"));
    const returnsCancelled = absentOutbound.filter((id) => events.cancellations.get(id.replace("-out", "-ret")) === "AFTER_NO_SHOW");
    expect(returnsCancelled.length / absentOutbound.length).toBeGreaterThan(0.6);
    expect(returnsCancelled.length).toBeLessThan(absentOutbound.length + 1);
  });

  it("only declares absent a trip carried on a route, and ignores closed trips", () => {
    const unrouted = Array.from({ length: 2000 }, (_, i) => patientDay(i, null)).flat();
    const off = decideDayEvents(unrouted, "2026-10-12");
    expect(off.noShows.size).toBe(0);
    const closed = manyTrips.map((trip) => ({ ...trip, status: "DROPPED_OFF" as const }));
    const none = decideDayEvents(closed, "2026-10-12");
    expect(none.noShows.size + none.cancellations.size).toBe(0);
  });

  it("is deterministic", () => {
    const again = decideDayEvents([...manyTrips].reverse(), "2026-10-12");
    expect([...again.noShows].sort()).toEqual([...events.noShows].sort());
    expect([...again.cancellations].sort()).toEqual([...events.cancellations].sort());
  });
});

// ---------------------------------------------------------------------------

const HOME_A = { lat: 43.3, lng: 5.4 };
const HOME_B = { lat: 43.31, lng: 5.41 };
const CLINIC = { lat: 43.29, lng: 5.38 };

function stop(id: string, tripId: string, kind: "PICKUP" | "DROPOFF", sequence: number, at: { lat: number; lng: number }, arrival: number, start = arrival): PlannedStop {
  return { id, tripId, kind, sequence, ...at, arrivalMinute: arrival, startMinute: start, departureMinute: start + 5 };
}

/** Shared outbound ride: A then B picked up, both dropped at the clinic for 08:00; then B's return at 11:00. */
const sharedRide: PlannedStop[] = [
  stop("s1", "a-out", "PICKUP", 0, HOME_A, 430),
  stop("s2", "b-out", "PICKUP", 1, HOME_B, 440),
  stop("s3", "a-out", "DROPOFF", 2, CLINIC, 455),
  stop("s4", "b-out", "DROPOFF", 3, CLINIC, 455),
  stop("s5", "b-ret", "PICKUP", 4, CLINIC, 650, 660),
  stop("s6", "b-ret", "DROPOFF", 5, HOME_B, 685),
];
const timings = new Map<string, TripTiming>([
  ["a-out", { direction: "OUTBOUND", appointmentMinute: 480, readyMinute: null }],
  ["b-out", { direction: "OUTBOUND", appointmentMinute: 480, readyMinute: null }],
  ["b-ret", { direction: "RETURN", appointmentMinute: null, readyMinute: 660 }],
]);

describe("simulateRouteTimes", () => {
  it("records every stop, in sequence order, never going backwards", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { times } = simulateRouteTimes([...sharedRide].reverse(), timings, new Set(), new Rng(seed));
      expect(times.map((t) => t.stopId)).toEqual(["s1", "s2", "s3", "s4", "s5", "s6"]);
      const instants = times.map((t) => t.minute * 60 + t.second);
      for (let i = 1; i < instants.length; i++) expect(instants[i]).toBeGreaterThanOrEqual(instants[i - 1]!);
      for (const t of times) expect(t.second).toBeGreaterThanOrEqual(0);
    }
  });

  it("stays close to the plan, mostly on time", () => {
    const deltas: number[] = [];
    for (let seed = 1; seed <= 400; seed++) {
      const { times } = simulateRouteTimes(sharedRide, timings, new Set(), new Rng(seed));
      for (const t of times) {
        const planned = sharedRide.find((s) => s.id === t.stopId)!;
        deltas.push(t.minute - (t.kind === "PICKUP" ? planned.departureMinute : planned.startMinute));
      }
    }
    deltas.sort((a, b) => a - b);
    const median = deltas[Math.floor(deltas.length / 2)]!;
    expect(Math.abs(median)).toBeLessThanOrEqual(2);
    // A few minutes late now and then, rarely more than a quarter of an hour.
    expect(deltas.filter((d) => d >= 5).length).toBeGreaterThan(0);
    expect(deltas.filter((d) => d > 20).length / deltas.length).toBeLessThan(0.02);
  });

  function lateShare(stops: PlannedStop[], outboundPerRoute: number): number {
    let late = 0;
    for (let seed = 1; seed <= 2000; seed++) {
      const result = simulateRouteTimes(stops, timings, new Set(), new Rng(seed));
      late += result.lateTripIds.length;
      for (const tripId of result.lateTripIds) {
        const drop = result.times.find((t) => t.tripId === tripId && t.kind === "DROPOFF")!;
        expect(drop.minute).toBeGreaterThan(480);
        // Late by a few minutes, a quarter of an hour after an incident on the way, never absurdly.
        expect(drop.minute).toBeLessThanOrEqual(480 + 30);
      }
    }
    return late / (2000 * outboundPerRoute);
  }

  it("makes outbound patients late now and then when the plan arrives just in time (an incident on the way)", () => {
    const justInTime = [stop("j1", "a-out", "PICKUP", 0, HOME_A, 450), stop("j2", "a-out", "DROPOFF", 1, CLINIC, 480)];
    const share = lateShare(justInTime, 1);
    // Only after an incident on the leg (2 % per leg, with sampling noise): the rest is made up on the way.
    expect(share).toBeGreaterThan(0.002);
    expect(share).toBeLessThan(2 * FIELD_BEHAVIOUR.incidentPerLeg);
  });

  it("almost never with the plan's usual margin before the appointment", () => {
    expect(lateShare(sharedRide, 2)).toBeLessThan(0.02);
  });

  it("records the absence on the pickup and skips the drop-off of an absent patient", () => {
    const { times } = simulateRouteTimes(sharedRide, timings, new Set(["a-out"]), new Rng(7));
    expect(times.map((t) => t.stopId)).toEqual(["s1", "s2", "s4", "s5", "s6"]);
    // The crew waits a few minutes before declaring the absence.
    expect(times[0]!.minute).toBeGreaterThanOrEqual(430 + FIELD_BEHAVIOUR.noShowWaitMin[0] - 2);
  });

  it("never picks a return patient up before the end of the session", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const { times } = simulateRouteTimes(sharedRide, timings, new Set(), new Rng(seed));
      expect(times.find((t) => t.stopId === "s5")!.minute).toBeGreaterThanOrEqual(660);
    }
  });

  it("is deterministic for a seed and ignores stops of unknown trips", () => {
    const a = simulateRouteTimes(sharedRide, timings, new Set(), new Rng(42));
    const b = simulateRouteTimes(sharedRide, timings, new Set(), new Rng(42));
    expect(a).toEqual(b);
    const partial = simulateRouteTimes(sharedRide, new Map([["b-ret", timings.get("b-ret")!]]), new Set(), new Rng(1));
    expect(partial.times.map((t) => t.stopId)).toEqual(["s5", "s6"]);
  });

  /**
   * A return first (session ending 06:20, sometimes late), then an outbound
   * leg with a 2 min margin: pickup leaves 06:55, drop-off 07:25, appointment 07:27.
   */
  const chained = [
    stop("c1", "c-ret", "PICKUP", 0, CLINIC, 380),
    stop("c2", "c-ret", "DROPOFF", 1, HOME_B, 400),
    stop("c3", "a-out", "PICKUP", 2, HOME_A, 410),
    stop("c4", "a-out", "DROPOFF", 3, CLINIC, 445),
  ];
  const chainedTimings = new Map<string, TripTiming>([
    ["c-ret", { direction: "RETURN", appointmentMinute: null, readyMinute: 380 }],
    ["a-out", { direction: "OUTBOUND", appointmentMinute: 447, readyMinute: null }],
  ]);

  it("never records two statuses closer than the fastest possible drive and service", () => {
    for (const [stops, trips] of [
      [sharedRide, timings],
      [chained, chainedTimings],
    ] as const) {
      for (let seed = 1; seed <= 1500; seed++) {
        const { times } = simulateRouteTimes(stops, trips, new Set(), new Rng(seed));
        for (let i = 1; i < times.length; i++) {
          const prev = times[i - 1]!;
          const cur = times[i]!;
          const prevStop = stops.find((s) => s.id === prev.stopId)!;
          const curStop = stops.find((s) => s.id === cur.stopId)!;
          const recorded = (t: { minute: number; second: number }) => t.minute + t.second / 60;
          // Recorded times are truncated to the second: one second of tolerance.
          expect(recorded(cur)).toBeGreaterThanOrEqual(earliestTap({ stop: prevStop, tap: recorded(prev) }, curStop) - 1 / 60 - 1e-9);
        }
      }
    }
  });

  it("keeps a delay the drive cannot make up: the patient then arrives after the appointment", () => {
    let behind = 0;
    for (let seed = 1; seed <= 3000; seed++) {
      const { times, lateTripIds } = simulateRouteTimes(chained, chainedTimings, new Set(), new Rng(seed));
      const pickup = times.find((t) => t.stopId === "c3")!;
      const fastest = earliestTap({ stop: chained[2]!, tap: pickup.minute + pickup.second / 60 }, chained[3]!);
      if (Math.floor(fastest) <= 447) continue;
      behind++;
      expect(lateTripIds).toEqual(["a-out"]);
    }
    // A late session (up to 15 min) carried over two legs puts the crew out of reach of the appointment now and then.
    expect(behind).toBeGreaterThan(0);
  });
});

describe("earliestTap", () => {
  const pickup = stop("p", "a-out", "PICKUP", 0, HOME_A, 400); // leaves 405
  const dropoff = stop("d", "a-out", "DROPOFF", 1, CLINIC, 430); // « Déposé » planned 431

  it("takes at least 80 % of the planned drive and service time", () => {
    expect(plannedTapMinute(pickup)).toBe(405);
    expect(plannedTapMinute(dropoff)).toBe(431);
    expect(earliestTap({ stop: pickup, tap: 405 }, dropoff)).toBeCloseTo(405 + FIELD_BEHAVIOUR.minTimeRatio * 26);
    // 15 min behind at the pickup: at best 5 min are made up on this 26 min leg.
    expect(earliestTap({ stop: pickup, tap: 420 }, dropoff)).toBeCloseTo(420 + 20.8);
  });

  it("does not count the planned wait, which a crew behind schedule skips", () => {
    const waiting = stop("r", "b-ret", "PICKUP", 2, CLINIC, 640, 660); // arrives 10:40, picks up 11:00, leaves 11:05
    expect(earliestTap({ stop: dropoff, tap: 431 }, waiting)).toBeCloseTo(431 + FIELD_BEHAVIOUR.minTimeRatio * (665 - 431 - 20));
  });

  it("allows simultaneous statuses at one place but one minute between two places", () => {
    const sameTime = stop("d2", "b-out", "DROPOFF", 2, CLINIC, 430);
    expect(earliestTap({ stop: dropoff, tap: 431 }, sameTime)).toBe(431);
    const nextDoor = { ...pickup, id: "p2", sequence: 1, lat: HOME_A.lat + 0.001 };
    expect(earliestTap({ stop: pickup, tap: 405 }, nextDoor)).toBe(406);
  });
});

describe("fieldStatusUpdates", () => {
  it("closes only trips still ASSIGNED: dropped off, or absent at the pickup", () => {
    const updates = fieldStatusUpdates(["t2", "t1", "t1", "t3"], new Set(["t3", "t4"]));
    expect(updates).toEqual([
      { where: { id: { in: ["t1", "t2"] }, status: "ASSIGNED" }, data: { status: "DROPPED_OFF" } },
      { where: { id: { in: ["t3", "t4"] }, status: "ASSIGNED" }, data: { status: "NO_SHOW" } },
    ]);
    for (const update of updates) expect(update.where.status).toBe("ASSIGNED");
  });
});

describe("stopRecorder", () => {
  const accounts = new Map([
    ["driver-1", "user-1"],
    ["mate-1", "user-2"],
  ]);

  it("credits the driver's account on a one-person route", () => {
    expect(stopRecorder({ driverId: "driver-1", crewMateId: null }, accounts, "trip-1", "PICKUP")).toBe("user-1");
  });

  it("sometimes credits the crew mate of a two-person crew, stably for a trip and stop kind", () => {
    const crew = { driverId: "driver-1", crewMateId: "mate-1" };
    const recorders = Array.from({ length: 2000 }, (_, i) => stopRecorder(crew, accounts, `trip-${i}`, i % 2 ? "PICKUP" : "DROPOFF"));
    const mateShare = recorders.filter((id) => id === "user-2").length / recorders.length;
    expect(mateShare).toBeGreaterThan(FIELD_BEHAVIOUR.crewMateTaps - 0.04);
    expect(mateShare).toBeLessThan(FIELD_BEHAVIOUR.crewMateTaps + 0.04);
    expect(recorders.every((id) => id === "user-1" || id === "user-2")).toBe(true);
    expect(stopRecorder(crew, accounts, "trip-7", "PICKUP")).toBe(stopRecorder(crew, accounts, "trip-7", "PICKUP"));
  });

  it("falls back on the crew member who has an account, or none", () => {
    expect(stopRecorder({ driverId: "driver-2", crewMateId: "mate-1" }, accounts, "trip-1", "DROPOFF")).toBe("user-2");
    expect(stopRecorder({ driverId: null, crewMateId: null }, accounts, "trip-1", "DROPOFF")).toBeNull();
    expect(stopRecorder({ driverId: "driver-2", crewMateId: null }, accounts, "trip-1", "DROPOFF")).toBeNull();
  });
});
