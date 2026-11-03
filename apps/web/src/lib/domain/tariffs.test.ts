import type { TariffGrid } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { fromIsoDate } from "@/lib/time";
import { tariffFor, tariffsInForce } from "./tariffs";

// The first Date#toISOString() of a test worker can take several seconds on a slow
// Windows machine (4-7 s observed): pay it once here, outside the per-test timeout.
beforeAll(() => {
  new Date(0).toISOString();
}, 60_000);

let nextId = 1;

function grid(overrides: Partial<Omit<TariffGrid, "validFrom" | "validTo">> & { from: string; to?: string | null }): TariffGrid {
  const { from, to = null, ...rest } = overrides;
  return {
    id: `grid_${nextId++}`,
    vehicleType: "TAXI",
    department: "13",
    label: null,
    baseFare: 13,
    pricePerKm: 1.12,
    includedKm: 0,
    sharedDiscount2: 0.23,
    sharedDiscount3: 0.35,
    validFrom: fromIsoDate(from),
    validTo: to ? fromIsoDate(to) : null,
    notes: null,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    updatedAt: new Date("2025-01-01T00:00:00Z"),
    ...rest,
  };
}

describe("tariffsInForce", () => {
  it("keeps a grid from its first to its last day, both inclusive", () => {
    const g = grid({ from: "2025-01-01", to: "2025-12-31" });
    expect(tariffsInForce([g], "2024-12-31")).toEqual([]);
    expect(tariffsInForce([g], "2025-01-01")).toEqual([g]);
    expect(tariffsInForce([g], "2025-06-15")).toEqual([g]);
    expect(tariffsInForce([g], "2025-12-31")).toEqual([g]);
    expect(tariffsInForce([g], "2026-01-01")).toEqual([]);
  });

  it("treats a grid without end date as open-ended", () => {
    const g = grid({ from: "2025-01-01" });
    expect(tariffsInForce([g], "2030-01-01")).toEqual([g]);
    expect(tariffsInForce([g], "2024-12-31")).toEqual([]);
  });

  it("drops expired and future grids", () => {
    const expired = grid({ from: "2023-01-01", to: "2024-12-31" });
    const current = grid({ from: "2025-01-01" });
    const future = grid({ from: "2027-01-01", baseFare: 14 });
    expect(tariffsInForce([expired, current, future], "2026-11-03")).toEqual([current]);
  });

  it("keeps the most recently started grid when several overlap, whatever the input order", () => {
    const older = grid({ from: "2024-01-01", pricePerKm: 1.05 });
    const newer = grid({ from: "2026-01-01", pricePerKm: 1.15 });
    expect(tariffsInForce([older, newer], "2026-11-03")).toEqual([newer]);
    expect(tariffsInForce([newer, older], "2026-11-03")).toEqual([newer]);
    // Before the newer one starts, the older one is still in force.
    expect(tariffsInForce([newer, older], "2025-06-01")).toEqual([older]);
  });

  it("breaks a same-day start on creation time (last created wins), whatever the input order", () => {
    const first = grid({ from: "2026-11-02", pricePerKm: 1.2, createdAt: new Date("2026-11-02T08:00:00Z") });
    const fixed = grid({ from: "2026-11-02", pricePerKm: 1.12, createdAt: new Date("2026-11-02T08:05:00Z") });
    expect(tariffsInForce([first, fixed], "2026-11-03")).toEqual([fixed]);
    expect(tariffsInForce([fixed, first], "2026-11-03")).toEqual([fixed]);
  });

  it("breaks a full tie (same start, same creation time) on the id", () => {
    const createdAt = new Date("2026-11-02T08:00:00Z");
    const a = grid({ id: "grid_a", from: "2026-11-02", createdAt });
    const b = grid({ id: "grid_b", from: "2026-11-02", createdAt, pricePerKm: 1.15 });
    expect(tariffsInForce([a, b], "2026-11-03")).toEqual([b]);
    expect(tariffsInForce([b, a], "2026-11-03")).toEqual([b]);
  });

  it("works on a column subset that keeps createdAt and id", () => {
    // What a caller selecting columns (the optimizer request builder) passes.
    const subset = (g: TariffGrid) => ({
      id: g.id,
      createdAt: g.createdAt,
      vehicleType: g.vehicleType,
      department: g.department,
      validFrom: g.validFrom,
      validTo: g.validTo,
      pricePerKm: g.pricePerKm,
    });
    const first = subset(grid({ from: "2026-11-02", pricePerKm: 1.2, createdAt: new Date("2026-11-02T08:00:00Z") }));
    const fixed = subset(grid({ from: "2026-11-02", pricePerKm: 1.12, createdAt: new Date("2026-11-02T08:05:00Z") }));
    expect(tariffsInForce([first, fixed], "2026-11-03")).toEqual([fixed]);
    expect(tariffsInForce([fixed, first], "2026-11-03")).toEqual([fixed]);
  });

  it("requires createdAt and id: a column subset missing either one does not type-check", () => {
    // One directive per field: each line proves its own field is required, so making
    // only one of them optional again also breaks tsc (TS2578, unused directive).
    const dated = { vehicleType: "TAXI", department: "13", validFrom: fromIsoDate("2026-11-02"), validTo: null } as const;
    const withoutCreatedAt = { ...dated, id: "grid_x" };
    const withoutId = { ...dated, createdAt: new Date("2026-11-02T08:00:00Z") };
    // Control: with both fields the same subset type-checks, so the errors below come
    // from the missing field alone.
    expect(tariffsInForce([{ ...withoutId, id: "grid_x" }], "2026-11-03")).toHaveLength(1);
    // @ts-expect-error createdAt is required, so a same-day tie never depends on the input order.
    expect(tariffsInForce([withoutCreatedAt], "2026-11-03")).toHaveLength(1);
    // @ts-expect-error id is required, so a full tie never depends on the input order.
    expect(tariffsInForce([withoutId], "2026-11-03")).toHaveLength(1);
  });

  it("keeps one grid per vehicle type and department", () => {
    const taxi13 = grid({ from: "2025-01-01" });
    const taxi04 = grid({ from: "2025-01-01", department: "04", pricePerKm: 1.17 });
    const vslAll = grid({ from: "2025-01-01", vehicleType: "VSL", department: "*", baseFare: 13.6 });
    const ambulanceAll = grid({ from: "2025-01-01", vehicleType: "AMBULANCE", department: "*", baseFare: 64.5 });
    const inForce = tariffsInForce([taxi13, taxi04, vslAll, ambulanceAll], "2026-11-03");
    expect(inForce).toHaveLength(4);
    expect(inForce).toEqual(expect.arrayContaining([taxi13, taxi04, vslAll, ambulanceAll]));
  });

  it("returns nothing for no grids", () => {
    expect(tariffsInForce([], "2026-11-03")).toEqual([]);
  });
});

