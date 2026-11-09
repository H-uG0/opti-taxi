import { describe, expect, it } from "vitest";
import { fromIsoDate } from "@/lib/time";
import { fieldErrorsFromZod } from "@/lib/forms";
import { tariffRow } from "@/test/tariff-fixtures";
import {
  fractionToPercent,
  parseKmList,
  parseShortTripBands,
  percentToFraction,
  previewFareGrid,
  tariffFormValues,
  tariffSchema,
  tariffStatus,
} from "./schema";

const valid: Record<string, string> = {
  vehicleType: "VSL",
  department: "*",
  certified: "true",
  zone: "",
  label: "VSL majoré",
  baseFare: "15,75",
  aggloFare: "",
  bigCityFare: "",
  includedKm: "3",
  pricePerKm: "1,10",
  shortTripBands: "7 : 8,54\n8 : 7,68",
  nightRate: "50",
  weekendRate: "25",
  nightStart: "20:00",
  nightEnd: "08:00",
  saturdayFrom: "12:00",
  surchargeShortTrip: "on",
  emptyLegRateShort: "",
  emptyLegRateLong: "",
  emptyLegThresholdKm: "50",
  discount2: "15",
  discount3: "33",
  discount4: "",
  maxSharedPatients: "3",
  aloneDiscount: "",
  aloneThresholdKm: "30",
  billableDetourKm: "10 ; 10",
  tpmrFare: "30",
  verification: "OFFICIAL",
  sourceUrl: "https://www.ameli.fr/transporteur-sanitaire",
  validFrom: "2025-01-01",
  validTo: "",
  notes: "",
};

/** Field errors exactly as the form displays them (first issue per field). */
function errorsOf(input: Record<string, string>) {
  const result = tariffSchema.safeParse(input);
  return result.success ? {} : fieldErrorsFromZod(result.error).fieldErrors;
}

describe("percent <-> fraction", () => {
  it("converts without float noise", () => {
    expect(percentToFraction(23)).toBe(0.23);
    expect(percentToFraction(12.5)).toBe(0.125);
    expect(percentToFraction(0)).toBe(0);
    expect(fractionToPercent(0.23)).toBe(23);
    expect(fractionToPercent(0.35)).toBe(35);
    expect(fractionToPercent(percentToFraction(17.25))).toBe(17.25);
  });
});

describe("text lists", () => {
  it("reads short-trip bands, one « km : € » per line, sorted", () => {
    expect(parseShortTripBands("8 : 7,68\n≤ 7 km : 8,54 €\n\n")).toEqual([
      { upToKm: 7, amount: 8.54 },
      { upToKm: 8, amount: 7.68 },
    ]);
    expect(parseShortTripBands("")).toEqual([]);
    expect(parseShortTripBands("7 km")).toBeNull();
  });

  it("reads billable detours", () => {
    expect(parseKmList("10 ; 10")).toEqual([10, 10]);
    expect(parseKmList("10;7,5")).toEqual([10, 7.5]);
    expect(parseKmList("dix")).toBeNull();
  });
});

