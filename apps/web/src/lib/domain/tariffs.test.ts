import type { TariffGrid } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { fromIsoDate } from "@/lib/time";
import {
  certifiedOn,
  gridForVehicle,
  readSharedDiscounts,
  readShortTripBands,
  tariffCoverageAlerts,
  tariffGaps,
  tariffsInForce,
  toFareGrid,
  type CompanyTariffContext,
  type CompanyTariffStatus,
  type TariffedVehicle,
} from "./tariffs";

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
    certified: null,
    zone: null,
    label: null,
    baseFare: 13,
    aggloFare: null,
    bigCityFare: 0,
    includedKm: 0,
    pricePerKm: 1.12,
    shortTripBands: [],
    nightRate: 0,
    weekendRate: 0,
    nightStartMinute: 1200,
    nightEndMinute: 480,
    saturdayFromMinute: 720,
    surchargeShortTrip: true,
    emptyLegRateShort: 0,
    emptyLegRateLong: 0,
    emptyLegThresholdKm: 50,
    sharedDiscounts: [
      { patients: 2, rate: 0.23 },
      { patients: 3, rate: 0.35 },
    ],
    maxSharedPatients: 3,
    aloneDiscount: 0,
    aloneThresholdKm: 30,
    billableDetourKm: [],
    tpmrFare: 0,
    verification: "UNVERIFIED",
    sourceUrl: null,
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
      certified: g.certified,
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
    const dated = { vehicleType: "TAXI", department: "13", certified: null, validFrom: fromIsoDate("2026-11-02"), validTo: null } as const;
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

const NOT_CERTIFIED: CompanyTariffStatus = { certified: false, hqDepartment: null };
const CERTIFIED_IN_13: CompanyTariffStatus = { certified: true, hqDepartment: "13" };

describe("tariffsInForce with certification", () => {
  it("keeps a certified and a non-certified grid of the same type and department side by side", () => {
    const certified = grid({ from: "2025-01-01", vehicleType: "VSL", department: "*", certified: true });
    const base = grid({ from: "2025-10-01", vehicleType: "VSL", department: "*", certified: false });
    expect(tariffsInForce([certified, base], "2026-11-03")).toEqual(expect.arrayContaining([certified, base]));
  });
});

describe("gridForVehicle", () => {
  const taxi13 = grid({ from: "2025-01-01" });
  const taxiAll = grid({ from: "2025-01-01", department: "*", pricePerKm: 1.1 });
  const vslMajored = grid({ from: "2025-01-01", vehicleType: "VSL", department: "*", certified: true, baseFare: 15.75 });
  const vslBase13 = grid({ from: "2025-10-01", vehicleType: "VSL", department: "13", certified: false, baseFare: 12.11 });
  const vslBase84 = grid({ from: "2025-10-01", vehicleType: "VSL", department: "84", certified: false, baseFare: 11.34 });
  const ambulanceMajored = grid({ from: "2025-01-01", vehicleType: "AMBULANCE", department: "*", certified: true, baseFare: 57.39 });
  const ambulanceBase = grid({ from: "2025-10-01", vehicleType: "AMBULANCE", department: "*", certified: false, baseFare: 45.6 });
  const grids = [taxiAll, taxi13, vslMajored, vslBase13, vslBase84, ambulanceMajored, ambulanceBase];

  it("a taxi takes the grid of its ADS department, then the catch-all, whatever the certification", () => {
    expect(gridForVehicle(grids, { type: "TAXI", department: "13" }, CERTIFIED_IN_13)).toBe(taxi13);
    expect(gridForVehicle(grids, { type: "TAXI", department: "05" }, NOT_CERTIFIED)).toBe(taxiAll);
  });

  it("a VSL of a certified company takes the majored grid, wherever its department", () => {
    expect(gridForVehicle(grids, { type: "VSL", department: "84" }, CERTIFIED_IN_13)).toBe(vslMajored);
  });

  it("a VSL of a non-certified company takes the base grid of the head office's department", () => {
    expect(gridForVehicle(grids, { type: "VSL", department: "84" }, { certified: false, hqDepartment: "13" })).toBe(vslBase13);
    // Head office not set: the vehicle's own department.
    expect(gridForVehicle(grids, { type: "VSL", department: "84" }, NOT_CERTIFIED)).toBe(vslBase84);
    expect(gridForVehicle(grids, { type: "VSL", department: "05" }, NOT_CERTIFIED)).toBeUndefined();
  });

  it("an ambulance takes the grid of the certification", () => {
    expect(gridForVehicle(grids, { type: "AMBULANCE", department: "05" }, CERTIFIED_IN_13)).toBe(ambulanceMajored);
    expect(gridForVehicle(grids, { type: "AMBULANCE", department: "05" }, NOT_CERTIFIED)).toBe(ambulanceBase);
  });

  it("a grid for any company (certified null, grids of before 2025) applies to both", () => {
    const old = grid({ from: "2025-01-01", vehicleType: "VSL", department: "*", baseFare: 13.6 });
    expect(gridForVehicle([old], { type: "VSL", department: "13" }, CERTIFIED_IN_13)).toBe(old);
    expect(gridForVehicle([old], { type: "VSL", department: "13" }, NOT_CERTIFIED)).toBe(old);
    // The grid of the exact certification wins over it.
    expect(gridForVehicle([old, vslMajored], { type: "VSL", department: "13" }, CERTIFIED_IN_13)).toBe(vslMajored);
  });

  it("combines with tariffsInForce: an expired exact grid yields to the catch-all", () => {
    const expired13 = grid({ from: "2023-01-01", to: "2024-12-31" });
    const inForce = tariffsInForce([expired13, taxiAll], "2026-11-03");
    expect(gridForVehicle(inForce, { type: "TAXI", department: "13" }, NOT_CERTIFIED)).toBe(taxiAll);
  });
});

