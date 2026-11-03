import { describe, expect, it } from "vitest";
import { LOCKED, lockAction, notLockedOn } from "./lock";

describe("lock writes", () => {
  it("matches unlocked trips explicitly when looking for trips not locked on a vehicle", () => {
    expect(notLockedOn("veh_1")).toEqual({ OR: [{ lockedVehicleId: null }, { lockedVehicleId: { not: "veh_1" } }] });
    expect(LOCKED).toEqual({ lockedVehicleId: { not: null } });
  });

  it("traces putting a lock back as a lock, and removing it as an unlock", () => {
    expect(lockAction("veh_2")).toBe("trip.lock");
    expect(lockAction(null)).toBe("trip.unlock");
  });
});
