import { describe, expect, it } from "vitest";
import { energyRates, groupEnergy, sumEnergy, vehicleEnergy, type EnergyVehicle } from "./kpis-energy";
import type { FuelEntry } from "./fleet/consumption";

const diesel: EnergyVehicle = { id: "v1", label: "Taxi 1", type: "TAXI", depotId: "gap", energy: "DIESEL", costPerKm: 0.3 };
const electric: EnergyVehicle = { id: "v2", label: "Taxi 2", type: "TAXI", depotId: "gap", energy: "ELECTRIC", costPerKm: 0.2 };

function fill(date: string, odometerKm: number, quantity: number, cost: number, fullTank = true): FuelEntry {
  return { date, odometerKm, quantity, cost, fullTank };
}

const km = (entries: [string, number][]) => new Map(entries);

describe("vehicleEnergy", () => {
  const input = {
    from: "2026-11-02",
    to: "2026-11-14",
    today: "2026-11-14",
    fills: [
      fill("2026-10-20", 49_000, 40, 70), // older full tanks are ignored but the last one before the period
      fill("2026-10-30", 50_000, 40, 70),
      fill("2026-11-06", 50_300, 20, 35, false),
      fill("2026-11-12", 50_600, 22, 39),
    ],
    plannedKm: km([
      ["2026-10-30", 999], // the day of the first reading: before it
      ["2026-11-03", 280],
      ["2026-11-10", 270],
      ["2026-11-13", 999], // after the last reading
    ]),
    plannedSince: "2026-09-01",
    offRoadDays: 2,
    deadlines: [
      { vehicleId: "v1", kind: "INSPECTION" as const, label: null, dueDate: "2026-11-01", dueKm: null, doneDate: null },
      { vehicleId: "v1", kind: "SERVICE" as const, label: null, dueDate: null, dueKm: 60_000, doneDate: null },
    ],
  };

  it("measures from the last full tank before the period to the last one in it", () => {
    const v = vehicleEnergy(diesel, input);
    expect(v).toMatchObject({ unit: "L", measuredKm: 600, quantity: 42, energyCost: 74, comparedKm: 600, plannedKm: 550, offRoadDays: 2, overdueDeadlines: 1 });
    expect(v.configuredCost).toBeCloseTo(180);
  });

  it("compares the odometer up to the last reading of a planned day only", () => {
    // Nothing planned after the 7th: the reading of the 6th (partial fill) ends the comparison.
    expect(vehicleEnergy(diesel, { ...input, plannedUntil: "2026-11-07" })).toMatchObject({ measuredKm: 600, comparedKm: 300, plannedKm: 280 });
    expect(vehicleEnergy(diesel, { ...input, plannedUntil: "2026-10-31" })).toMatchObject({ comparedKm: null, plannedKm: null });
  });

  it("does not compare with planned km an interval that starts before the first planned day", () => {
    expect(vehicleEnergy(diesel, { ...input, plannedSince: "2026-11-01" }).plannedKm).toBeNull();
    expect(vehicleEnergy(diesel, { ...input, plannedSince: null }).plannedKm).toBeNull();
  });

  it("counts the deadlines overdue today at the latest odometer, not the last reading of a past period", () => {
    // The SERVICE at 60 000 km: passed since the period, read on the latest fill-up.
    expect(vehicleEnergy(diesel, { ...input, latestOdometerKm: 60_400 }).overdueDeadlines).toBe(2);
    expect(vehicleEnergy(diesel, { ...input, latestOdometerKm: null }).overdueDeadlines).toBe(1);
  });

  it("measures nothing without two full tanks", () => {
    expect(vehicleEnergy(diesel, { ...input, fills: [fill("2026-11-12", 50_600, 22, 39)] })).toMatchObject({ measuredKm: 0, plannedKm: null });
  });
});

describe("groups", () => {
  const base = { from: "2026-11-02", to: "2026-11-14", today: "2026-11-14", plannedSince: "2026-09-01", offRoadDays: 0, deadlines: [] };
  const v1 = vehicleEnergy(diesel, { ...base, fills: [fill("2026-11-01", 0, 0, 0), fill("2026-11-10", 1000, 70, 120)], plannedKm: km([["2026-11-05", 900]]) });
  const v2 = vehicleEnergy(electric, { ...base, fills: [fill("2026-11-01", 0, 0, 0), fill("2026-11-10", 500, 90, 30)], plannedKm: km([["2026-11-05", 500]]) });

  it("never mixes litres and kWh, and compares the odometer with the planned km", () => {
    const all = energyRates(sumEnergy([v1, v2]));
    expect(all.per100Km).toEqual({ L: 7, kWh: 18 });
    expect(all.energyCostPerKm).toBeCloseTo(150 / 1500);
    expect(all.configuredCostPerKm).toBeCloseTo((0.3 * 1000 + 0.2 * 500) / 1500);
    expect(all.kmGap).toBeCloseTo((1500 - 1400) / 1400);
    const byEnergy = groupEnergy([v1, v2], (v) => v.energy ?? "NONE");
    expect([...byEnergy.keys()]).toEqual(["DIESEL", "ELECTRIC"]);
    expect(energyRates(byEnergy.get("ELECTRIC")!).per100Km).toEqual({ kWh: 18 });
  });
});

describe("the crews' odometer readings against the planned km (FLD-03)", () => {
  it("compares the days read at the start and the end, in the period, and sums them by group", () => {
    const base = { from: "2026-11-02", to: "2026-11-14", today: "2026-11-14", fills: [], plannedKm: new Map<string, number>(), plannedSince: null, offRoadDays: 0, deadlines: [] };
    const v1 = vehicleEnergy(diesel, {
      ...base,
      readingDays: [
        { date: "2026-11-03", startKm: 1000, endKm: 1230, plannedKm: 200 },
        { date: "2026-11-04", startKm: 1230, endKm: 1400, plannedKm: null },
        // Before the period.
        { date: "2026-10-30", startKm: 900, endKm: 1000, plannedKm: 50 },
      ],
    });
    expect(v1).toMatchObject({ readingDays: 1, readingKm: 230, readingPlannedKm: 200 });
    const v2 = vehicleEnergy(electric, { ...base, readingDays: [{ date: "2026-11-05", startKm: 0, endKm: 90, plannedKm: 100 }] });
    const total = sumEnergy([v1, v2]);
    expect(total).toMatchObject({ readingDays: 2, readingKm: 320, readingPlannedKm: 300 });
    expect(energyRates(total).readingGap).toBeCloseTo(20 / 300);
    expect(energyRates(sumEnergy([])).readingGap).toBeNull();
  });
});

