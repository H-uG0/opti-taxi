import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { fieldErrorsFromZod } from "@/lib/forms";
import { deadlineSchema, fuelSchema, odometerConflict, unavailabilitySchema } from "./fleet-schema";

function errorsOf(schema: z.ZodType, input: Record<string, string>) {
  const result = schema.safeParse(input);
  return result.success ? {} : fieldErrorsFromZod(result.error).fieldErrors;
}

describe("unavailabilitySchema", () => {
  it("accepts one day or a range, refuses an end before the start", () => {
    expect(unavailabilitySchema.parse({ kind: "ON_CALL", startDate: "2026-11-11", endDate: "2026-11-11", note: "" })).toMatchObject({
      kind: "ON_CALL",
      note: null,
    });
    expect(errorsOf(unavailabilitySchema, { kind: "REPAIR", startDate: "2026-11-12", endDate: "2026-11-10" }).endDate).toMatch(/même jour/);
  });
});

describe("deadlineSchema", () => {
  it("needs a date, a mileage or both", () => {
    expect(deadlineSchema.parse({ kind: "SERVICE", label: "Vidange", dueDate: "", dueKm: "90 000", note: "" })).toEqual({
      kind: "SERVICE",
      label: "Vidange",
      dueDate: null,
      dueKm: 90000,
      note: null,
    });
    expect(deadlineSchema.parse({ kind: "INSPECTION", dueDate: "01/03/2027", dueKm: "" }).dueDate).toBe("2027-03-01");
    expect(errorsOf(deadlineSchema, { kind: "INSURANCE", dueDate: "", dueKm: "" }).dueDate).toMatch(/date, un kilométrage/);
  });
});

describe("fuelSchema", () => {
  it("reads a fill, the full-tank box included", () => {
    expect(fuelSchema.parse({ date: "2026-11-07", odometerKm: "51 230", quantity: "42,5", cost: "76,10", fullTank: "on" })).toEqual({
      date: "2026-11-07",
      odometerKm: 51230,
      quantity: 42.5,
      cost: 76.1,
      fullTank: true,
      note: null,
    });
    expect(fuelSchema.parse({ date: "2026-11-07", odometerKm: "1", quantity: "1", cost: "1" }).fullTank).toBe(false);
  });

  it("refuses an odometer that goes backwards", () => {
    // French number formatting separates thousands with a narrow no-break space.
    const plain = (text: string | null) => text?.replace(/\s/g, " ") ?? null;
    const others = [
      { date: "2026-10-01", odometerKm: 50_000 },
      { date: "2026-11-01", odometerKm: 51_000 },
    ];
    expect(odometerConflict({ date: "2026-11-07", odometerKm: 51_200 }, others)).toBeNull();
    expect(plain(odometerConflict({ date: "2026-11-07", odometerKm: 50_900 }, others))).toBe("Compteur inférieur au relevé du 01/11/2026 (51 000 km).");
    expect(plain(odometerConflict({ date: "2026-10-15", odometerKm: 51_100 }, others))).toBe(
      "Compteur supérieur au relevé suivant du 01/11/2026 (51 000 km).",
    );
  });
});
