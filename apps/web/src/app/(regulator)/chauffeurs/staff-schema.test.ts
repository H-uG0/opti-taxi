import { describe, expect, it } from "vitest";
import { fieldErrorsFromZod } from "@/lib/forms";
import { absenceSchema, orderedPair } from "./staff-schema";

function errorsOf(input: Record<string, string>) {
  const result = absenceSchema.safeParse(input);
  return result.success ? {} : fieldErrorsFromZod(result.error).fieldErrors;
}

describe("absenceSchema", () => {
  it("accepts a one-day or a multi-day absence, French dates included", () => {
    expect(absenceSchema.parse({ kind: "ON_CALL", startDate: "2026-11-14", endDate: "14/11/2026", note: "" })).toEqual({
      kind: "ON_CALL",
      startDate: "2026-11-14",
      endDate: "2026-11-14",
      note: null,
    });
    expect(absenceSchema.parse({ kind: "LEAVE", startDate: "2026-12-21", endDate: "2027-01-02", note: "Noël" }).note).toBe("Noël");
  });

  it("rejects an end before the start, an absence over a year and an unknown kind", () => {
    expect(errorsOf({ kind: "LEAVE", startDate: "2026-11-10", endDate: "2026-11-09" }).endDate).toMatch(/même jour que le début/);
    expect(errorsOf({ kind: "LEAVE", startDate: "2026-01-01", endDate: "2027-01-02" }).endDate).toMatch(/366 jours/);
    expect(errorsOf({ kind: "HOLIDAY", startDate: "2026-11-10", endDate: "2026-11-10" }).kind).toBe("Choisissez un motif.");
  });
});

describe("orderedPair", () => {
  it("stores a pair the same way whoever enters it", () => {
    expect(orderedPair("b", "a")).toEqual({ driverAId: "a", driverBId: "b" });
    expect(orderedPair("a", "b")).toEqual(orderedPair("b", "a"));
  });
});
