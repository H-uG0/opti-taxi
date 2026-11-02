import { describe, expect, it } from "vitest";
import { fromIsoDate } from "@/lib/time";
import { fieldErrorsFromZod } from "@/lib/forms";
import { patientFare, sharedComparison, sharedDiscount, soloFare } from "./fare";
import { fractionToPercent, percentToFraction, tariffFormValues, tariffSchema, tariffStatus } from "./schema";

const valid = {
  vehicleType: "TAXI",
  department: "13",
  label: "Convention taxis 2025",
  baseFare: "13",
  pricePerKm: "1,12",
  includedKm: "",
  sharedDiscount2: "23",
  sharedDiscount3: "35",
  validFrom: "2025-05-01",
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

describe("tariffSchema", () => {
  it("stores discounts as fractions and dates as @db.Date", () => {
    expect(tariffSchema.parse(valid)).toEqual({
      vehicleType: "TAXI",
      department: "13",
      label: "Convention taxis 2025",
      baseFare: 13,
      pricePerKm: 1.12,
      includedKm: 0,
      sharedDiscount2: 0.23,
      sharedDiscount3: 0.35,
      validFrom: fromIsoDate("2025-05-01"),
      validTo: null,
      notes: null,
    });
  });

  it("accepts the all-zones department", () => {
    expect(tariffSchema.parse({ ...valid, department: "*" }).department).toBe("*");
  });

  it("checks percent ranges and their order", () => {
    expect(errorsOf({ ...valid, sharedDiscount2: "120" }).sharedDiscount2).toBe("Maximum : 100 %.");
    expect(errorsOf({ ...valid, sharedDiscount2: "40", sharedDiscount3: "35" }).sharedDiscount3).toMatch(/inférieur/);
    expect(tariffSchema.parse({ ...valid, sharedDiscount2: "35", sharedDiscount3: "35" }).sharedDiscount3).toBe(0.35);
  });

  it("requires validTo >= validFrom", () => {
    expect(errorsOf({ ...valid, validTo: "2025-04-30" }).validTo).toMatch(/postérieure/);
    expect(tariffSchema.parse({ ...valid, validTo: "2025-05-01" }).validTo).toEqual(fromIsoDate("2025-05-01"));
    expect(errorsOf({ ...valid, validFrom: "" }).validFrom).toBe("Champ obligatoire.");
  });

  it("rejects negative amounts", () => {
    expect(errorsOf({ ...valid, baseFare: "-1" }).baseFare).toMatch(/Minimum/);
    expect(errorsOf({ ...valid, pricePerKm: "" }).pricePerKm).toBe("Champ obligatoire.");
  });

  it("round-trips through the form values, and duplicates with overrides", () => {
    const parsed = tariffSchema.parse(valid);
    expect(tariffSchema.parse(tariffFormValues(parsed))).toEqual(parsed);
    const copy = tariffFormValues({ ...parsed, validTo: fromIsoDate("2025-12-31") }, { validFrom: "2026-01-01", validTo: "" });
    expect(copy.validFrom).toBe("2026-01-01");
    expect(copy.validTo).toBe("");
    expect(copy.sharedDiscount2).toBe("23");
    expect(copy.pricePerKm).toBe("1,12");
  });
});

describe("tariffStatus", () => {
  const grid = { id: "g1", validFrom: fromIsoDate("2025-05-01"), validTo: fromIsoDate("2025-12-31") };

  it("classifies a grid", () => {
    expect(tariffStatus(grid, "2025-06-01", new Set(["g1"]))).toBe("IN_FORCE");
    expect(tariffStatus(grid, "2025-06-01", new Set())).toBe("SUPERSEDED");
    expect(tariffStatus(grid, "2025-04-01", new Set())).toBe("UPCOMING");
    expect(tariffStatus(grid, "2026-01-01", new Set())).toBe("EXPIRED");
  });
});

describe("fare estimate (same formula as the optimizer)", () => {
  const grid = { baseFare: 13, pricePerKm: 1.12, includedKm: 0, sharedDiscount2: 0.23, sharedDiscount3: 0.35 };

  it("computes a solo fare", () => {
    expect(soloFare(grid, 25)).toBeCloseTo(41);
    expect(soloFare({ ...grid, includedKm: 5 }, 25)).toBeCloseTo(35.4);
    expect(soloFare({ ...grid, includedKm: 30 }, 25)).toBe(13);
  });

  it("applies the shared discount per patient", () => {
    expect(sharedDiscount(grid, 1)).toBe(0);
    expect(sharedDiscount(grid, 2)).toBe(0.23);
    expect(sharedDiscount(grid, 4)).toBe(0.35);
    expect(patientFare(grid, 25, 2)).toBeCloseTo(31.57);
  });

  it("compares solo and shared revenue for the vehicle", () => {
    const two = sharedComparison(grid, 25, 2);
    expect(two.solo).toBeCloseTo(41);
    expect(two.vehicleTotal).toBeCloseTo(63.14);
    expect(two.gainVsSolo).toBeCloseTo(0.54);
  });
});
