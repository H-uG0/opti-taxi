import { describe, expect, it } from "vitest";
import { patientAbsenceSchema } from "./absence-schema";

describe("patientAbsenceSchema", () => {
  it("reads a reason, two dates (French or ISO) and an optional note", () => {
    const parsed = patientAbsenceSchema.safeParse({ kind: "HOSPITALIZATION", startDate: "16/11/2026", endDate: "2026-11-20", note: " " });
    expect(parsed.success && parsed.data).toEqual({ kind: "HOSPITALIZATION", startDate: "2026-11-16", endDate: "2026-11-20", note: null });
  });

  it("refuses an end before the start, a year and more, and an unknown reason", () => {
    const before = patientAbsenceSchema.safeParse({ kind: "HOLIDAY", startDate: "2026-11-16", endDate: "2026-11-15" });
    expect(before.success).toBe(false);
    const long = patientAbsenceSchema.safeParse({ kind: "HOLIDAY", startDate: "2026-11-16", endDate: "2027-11-17" });
    expect(long.success).toBe(false);
    expect(patientAbsenceSchema.safeParse({ kind: "SICK", startDate: "2026-11-16", endDate: "2026-11-16" }).success).toBe(false);
  });
});
