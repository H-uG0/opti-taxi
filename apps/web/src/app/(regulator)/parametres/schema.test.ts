import { describe, expect, it } from "vitest";
import { fieldErrorsFromZod } from "@/lib/forms";
import { settingsFormValues, settingsSchema } from "./schema";

const defaults = {
  waitBeforeAppointmentMin: "30",
  waitAfterSessionMin: "15",
  maxTotalWaitMin: "45",
  maxDetourKmPerExtraPatient: "10",
  maxDetourKmTotal: "30",
  pickupServiceMin: "5",
  dropoffServiceMin: "5",
  unassignedPenalty: "10 000",
  solverTimeLimitSec: "10",
};

/** Field errors exactly as the form displays them (first issue per field). */
function errorsOf(input: Record<string, string>) {
  const result = settingsSchema.safeParse(input);
  return result.success ? {} : fieldErrorsFromZod(result.error).fieldErrors;
}

describe("settingsSchema", () => {
  it("accepts the schema defaults", () => {
    expect(settingsSchema.parse(defaults)).toEqual({
      waitBeforeAppointmentMin: 30,
      waitAfterSessionMin: 15,
      maxTotalWaitMin: 45,
      maxDetourKmPerExtraPatient: 10,
      maxDetourKmTotal: 30,
      pickupServiceMin: 5,
      dropoffServiceMin: 5,
      unassignedPenalty: 10000,
      solverTimeLimitSec: 10,
    });
  });

  it("enforces waitBefore + waitAfter <= maxTotalWait", () => {
    expect(errorsOf({ ...defaults, waitAfterSessionMin: "20" }).maxTotalWaitMin).toBe(
      "Marge avant le RDV (30 min) + marge après la séance (20 min) = 50 min : dépasse l'attente maximale de 45 min.",
    );
    expect(errorsOf({ ...defaults, maxTotalWaitMin: "40" }).maxTotalWaitMin).toMatch(/= 45 min : dépasse l'attente maximale de 40 min/);
    expect(settingsSchema.parse({ ...defaults, waitBeforeAppointmentMin: "20", maxTotalWaitMin: "35" }).maxTotalWaitMin).toBe(35);
  });

  it("caps the waits and detours at the decree limits", () => {
    expect(errorsOf({ ...defaults, maxTotalWaitMin: "60" }).maxTotalWaitMin).toMatch(/décret 2025-202/);
    expect(errorsOf({ ...defaults, maxDetourKmPerExtraPatient: "12" }).maxDetourKmPerExtraPatient).toMatch(/10 km maximum/);
    expect(errorsOf({ ...defaults, maxDetourKmTotal: "35" }).maxDetourKmTotal).toMatch(/30 km maximum/);
    expect(settingsSchema.parse({ ...defaults, maxDetourKmPerExtraPatient: "7,5", maxDetourKmTotal: "20" }).maxDetourKmPerExtraPatient).toBe(7.5);
  });

  it("keeps the per-patient detour under the total", () => {
    expect(errorsOf({ ...defaults, maxDetourKmPerExtraPatient: "10", maxDetourKmTotal: "8" }).maxDetourKmPerExtraPatient).toMatch(
      /plafond total/,
    );
  });

  it("bounds the solver time limit and the stop times", () => {
    expect(errorsOf({ ...defaults, solverTimeLimitSec: "0" }).solverTimeLimitSec).toMatch(/Minimum/);
    expect(errorsOf({ ...defaults, solverTimeLimitSec: "121" }).solverTimeLimitSec).toMatch(/Maximum : 120 s/);
    expect(errorsOf({ ...defaults, solverTimeLimitSec: "2,5" }).solverTimeLimitSec).toBe("Nombre entier attendu.");
    expect(errorsOf({ ...defaults, pickupServiceMin: "61" }).pickupServiceMin).toMatch(/Maximum/);
    expect(errorsOf({ ...defaults, unassignedPenalty: "" }).unassignedPenalty).toBe("Champ obligatoire.");
  });

  it("round-trips through the form values", () => {
    const parsed = settingsSchema.parse({ ...defaults, maxDetourKmPerExtraPatient: "7,5" });
    expect(settingsSchema.parse(settingsFormValues(parsed))).toEqual(parsed);
  });
});
