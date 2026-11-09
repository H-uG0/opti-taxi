import { describe, expect, it } from "vitest";
import {
  costPerKmFor,
  FUEL_PROFILE,
  hourlyCostFor,
  loadedHourlyCost,
  PAID_SHARE_OF_SPAN,
  routeHourlyCost,
  staffRoleOf,
} from "./costs";

describe("labour costs", () => {
  it("pays a person for the highest qualification held", () => {
    expect(staffRoleOf(["TAXI_CARD"])).toBe("TAXI_DRIVER");
    expect(staffRoleOf(["AUXILIARY", "TAXI_CARD"])).toBe("AUXILIARY");
    expect(staffRoleOf(["DEA", "AUXILIARY"])).toBe("DEA");
  });

  it("loads the gross pay with contributions, paid leave, overtime and the meal allowance", () => {
    // 12.31 x 1.12 x 1.13 x 1.05 + 1.5
    expect(loadedHourlyCost("TAXI_DRIVER")).toBeCloseTo(17.86, 2);
    // 12.31 x 1.12 x 1.13 x 1.08 + 1.5
    expect(loadedHourlyCost("AUXILIARY")).toBeCloseTo(18.33, 2);
    // 13.8 x 1.20 x 1.13 x 1.08 + 1.5
    expect(loadedHourlyCost("DEA")).toBeCloseTo(21.71, 2);
    expect(loadedHourlyCost("DEA")).toBeGreaterThan(loadedHourlyCost("AUXILIARY"));
  });

  it("counts the paid share of a route's span, with seniority capped at five years", () => {
    expect(routeHourlyCost("AUXILIARY")).toBeCloseTo(loadedHourlyCost("AUXILIARY") * PAID_SHARE_OF_SPAN.AUXILIARY, 2);
    expect(routeHourlyCost("TAXI_DRIVER", 3)).toBeGreaterThan(routeHourlyCost("TAXI_DRIVER"));
    expect(routeHourlyCost("DEA", 9)).toBe(routeHourlyCost("DEA", 5));
    expect(hourlyCostFor(["DEA", "AUXILIARY"], 2)).toBe(routeHourlyCost("DEA", 2));
  });

  it("puts an ambulance crew (auxiliary + DE) between 33 and 40 €/h of route, a taxi or VSL between 15 and 20 €/h", () => {
    const crew = hourlyCostFor(["AUXILIARY"]) + hourlyCostFor(["DEA"]);
    expect(crew).toBeGreaterThan(33);
    expect(crew).toBeLessThan(40);
    for (const quals of [["TAXI_CARD"], ["AUXILIARY"]] as const) {
      expect(hourlyCostFor(quals)).toBeGreaterThan(15);
      expect(hourlyCostFor(quals)).toBeLessThan(20);
    }
  });
});

describe("cost per km", () => {
  it("adds fuel, upkeep and the depreciation that follows the km", () => {
    expect(costPerKmFor("TAXI", "DIESEL")).toBe(0.25);
    expect(costPerKmFor("VSL", "DIESEL")).toBe(0.27);
    expect(costPerKmFor("AMBULANCE", "DIESEL")).toBe(0.46);
    expect(costPerKmFor("TAXI", "ELECTRIC")).toBe(0.21);
    expect(costPerKmFor("TAXI", "DIESEL", 0.02)).toBe(0.27);
  });

  it("uses the electric profile whatever the vehicle type", () => {
    expect(FUEL_PROFILE.ELECTRIC.price).toBeLessThan(FUEL_PROFILE.TAXI.price);
    expect(costPerKmFor("VSL", "ELECTRIC")).toBe(costPerKmFor("TAXI", "ELECTRIC"));
  });
});
