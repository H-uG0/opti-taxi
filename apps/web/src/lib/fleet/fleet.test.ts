import { describe, expect, it } from "vitest";
import { unavailabilityOn, unavailabilityText } from "./availability";
import { consumptionStats, energyUnit, type FuelEntry } from "./consumption";
import { complianceAlerts, deadlineAlerts, deadlineState, type Deadline } from "./maintenance";

const TODAY = "2026-11-08";

function deadline(overrides: Partial<Deadline>): Deadline {
  return { kind: "SERVICE", label: null, dueDate: null, dueKm: null, doneDate: null, ...overrides };
}

describe("vehicle unavailability", () => {
  it("covers both bounds", () => {
    const list = [{ vehicleId: "v", kind: "REPAIR" as const, startDate: "2026-11-10", endDate: "2026-11-12" }];
    expect(unavailabilityOn("v", "2026-11-10", list)).not.toBeNull();
    expect(unavailabilityOn("v", "2026-11-12", list)).not.toBeNull();
    expect(unavailabilityOn("v", "2026-11-13", list)).toBeNull();
    expect(unavailabilityOn("w", "2026-11-11", list)).toBeNull();
    expect(unavailabilityText({ kind: "ON_CALL", startDate: "2026-11-11", endDate: "2026-11-11" })).toBe("Garde le 11/11/2026");
  });
});

describe("deadlineState", () => {
  it("tells overdue, soon and ok by date", () => {
    expect(deadlineState(deadline({ dueDate: "2026-11-01" }), TODAY, null)).toEqual({ status: "overdue", text: "Dépassée depuis le 01/11/2026" });
    expect(deadlineState(deadline({ dueDate: "2026-11-20" }), TODAY, null)).toEqual({ status: "soon", text: "Dans 12 j (20/11/2026)" });
    expect(deadlineState(deadline({ dueDate: "2027-03-01" }), TODAY, null).status).toBe("ok");
  });

  it("tells overdue and soon by mileage, ignores it without a reading", () => {
    expect(deadlineState(deadline({ dueKm: 90_000 }), TODAY, 90_400).status).toBe("overdue");
    expect(deadlineState(deadline({ dueKm: 90_000 }), TODAY, 89_300)).toEqual({ status: "soon", text: "Dans 700 km" });
    expect(deadlineState(deadline({ dueKm: 90_000 }), TODAY, null).status).toBe("ok");
  });

  it("keeps the worst of date and mileage, and a done deadline is done", () => {
    const both = deadlineState(deadline({ dueDate: "2027-03-01", dueKm: 90_000 }), TODAY, 89_500);
    expect(both.status).toBe("soon");
    expect(both.text).toBe("Le 01/03/2027 · Dans 500 km");
    expect(deadlineState(deadline({ dueDate: "2026-11-01", doneDate: "2026-10-30" }), TODAY, null)).toEqual({
      status: "done",
      text: "Fait le 30/10/2026",
    });
  });

  it("lists the alerts, overdue first", () => {
    const list = [deadline({ kind: "INSURANCE", dueDate: "2026-11-15" }), deadline({ kind: "INSPECTION", dueDate: "2026-11-01" }), deadline({ dueDate: "2027-06-01" })];
    expect(deadlineAlerts(list, TODAY, null).map((a) => a.deadline.kind)).toEqual(["INSPECTION", "INSURANCE"]);
  });
});

describe("consumptionStats", () => {
  const fill = (date: string, odometerKm: number, quantity: number, cost: number, fullTank = true): FuelEntry => ({ date, odometerKm, quantity, cost, fullTank });

  it("measures between the first and the last full tank, partial fills included", () => {
    const stats = consumptionStats([
      fill("2026-10-01", 50_000, 40, 70),
      fill("2026-10-08", 50_400, 10, 18, false),
      fill("2026-10-15", 50_900, 45, 80),
      fill("2026-10-20", 51_100, 12, 21, false), // after the last full tank: not counted yet
    ]);
    expect(stats).toEqual({ odometerKm: 51_100, odometerDate: "2026-10-20", measuredKm: 900, per100Km: 6.1, costPerKm: 0.109 });
  });

  it("needs two full tanks to measure, and gives the last reading anyway", () => {
    expect(consumptionStats([fill("2026-10-01", 50_000, 40, 70)])).toMatchObject({ odometerKm: 50_000, per100Km: null, costPerKm: null });
    expect(consumptionStats([])).toMatchObject({ odometerKm: null, per100Km: null });
  });

  it("counts kWh for an electric vehicle, litres otherwise", () => {
    expect(energyUnit("ELECTRIC")).toBe("kWh");
    expect(energyUnit("DIESEL")).toBe("L");
    expect(energyUnit(null)).toBe("L");
  });
});

describe("complianceAlerts (inspection and insurance on the service date)", () => {
  const deadline = (overrides: Partial<Deadline>): Deadline => ({
    kind: "INSPECTION",
    label: null,
    dueDate: "2026-11-09",
    dueKm: null,
    doneDate: null,
    ...overrides,
  });

  it("reports an inspection or insurance already overdue on the service date", () => {
    expect(complianceAlerts([deadline({})], "2026-11-10", null)).toEqual(["Contrôle technique : échéance dépassée (09/11/2026)"]);
    expect(complianceAlerts([deadline({ kind: "INSURANCE", label: "AXA" })], "2026-11-10", null)).toEqual([
      "Assurance (AXA) : échéance dépassée (09/11/2026)",
    ]);
  });

  it("is judged on the service date, not today: due that day is still met, done or other kinds are ignored", () => {
    expect(complianceAlerts([deadline({})], "2026-11-09", null)).toEqual([]);
    expect(complianceAlerts([deadline({ doneDate: "2026-11-08" })], "2026-11-10", null)).toEqual([]);
    expect(complianceAlerts([deadline({ kind: "SERVICE" }), deadline({ kind: "TIRES" })], "2026-11-10", null)).toEqual([]);
  });

  it("counts a mileage deadline passed at the last odometer reading", () => {
    expect(complianceAlerts([deadline({ dueDate: null, dueKm: 120_000 })], "2026-11-10", 121_000)).toEqual([
      "Contrôle technique : échéance dépassée",
    ]);
  });
});