describe("certification periods", () => {
  const periods: CompanyTariffContext["certifications"] = [
    { validFrom: fromIsoDate("2025-01-01"), validTo: fromIsoDate("2025-06-30") },
    { validFrom: fromIsoDate("2026-01-01"), validTo: null },
  ];
  it("covers its bounds, not the gap between periods", () => {
    expect(certifiedOn(periods, "2024-12-31")).toBe(false);
    expect(certifiedOn(periods, "2025-01-01")).toBe(true);
    expect(certifiedOn(periods, "2025-06-30")).toBe(true);
    expect(certifiedOn(periods, "2025-07-01")).toBe(false);
    expect(certifiedOn(periods, "2030-01-01")).toBe(true);
  });
});

describe("JSON columns", () => {
  it("reads the bands and discounts sorted, and nothing from a malformed value", () => {
    expect(readShortTripBands([{ upToKm: 8, amount: 7.68 }, { upToKm: 7, amount: 8.54 }])).toEqual([
      { upToKm: 7, amount: 8.54 },
      { upToKm: 8, amount: 7.68 },
    ]);
    expect(readShortTripBands("nope")).toEqual([]);
    expect(readSharedDiscounts([{ patients: 3, rate: 0.35 }, { patients: 2, rate: 0.23 }]).map((d) => d.patients)).toEqual([2, 3]);
    expect(readSharedDiscounts([{ patients: 1, rate: 0.5 }])).toEqual([]);
  });

  it("gives fare.ts the grid with its lists", () => {
    const fare = toFareGrid(grid({ from: "2025-01-01", billableDetourKm: [10, 10] }));
    expect(fare.sharedDiscounts).toHaveLength(2);
    expect(fare.billableDetourKm).toEqual([10, 10]);
  });
});

describe("tariff gaps of a planned day", () => {
  const vehicles: TariffedVehicle[] = [
    { label: "VSL 2", type: "VSL", department: "04" },
    { label: "Taxi 1", type: "TAXI", department: "13" },
    { label: "VSL 5", type: "VSL", department: "04" },
    { label: "Taxi 9", type: "TAXI", department: "05" },
  ];

  it("groups the vehicles no grid covers by type and department", () => {
    const inForce = [grid({ from: "2026-01-01", vehicleType: "TAXI", department: "13" })];
    expect(tariffGaps(vehicles, inForce, NOT_CERTIFIED)).toEqual([
      { vehicleType: "VSL", department: "04", vehicles: ["VSL 2", "VSL 5"] },
      { vehicleType: "TAXI", department: "05", vehicles: ["Taxi 9"] },
    ]);
  });

  it("counts the « * » catch-all of the type as coverage", () => {
    const inForce = [grid({ from: "2026-01-01", vehicleType: "TAXI", department: "*" })];
    expect(tariffGaps(vehicles, inForce, NOT_CERTIFIED).map((g) => g.vehicleType)).toEqual(["VSL"]);
  });

  it("a VSL without the grid of the company's certification is a gap", () => {
    const inForce = [grid({ from: "2026-01-01", vehicleType: "VSL", department: "*", certified: true })];
    const vsl = vehicles.filter((v) => v.type === "VSL");
    expect(tariffGaps(vsl, inForce, CERTIFIED_IN_13)).toEqual([]);
    expect(tariffGaps(vsl, inForce, NOT_CERTIFIED)).toHaveLength(1);
  });
});

