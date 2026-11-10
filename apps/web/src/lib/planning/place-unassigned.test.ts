import { describe, expect, it } from "vitest";
import type { OptimizeInput } from "@/lib/optimizer/build-request";
import { pinAssignedTrips } from "./place-unassigned";

const input = (trips: Array<{ id: string; lockedVehicleId: string | null }>) => ({ date: "2026-11-10", trips }) as unknown as OptimizeInput;

describe("pinAssignedTrips", () => {
  it("locks every trip in a route on that route's vehicle, in the request only", () => {
    const day = input([
      { id: "a", lockedVehicleId: null },
      { id: "b", lockedVehicleId: null },
      { id: "c", lockedVehicleId: "v9" },
    ]);
    const pinned = pinAssignedTrips(day, new Map([["a", "t1"], ["c", "t2"]]));
    expect(pinned.input.trips.map((t) => [t.id, t.lockedVehicleId])).toEqual([
      ["a", "t1"],
      ["b", null],
      // The regulator's own lock wins, even on another vehicle.
      ["c", "v9"],
    ]);
    expect([...pinned.pinned]).toEqual(["a"]);
    expect(pinned.toPlace).toBe(1);
    // The day's input itself is not changed.
    expect(day.trips[0]?.lockedVehicleId).toBeNull();
  });
});
