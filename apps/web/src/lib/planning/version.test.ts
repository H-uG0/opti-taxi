import { describe, expect, it } from "vitest";
import { PLANNING_LOCK_NAMESPACE, planningLockKey } from "./day-lock";
import { isRunning, planVersionToken, runToken, type LatestRun, type PlanVersionParts } from "./version";

const parts: PlanVersionParts = {
  routes: 12,
  routesAt: new Date("2026-11-09T06:07:55.393Z"),
  stops: 124,
  trips: 64,
  tripsAt: new Date("2026-11-09T06:07:55.494Z"),
};

describe("planVersionToken", () => {
  it("is stable for the same plan and short, without any data of the plan in it", () => {
    expect(planVersionToken(parts)).toBe(planVersionToken({ ...parts }));
    expect(planVersionToken(parts)).toMatch(/^[\w-]{16}$/);
  });

  it("changes with any route, stop or trip change", () => {
    const base = planVersionToken(parts);
    expect(planVersionToken({ ...parts, routesAt: new Date("2026-11-09T06:08:00.000Z") })).not.toBe(base);
    expect(planVersionToken({ ...parts, stops: 122 })).not.toBe(base);
    expect(planVersionToken({ ...parts, trips: 63 })).not.toBe(base);
    expect(planVersionToken({ ...parts, tripsAt: new Date("2026-11-09T07:00:00.000Z") })).not.toBe(base);
    expect(planVersionToken({ routes: 0, routesAt: null, stops: 0, trips: 0, tripsAt: null })).not.toBe(base);
  });
});

describe("latest run", () => {
  const run: LatestRun = { id: "run1", status: "RUNNING", startedAt: new Date("2026-11-09T06:00:00Z"), tripsCount: 64 };

  it("has a token that changes with its status", () => {
    expect(runToken(null)).toBeNull();
    expect(runToken(run)).not.toBe(runToken({ ...run, status: "SUCCESS" }));
  });

  it("is running until its budget plus the margin is over (then it was interrupted)", () => {
    expect(isRunning(run, 10, new Date("2026-11-09T06:00:30Z"))).toBe(true);
    expect(isRunning(run, 10, new Date("2026-11-09T07:00:00Z"))).toBe(false);
    expect(isRunning({ ...run, status: "SUCCESS" }, 10, new Date("2026-11-09T06:00:30Z"))).toBe(false);
    expect(isRunning(null, 10, new Date())).toBe(false);
  });
});

describe("planningLockKey", () => {
  it("is one int4 pair per date", () => {
    expect(planningLockKey("1970-01-02")).toEqual([PLANNING_LOCK_NAMESPACE, 1]);
    expect(planningLockKey("2026-11-10")).toEqual([PLANNING_LOCK_NAMESPACE, 20767]);
    expect(planningLockKey("2026-11-11")[1]).toBe(20768);
    expect(PLANNING_LOCK_NAMESPACE).toBeLessThan(2 ** 31);
  });
});
