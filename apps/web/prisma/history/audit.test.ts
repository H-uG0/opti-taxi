import { describe, expect, it } from "vitest";
import { DayAuditTrail, SIMULATED_ACTIONS, sharingAuditAction, stopAuditAction } from "./audit";
import { isHistoryId } from "./ids";
import { simulatedRowsWhere } from "./ownership";

const regulator = { id: "regulator-1", role: "REGULATOR" as const };
const at = new Date("2026-10-11T15:02:10.000Z");

describe("DayAuditTrail", () => {
  it("writes the app's event row with the instant of the action and a hist- id of the day", () => {
    const trail = new DayAuditTrail("2026-10-12");
    expect(trail.event(regulator, "plan.optimize", "hist-20261012-run1", at)).toEqual({
      id: "hist-20261012-ev0001",
      at,
      userId: "regulator-1",
      role: "REGULATOR",
      action: "plan.optimize",
      entity: "OptimizationRun",
      entityId: "hist-20261012-run1",
      serviceDate: new Date("2026-10-12T00:00:00.000Z"),
    });
    const validation = trail.event(regulator, "plan.validate", null, at);
    expect(validation).toMatchObject({ id: "hist-20261012-ev0002", entity: "Route", entityId: null });
  });

  it("numbers the events of a day without repeating an id, and the re-run filter matches them", () => {
    const trail = new DayAuditTrail("2026-10-12");
    const events = Array.from({ length: 300 }, (_, i) =>
      trail.event({ id: null, role: "DRIVER" }, "stop.pickup", `stop-${i}`, at),
    );
    expect(new Set(events.map((event) => event.id)).size).toBe(300);
    expect(events.every((event) => isHistoryId(event.id))).toBe(true);
    const own = simulatedRowsWhere(new Date("2026-10-12T00:00:00.000Z")).events;
    expect(own).toEqual({ serviceDate: events[0]?.serviceDate, id: { startsWith: "hist-" } });
  });

  it("names the entity of each simulated action as the app does", () => {
    expect(SIMULATED_ACTIONS).toEqual({
      "plan.optimize": "OptimizationRun",
      "plan.validate": "Route",
      "trip.sharing_accept": "Trip",
      "trip.sharing_refuse": "Trip",
      "trip.cancel": "Trip",
      "stop.pickup": "Trip",
      "stop.dropoff": "Trip",
      "stop.no_show": "Trip",
    });
  });
});

describe("actions of the recorded changes", () => {
  it("traces a sharing answer as accepted or refused", () => {
    expect(sharingAuditAction("ACCEPTED")).toBe("trip.sharing_accept");
    expect(sharingAuditAction("REFUSED")).toBe("trip.sharing_refuse");
  });

  it("traces « Patient absent » on the pickup stop", () => {
    expect(stopAuditAction("PICKUP", false)).toBe("stop.pickup");
    expect(stopAuditAction("PICKUP", true)).toBe("stop.no_show");
    expect(stopAuditAction("DROPOFF", false)).toBe("stop.dropoff");
  });
});