describe("tariffCoverageAlerts (tomorrow and the 7 following days)", () => {
  const vsl: TariffedVehicle[] = [{ label: "VSL 2", type: "VSL", department: "04" }];
  const vslGrid = (from: string, to: string | null, label: string | null = null) =>
    grid({ from, to, label, vehicleType: "VSL", department: "04" });

  it("says nothing when every day of the window is covered, including a hand-over on its last day", () => {
    expect(tariffCoverageAlerts(vsl, [vslGrid("2026-01-01", null)], "2026-11-10", 7)).toEqual([]);
    const handOver = [vslGrid("2026-01-01", "2026-11-12"), vslGrid("2026-11-13", null)];
    expect(tariffCoverageAlerts(vsl, handOver, "2026-11-10", 7)).toEqual([]);
  });

  it("a grid ending today leaves tomorrow without grid", () => {
    const [alert] = tariffCoverageAlerts(vsl, [vslGrid("2026-01-01", "2026-11-09")], "2026-11-10", 7);
    expect(alert).toMatchObject({ kind: "missing", uncoveredFrom: "2026-11-10", expiring: null, resumesOn: null, vehicles: ["VSL 2"] });
  });

  it("a grid ending inside the window with nothing after it", () => {
    const expiring = vslGrid("2026-01-01", "2026-11-14", "Avenant 2025");
    const [alert] = tariffCoverageAlerts(vsl, [expiring], "2026-11-10", 7);
    expect(alert).toMatchObject({
      kind: "expires",
      uncoveredFrom: "2026-11-15",
      expiring: { id: expiring.id, department: "04", label: "Avenant 2025", validTo: "2026-11-14" },
      resumesOn: null,
    });
  });

  it("checks the bounds: a grid ending on the last day of the window is enough, one ending the day before is not", () => {
    expect(tariffCoverageAlerts(vsl, [vslGrid("2026-01-01", "2026-11-17")], "2026-11-10", 7)).toEqual([]);
    expect(tariffCoverageAlerts(vsl, [vslGrid("2026-01-01", "2026-11-16")], "2026-11-10", 7)[0]?.uncoveredFrom).toBe("2026-11-17");
  });

  it("a grid starting inside the window: missing until it starts", () => {
    const [late] = tariffCoverageAlerts(vsl, [vslGrid("2026-11-13", null)], "2026-11-10", 7);
    expect(late).toMatchObject({ kind: "missing", uncoveredFrom: "2026-11-10", resumesOn: "2026-11-13" });
    expect(tariffCoverageAlerts(vsl, [vslGrid("2026-11-10", null)], "2026-11-10", 7)).toEqual([]);
  });

  it("a gap between two grids", () => {
    const gap = [vslGrid("2026-01-01", "2026-11-11"), vslGrid("2026-11-14", null)];
    expect(tariffCoverageAlerts(vsl, gap, "2026-11-10", 7)[0]).toMatchObject({
      kind: "expires",
      uncoveredFrom: "2026-11-12",
      resumesOn: "2026-11-14",
    });
  });

  it("a certification that ends inside the window leaves the VSL without the base grid", () => {
    const majored = grid({ from: "2025-01-01", vehicleType: "VSL", department: "*", certified: true });
    const company: CompanyTariffContext = {
      certifications: [{ validFrom: fromIsoDate("2025-01-01"), validTo: fromIsoDate("2026-11-12") }],
      hqDepartment: "13",
    };
    const [alert] = tariffCoverageAlerts(vsl, [majored], "2026-11-10", 7, company);
    expect(alert).toMatchObject({ uncoveredFrom: "2026-11-13", resumesOn: null });
  });

  it("the « * » catch-all takes over an expiring department grid", () => {
    const grids = [vslGrid("2026-01-01", "2026-11-11"), grid({ from: "2026-01-01", vehicleType: "VSL", department: "*" })];
    expect(tariffCoverageAlerts(vsl, grids, "2026-11-10", 7)).toEqual([]);
  });
});