describe("tariffSchema", () => {
  it("stores rates as fractions, times as minutes, lists as JSON and dates as @db.Date", () => {
    expect(tariffSchema.parse(valid)).toEqual({
      vehicleType: "VSL",
      department: "*",
      certified: true,
      zone: null,
      label: "VSL majoré",
      baseFare: 15.75,
      aggloFare: null,
      bigCityFare: 0,
      includedKm: 3,
      pricePerKm: 1.1,
      shortTripBands: [
        { upToKm: 7, amount: 8.54 },
        { upToKm: 8, amount: 7.68 },
      ],
      nightRate: 0.5,
      weekendRate: 0.25,
      nightStartMinute: 1200,
      nightEndMinute: 480,
      saturdayFromMinute: 720,
      surchargeShortTrip: true,
      emptyLegRateShort: 0,
      emptyLegRateLong: 0,
      emptyLegThresholdKm: 50,
      sharedDiscounts: [
        { patients: 2, rate: 0.15 },
        { patients: 3, rate: 0.33 },
      ],
      maxSharedPatients: 3,
      aloneDiscount: 0,
      aloneThresholdKm: 30,
      billableDetourKm: [10, 10],
      tpmrFare: 30,
      verification: "OFFICIAL",
      sourceUrl: "https://www.ameli.fr/transporteur-sanitaire",
      validFrom: fromIsoDate("2025-01-01"),
      validTo: null,
      notes: null,
    });
  });

  it("reads an unchecked « majorer le trajet court » and a grid for any company", () => {
    const parsed = tariffSchema.parse({ ...valid, certified: "", surchargeShortTrip: "" });
    expect(parsed.certified).toBeNull();
    expect(parsed.surchargeShortTrip).toBe(false);
  });

  it("checks rates, their order, the lists and the dates", () => {
    expect(errorsOf({ ...valid, discount2: "120" }).discount2).toBe("Maximum : 100 %.");
    expect(errorsOf({ ...valid, discount3: "10" }).discount3).toMatch(/inférieur/);
    expect(errorsOf({ ...valid, shortTripBands: "7 km" }).shortTripBands).toMatch(/km : montant/);
    expect(errorsOf({ ...valid, shortTripBands: "7 : 1\n7 : 2" }).shortTripBands).toMatch(/même distance/);
    expect(errorsOf({ ...valid, billableDetourKm: "dix" }).billableDetourKm).toMatch(/séparés/);
    expect(errorsOf({ ...valid, nightStart: "25:00" }).nightStart).toMatch(/HH:MM/);
    expect(errorsOf({ ...valid, maxSharedPatients: "9" }).maxSharedPatients).toBe("Maximum : 8.");
    expect(errorsOf({ ...valid, sourceUrl: "ameli" }).sourceUrl).toMatch(/Adresse web/);
    expect(errorsOf({ ...valid, validTo: "2024-12-31" }).validTo).toMatch(/postérieure/);
    expect(errorsOf({ ...valid, zone: "E" }).zone).toMatch(/A, B, C ou D/);
  });

  it("gives back the values of a saved grid in the form", () => {
    const parsed = tariffSchema.parse(valid);
    const values = tariffFormValues(parsed);
    for (const key of Object.keys(valid)) expect([key, values[key]]).toEqual([key, key === "pricePerKm" ? "1,1" : valid[key]]);
  });

  it("starts a new version from a grid with other dates", () => {
    const values = tariffFormValues(tariffRow(), { validFrom: "2026-11-09", validTo: "" });
    expect(values.validFrom).toBe("2026-11-09");
    expect(values.discount2).toBe("23");
    expect(values.discount4).toBe("");
  });
});

describe("previewFareGrid", () => {
  it("previews from the amounts alone, whatever the scope or dates typed so far", () => {
    const grid = previewFareGrid((name) => ({ ...valid, department: "", validFrom: "" })[name] ?? "");
    expect(grid?.baseFare).toBe(15.75);
    expect(grid?.shortTripBands).toHaveLength(2);
    expect(previewFareGrid((name) => ({ ...valid, baseFare: "" })[name] ?? "")).toBeNull();
  });
});

describe("tariffStatus", () => {
  const grid = { id: "g", validFrom: fromIsoDate("2026-01-01"), validTo: fromIsoDate("2026-12-31") };
  it("tells in force, upcoming, expired and superseded grids apart", () => {
    expect(tariffStatus(grid, "2026-06-01", new Set(["g"]))).toBe("IN_FORCE");
    expect(tariffStatus(grid, "2025-12-31", new Set())).toBe("UPCOMING");
    expect(tariffStatus(grid, "2027-01-01", new Set())).toBe("EXPIRED");
    expect(tariffStatus(grid, "2026-06-01", new Set())).toBe("SUPERSEDED");
  });
});
