import { describe, expect, it } from "vitest";
import { handOverCancellation, MAX_RUNS_PER_DAY, nextPlanningStep, unplacedTripIds } from "./planning";

describe("nextPlanningStep", () => {
  it("validates as soon as a round brings no refusal", () => {
    expect(nextPlanningStep(1, 0)).toBe("validate");
    expect(nextPlanningStep(MAX_RUNS_PER_DAY, 0)).toBe("validate");
  });

  it("re-optimizes after every round with a refusal, never turning it into an acceptance", () => {
    for (let runs = 1; runs < MAX_RUNS_PER_DAY; runs++) {
      expect(nextPlanningStep(runs, 1)).toBe("reoptimize");
      expect(nextPlanningStep(runs, 4)).toBe("reoptimize");
    }
  });

  it("gives the day up when refusals keep coming after the safety cap", () => {
    expect(nextPlanningStep(MAX_RUNS_PER_DAY, 1)).toBe("give-up");
    expect(nextPlanningStep(MAX_RUNS_PER_DAY + 1, 2)).toBe("give-up");
  });

  it("keeps room for several refusal rounds", () => {
    expect(MAX_RUNS_PER_DAY).toBeGreaterThanOrEqual(4);
  });
});

describe("hand-over to a partner company", () => {
  it("lists the open trips on no route, in a stable order", () => {
    const trips = [
      { id: "t3", status: "PLANNED" as const, routeId: null },
      { id: "t1", status: "PLANNED" as const, routeId: null },
      { id: "t2", status: "ASSIGNED" as const, routeId: "r1" },
      { id: "t4", status: "CANCELLED" as const, routeId: null },
      { id: "t5", status: "NO_SHOW" as const, routeId: null },
      { id: "t6", status: "ASSIGNED" as const, routeId: null },
    ];
    expect(unplacedTripIds(trips)).toEqual(["t1", "t3", "t6"]);
    expect(unplacedTripIds([...trips].reverse())).toEqual(["t1", "t3", "t6"]);
  });

  it("records a hand-over as cancelled by the regulator, reason « confiée à un confrère », never late", () => {
    const at = new Date("2026-11-02T17:12:00.000Z");
    expect(handOverCancellation("reg_1", at)).toEqual({
      cancellationReason: "PARTNER",
      cancellationOrigin: "USER",
      cancellationNote: null,
      cancelledAt: at,
      cancelledById: "reg_1",
      lateCancellation: false,
    });
  });
});
