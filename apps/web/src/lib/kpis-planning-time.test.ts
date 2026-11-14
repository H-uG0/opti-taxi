import { describe, expect, it } from "vitest";
import {
  addPlanningTime,
  emptyPlanningTime,
  interventionCount,
  medianInitialMinutes,
  medianTouchUpMinutes,
  PLANNING_ACTIONS,
  planningTimeOfDay,
} from "./kpis-planning-time";
import type { KpiActivity, KpiRun } from "./kpis-rows";

const DATE = "2026-11-10";

/** Paris time (November: UTC+1) on `date`. */
function at(date: string, hhmm: string): Date {
  return new Date(`${date}T${hhmm}:00+01:00`);
}

function act(date: string, hhmm: string, action: string, userId = "reg"): KpiActivity {
  return { serviceDate: DATE, at: at(date, hhmm), action, userId };
}

function run(date: string, hhmm: string, userId = "reg"): KpiRun {
  return { serviceDate: DATE, startedAt: at(date, hhmm), requestedById: userId };
}

describe("planningTimeOfDay", () => {
  it("separates a reopening on the day itself from the initial build (the wall clock read 13 h 25)", () => {
    const p = planningTimeOfDay(
      [
        act("2026-11-09", "17:00", "plan.view"),
        act("2026-11-09", "17:02", "plan.optimize"),
        act("2026-11-09", "17:10", "trip.sharing_accept"),
        act("2026-11-09", "17:22", "trip.lock"),
        act("2026-11-09", "17:30", "plan.validate"),
        // A call on the morning of the day: reopened, one trip moved, validated again.
        act(DATE, "06:45", "plan.reopen"),
        act(DATE, "06:50", "trip.move"),
        act(DATE, "06:51", "plan.optimize"),
        act(DATE, "06:55", "plan.validate"),
      ],
      [run("2026-11-09", "17:01"), run(DATE, "06:50")],
    );
    expect(p?.initialMinutes).toBe(30);
    expect(p?.touchUpMinutes).toBe(10);
    expect(p?.sessions).toBe(2);
    expect(p?.firstValidationAt).toEqual(at("2026-11-09", "17:30"));
    // The move's own recomputation is not a re-optimization.
    expect(p?.interventions).toEqual({ moves: 1, locks: 1, reoptimizations: 0 });
  });

  it("adds the sessions of a day optimized 3 days before, never the days in between", () => {
    const p = planningTimeOfDay(
      [
        act("2026-11-06", "10:00", "plan.view"),
        act("2026-11-06", "10:04", "plan.optimize"),
        act("2026-11-06", "10:12", "trip.sharing_refuse"),
        // Sunday evening: the planning is finished and validated.
        act("2026-11-08", "18:00", "plan.view"),
        act("2026-11-08", "18:05", "plan.optimize"),
        act("2026-11-08", "18:20", "plan.validate"),
      ],
      [run("2026-11-06", "10:03"), run("2026-11-08", "18:04")],
    );
    expect(p?.initialMinutes).toBe(12 + 20);
    expect(p?.touchUpMinutes).toBe(0);
    expect(p?.interventions.reoptimizations).toBe(1);
  });

  it("cuts a session after 15 minutes without an action and gives a lone click one minute", () => {
    const p = planningTimeOfDay([act(DATE, "08:00", "plan.optimize"), act(DATE, "08:16", "trip.lock"), act(DATE, "08:20", "plan.validate")]);
    // 08:00 alone (1 min), then 08:16 → 08:20 (4 min).
    expect(p?.initialMinutes).toBe(5);
    expect(p?.sessions).toBe(2);
  });

  it("does not count a session that only reads the planning", () => {
    const p = planningTimeOfDay([
      act(DATE, "08:00", "plan.optimize"),
      act(DATE, "08:05", "plan.validate"),
      act(DATE, "14:00", "plan.view"),
      act(DATE, "14:10", "plan.view"),
    ]);
    expect(p?.initialMinutes).toBe(5);
    expect(p?.touchUpMinutes).toBe(0);
    expect(p?.sessions).toBe(1);
  });

  it("keeps the people apart: two regulators working at once count their own time", () => {
    const p = planningTimeOfDay([
      act(DATE, "08:00", "plan.optimize", "a"),
      act(DATE, "08:10", "trip.lock", "a"),
      act(DATE, "08:02", "trip.sharing_accept", "b"),
      act(DATE, "08:12", "trip.sharing_accept", "b"),
      act(DATE, "08:20", "plan.validate", "a"),
    ]);
    expect(p?.initialMinutes).toBe(20 + 10);
  });

  it("is not validated while no plan.validate was recorded (its time so far apart), null without any change", () => {
    const p = planningTimeOfDay([act(DATE, "08:00", "plan.optimize"), act(DATE, "08:12", "trip.move")]);
    expect(p).toMatchObject({ initialMinutes: null, pendingMinutes: 12, touchUpMinutes: 0, firstValidationAt: null });
    expect(planningTimeOfDay([act(DATE, "08:00", "plan.view")])).toBeNull();
    expect(planningTimeOfDay([])).toBeNull();
  });

  it("counts the interventions after the first optimization only", () => {
    const p = planningTimeOfDay([
      act(DATE, "07:50", "trip.lock"),
      act(DATE, "08:00", "plan.optimize"),
      act(DATE, "08:05", "plan.lock"),
      act(DATE, "08:06", "plan.unlock"),
      act(DATE, "08:07", "trip.move"),
      act(DATE, "08:20", "plan.optimize"),
      act(DATE, "08:25", "plan.restore"),
    ]);
    // The plan.optimize 13 min after the move is a re-optimization of its own.
    expect(p?.interventions).toEqual({ moves: 1, locks: 2, reoptimizations: 2 });
    expect(interventionCount(p!.interventions)).toBe(5);
  });

  it("reads the actions the dashboard loads", () => {
    expect(PLANNING_ACTIONS).toEqual(expect.arrayContaining(["plan.optimize", "plan.validate", "trip.move", "trip.lock", "plan.view"]));
    expect(PLANNING_ACTIONS).not.toContain("trip.generate");
    expect(PLANNING_ACTIONS).not.toContain("stop.dropoff");
  });
});

describe("period planning time", () => {
  it("takes the medians of the validated days and sums the interventions", () => {
    const build = (...times: string[]) => times.map((time, i) => act(DATE, time, i === 0 ? "plan.optimize" : "trip.sharing_accept"));
    const days = [
      planningTimeOfDay([...build("08:00", "08:10"), act(DATE, "08:20", "plan.validate")]),
      planningTimeOfDay([...build("08:00", "08:15"), act(DATE, "08:30", "plan.validate"), act(DATE, "09:00", "trip.move")]),
      // Reopened: a long touch-up does not move the median of the builds.
      planningTimeOfDay([...build("08:00", "08:15", "08:30"), act(DATE, "08:40", "plan.validate"), act(DATE, "20:00", "plan.reopen"), act(DATE, "20:30", "plan.validate")]),
      planningTimeOfDay([act(DATE, "08:00", "plan.optimize")]),
      null,
    ];
    const totals = days.reduce(addPlanningTime, emptyPlanningTime());
    expect(totals.initial).toEqual([20, 30, 40]);
    expect(medianInitialMinutes(totals)).toBe(30);
    expect(medianTouchUpMinutes(totals)).toBe(1);
    expect(totals.measuredDays).toBe(4);
    expect(totals.interventions.moves).toBe(1);
    expect(totals.validatedInterventions).toBe(1);
  });
});
