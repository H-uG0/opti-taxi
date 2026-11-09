import { describe, expect, it } from "vitest";
import { asksForSameDriver, SAME_DRIVER_SHARE, tripsToLock, type LockCandidate } from "./tweaks";

describe("trips frozen on their vehicle", () => {
  it("are those of the patients who ask for their driver (about 5 %), series only, placed and not frozen yet", () => {
    const patients = Array.from({ length: 2000 }, (_, i) => `patient-${i}`);
    const asking = patients.filter(asksForSameDriver);
    expect(asking.length / patients.length).toBeGreaterThan(SAME_DRIVER_SHARE - 0.02);
    expect(asking.length / patients.length).toBeLessThan(SAME_DRIVER_SHARE + 0.02);

    const patient = asking[0] ?? "";
    const trip = (overrides: Partial<LockCandidate>): LockCandidate => ({
      id: "t1",
      patientId: patient,
      recurrenceId: "rec-1",
      vehicleId: "v1",
      lockedVehicleId: null,
      ...overrides,
    });
    expect(tripsToLock([trip({ id: "t2" }), trip({ id: "t1" })])).toEqual([
      { id: "t1", vehicleId: "v1" },
      { id: "t2", vehicleId: "v1" },
    ]);
    expect(tripsToLock([trip({ recurrenceId: null })])).toEqual([]);
    expect(tripsToLock([trip({ vehicleId: null })])).toEqual([]);
    expect(tripsToLock([trip({ lockedVehicleId: "v2" })])).toEqual([]);
    const other = patients.find((p) => !asksForSameDriver(p)) ?? "";
    expect(tripsToLock([trip({ patientId: other })])).toEqual([]);
  });
});
