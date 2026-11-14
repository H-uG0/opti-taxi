import { describe, expect, it } from "vitest";
import { interruptionMessage, planInterruption, type InterruptStop } from "./interruption";

const DONE = new Date("2026-11-14T09:00:00Z");

function stop(tripId: string, kind: "PICKUP" | "DROPOFF", sequence: number, start: number, completedAt: Date | null = null): InterruptStop {
  return { id: `${tripId}-${kind}`, tripId, kind, sequence, startMinute: start, departureMinute: start + 5, completedAt };
}

/** t1 dropped off, t2 on board, t3 and t4 still to do (t4 ends at 13:05). */
const stops = [
  stop("t1", "PICKUP", 0, 480, DONE),
  stop("t1", "DROPOFF", 1, 510, DONE),
  stop("t2", "PICKUP", 2, 600, DONE),
  stop("t2", "DROPOFF", 3, 650),
  stop("t3", "PICKUP", 4, 700),
  stop("t4", "PICKUP", 5, 720),
  stop("t4", "DROPOFF", 6, 780),
  stop("t3", "DROPOFF", 7, 800),
];

describe("planInterruption (DAY-03)", () => {
  it("from now: keeps what was done, picks a patient on board up again, takes off what is not picked up", () => {
    const plan = planInterruption({ stops, statusOf: () => undefined, fromMinute: 620, nowMinute: 625 });
    expect(plan.keptStopIds).toEqual(["t1-PICKUP", "t1-DROPOFF", "t2-PICKUP"]);
    expect(plan.removedStopIds).toEqual(["t2-DROPOFF", "t3-PICKUP", "t4-PICKUP", "t4-DROPOFF", "t3-DROPOFF"]);
    expect(plan.interruptedTripIds).toEqual(["t2"]);
    expect(plan.detachedTripIds).toEqual(["t3", "t4"]);
    expect(plan.lastDoneStopId).toBe("t2-PICKUP");
    expect(plan.lastKeptDeparture).toBe(605);
  });

  it("reads a stop done from its trip's status too (picked up on the phone before the stop was recorded)", () => {
    const plan = planInterruption({
      stops: stops.map((s) => ({ ...s, completedAt: null })),
      statusOf: (id) => (id === "t1" ? "DROPPED_OFF" : id === "t2" ? "PICKED_UP" : "ASSIGNED"),
      fromMinute: 620,
      nowMinute: 625,
    });
    expect(plan.interruptedTripIds).toEqual(["t2"]);
    expect(plan.detachedTripIds).toEqual(["t3", "t4"]);
  });

  it("from a later time: keeps the trips planned to end before it and the patient on board, takes off the others", () => {
    const plan = planInterruption({ stops, statusOf: () => undefined, fromMinute: 790, nowMinute: 625 });
    // t4 ends at 13:05 (785), before 13:10; t3 ends after.
    expect(plan.detachedTripIds).toEqual(["t3"]);
    expect(plan.keptOnBoardTripIds).toEqual(["t2"]);
    expect(plan.interruptedTripIds).toEqual([]);
    expect(plan.removedStopIds).toEqual(["t3-PICKUP", "t3-DROPOFF"]);
    // A later date: nothing is under way; t1 and t2 end before 11:40.
    expect(planInterruption({ stops: stops.map((s) => ({ ...s, completedAt: null })), statusOf: () => undefined, fromMinute: 700, nowMinute: null }).detachedTripIds).toEqual([
      "t3",
      "t4",
    ]);
  });

  it("says what it did", () => {
    const plan = planInterruption({ stops, statusOf: () => undefined, fromMinute: 620, nowMinute: 625 });
    expect(interruptionMessage({ vehicleLabel: "Taxi 3 (Aix)", who: "VEHICLE", fromMinute: 620, plan })).toBe(
      "Taxi 3 (Aix) hors service à partir de 10:20\u00a0: 3 courses à replacer, 1 patient à bord repris au lieu du dernier arrêt (1 course de reprise créée).",
    );
    const later = planInterruption({ stops, statusOf: () => undefined, fromMinute: 790, nowMinute: 625 });
    expect(interruptionMessage({ vehicleLabel: "VSL 2", who: "DRIVER", fromMinute: 790, plan: later })).toBe(
      "VSL 2 sans chauffeur à partir de 13:10\u00a0: 1 course à replacer, 1 patient à bord reste jusqu'à sa dépose.",
    );
  });
});