describe("tariffFor", () => {
  const taxi13 = grid({ from: "2025-01-01" });
  const taxiAll = grid({ from: "2025-01-01", department: "*", pricePerKm: 1.1 });
  const vslAll = grid({ from: "2025-01-01", vehicleType: "VSL", department: "*", baseFare: 13.6 });
  const grids = [taxiAll, taxi13, vslAll];

  it("prefers the grid of the vehicle's department", () => {
    expect(tariffFor(grids, "TAXI", "13")).toBe(taxi13);
  });

  it("falls back to the catch-all grid", () => {
    expect(tariffFor(grids, "TAXI", "05")).toBe(taxiAll);
    expect(tariffFor(grids, "VSL", "13")).toBe(vslAll);
  });

  it("returns undefined when no grid covers the vehicle type", () => {
    expect(tariffFor(grids, "AMBULANCE", "13")).toBeUndefined();
    expect(tariffFor([taxi13], "TAXI", "04")).toBeUndefined();
  });

  it("combines with tariffsInForce: an expired exact grid yields to the catch-all", () => {
    const expired13 = grid({ from: "2023-01-01", to: "2024-12-31" });
    const inForce = tariffsInForce([expired13, taxiAll], "2026-11-03");
    expect(tariffFor(inForce, "TAXI", "13")).toBe(taxiAll);
  });
});
