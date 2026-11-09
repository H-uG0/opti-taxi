import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FARE_RULES,
  fareCents,
  isNight,
  isWeekend,
  scaledInt,
  type FareGrid,
  type FareRide,
  type FareRules,
  type FareTrip,
} from "./fare";

type RawCase = {
  name: string;
  grid: string;
  date: string;
  publicHolidays: string[];
  ride: FareRide;
  expected: number;
  trip?: Partial<FareTrip>;
  vehicle?: { tpmrEquipped?: boolean };
  pricing?: Partial<FareRules>;
};

const fixture = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../../../../contract/fixtures/fare-cases.json"), "utf8"),
) as { defaults: { trip: FareTrip; vehicle: { tpmrEquipped: boolean }; pricing: FareRules }; grids: Record<string, unknown>[]; cases: RawCase[] };

/** The contract's grid (defaults of contract.ts where a field is left out) as fare.ts reads it. */
function grid(raw: Record<string, unknown>): FareGrid {
  const value = <T>(key: string, fallback: T): T => (raw[key] === undefined ? fallback : (raw[key] as T));
  return {
    baseFare: value("baseFare", 0),
    aggloFare: value<number | null>("aggloFare", null),
    bigCityFare: value("bigCityFare", 0),
    includedKm: value("includedKm", 0),
    pricePerKm: value("pricePerKm", 0),
    shortTripBands: value("shortTripBands", []),
    nightRate: value("nightRate", 0),
    weekendRate: value("weekendRate", 0),
    nightStartMinute: value("nightStartMin", 1200),
    nightEndMinute: value("nightEndMin", 480),
    saturdayFromMinute: value("saturdayFromMin", 720),
    surchargeShortTrip: value("surchargeShortTrip", true),
    emptyLegRateShort: value("emptyLegRateShort", 0),
    emptyLegRateLong: value("emptyLegRateLong", 0),
    emptyLegThresholdKm: value("emptyLegThresholdKm", 50),
    sharedDiscounts: value("sharedDiscounts", []),
    maxSharedPatients: value("maxSharedPatients", 8),
    aloneDiscount: value("aloneDiscount", 0),
    aloneThresholdKm: value("aloneThresholdKm", 30),
    billableDetourKm: value("billableDetourKm", []),
    tpmrFare: value("tpmrFare", 0),
  };
}

const grids = new Map(fixture.grids.map((raw) => [raw.id as string, grid(raw)]));

describe("fareCents on the reference invoices (contract/fixtures/fare-cases.json, also run by the optimizer)", () => {
  it.each(fixture.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const cents = fareCents(
      grids.get(c.grid)!,
      { ...fixture.defaults.trip, ...c.trip },
      { ...fixture.defaults.vehicle, ...c.vehicle },
      c.ride,
      { ...fixture.defaults.pricing, ...c.pricing },
      { date: c.date, holidays: new Set(c.publicHolidays) },
    );
    expect(cents).toBe(Math.round(c.expected * 100));
  });
});

describe("scaledInt", () => {
  it("rounds half up from the shortest decimal writing, never on the binary float", () => {
    expect(scaledInt(41.385, 2)).toBe(4139n);
    expect(scaledInt(27.59 * 1.5, 2)).toBe(4139n);
    expect(scaledInt(1.005, 2)).toBe(101n);
    expect(scaledInt(13, 4)).toBe(130_000n);
    expect(scaledInt(1e-7, 4)).toBe(0n);
    expect(scaledInt(5e-4, 3)).toBe(1n);
    expect(scaledInt(2.5e-4, 3)).toBe(0n);
    expect(scaledInt(1e21, 0)).toBe(10n ** 21n);
  });

  it("refuses a negative or non-finite amount", () => {
    expect(() => scaledInt(-1, 2)).toThrow(RangeError);
    expect(() => scaledInt(Number.NaN, 2)).toThrow(RangeError);
  });
});

describe("surcharge times", () => {
  const night = { nightStartMinute: 1200, nightEndMinute: 480 };
  it.each([
    [1199, 1199, false],
    [1200, 1200, true],
    [465, 490, true],
    [465, 500, false],
    [1500, 1560, true],
    [1950, 2000, false],
  ])("ride %i -> %i at night: %s", (pickup, dropoff, expected) => {
    expect(isNight(night, pickup, dropoff)).toBe(expected);
  });

  it("reads a minute past midnight on the next day", () => {
    const friday = { date: "2026-11-13", holidays: new Set<string>() };
    expect(isWeekend(friday, 1430, 720)).toBe(false);
    expect(isWeekend(friday, 1440 + 600, 720)).toBe(false);
    expect(isWeekend(friday, 1440 + 720, 720)).toBe(true);
    expect(isWeekend({ date: "2026-11-10", holidays: new Set(["2026-11-11"]) }, 1500, 720)).toBe(true);
  });

  it("uses the default rules of the contract", () => {
    expect(DEFAULT_FARE_RULES).toEqual({ emptyLegOrder: "MULTIPLICATIVE", patientCount: "DISTINCT" });
  });
});
