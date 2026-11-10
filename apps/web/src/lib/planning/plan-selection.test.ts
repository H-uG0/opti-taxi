import { describe, expect, it } from "vitest";
import { mergeSelection, refusableVehicles, selectionHint, selectionKeySource, type StopSequence } from "./plan-selection";

const route = (vehicleId: string, trips: string[]): StopSequence => ({
  vehicleId,
  stops: trips.flatMap((tripId) => [
    { tripId, kind: "PICKUP" as const },
    { tripId, kind: "DROPOFF" as const },
  ]),
});

const all = (ids: string[]) => new Set(ids);

describe("mergeSelection", () => {
  // In place: taxi1 a b, taxi2 c, vsl1 d. New plan: taxi1 a c, taxi2 b, vsl1 d e.
  const inPlace = [route("taxi1", ["a", "b"]), route("taxi2", ["c"]), route("vsl1", ["d"])];
  const next = [route("taxi1", ["a", "c"]), route("taxi2", ["b"]), route("vsl1", ["d", "e"])];
  const vehicles = all(["taxi1", "taxi2", "vsl1"]);
  const trips = all(["a", "b", "c", "d", "e"]);

  it("takes the new plan when nothing is refused", () => {
    const merged = mergeSelection({ inPlace, next, refused: new Set(), vehicleIds: vehicles, tripIds: trips });
    expect(merged.routes).toEqual(next);
    expect(merged.keptOnRefused).toEqual([]);
    expect(merged.leftOut).toEqual([]);
  });

  it("keeps a refused vehicle's route as it is, and takes its trips out of the accepted routes", () => {
    const merged = mergeSelection({ inPlace, next, refused: new Set(["taxi2"]), vehicleIds: vehicles, tripIds: trips });
    expect(merged.routes).toEqual([route("taxi2", ["c"]), route("taxi1", ["a"]), route("vsl1", ["d", "e"])]);
    expect(merged.keptOnRefused).toEqual([{ tripId: "c", vehicleId: "taxi2", insteadOf: "taxi1" }]);
    // b left taxi1 (accepted) for taxi2 (refused): no route serves it any more, and it is said.
    expect(merged.leftOut).toEqual([{ tripId: "b", inPlace: "taxi1", next: "taxi2" }]);
  });

  it("never serves a trip twice nor keeps a route in place of a vehicle no longer sent", () => {
    const merged = mergeSelection({
      inPlace: [...inPlace, route("off", ["f"])],
      next,
      refused: new Set(["taxi1", "taxi2", "off"]),
      vehicleIds: vehicles,
      tripIds: all(["a", "b", "c", "d", "e", "f"]),
    });
    const served = merged.routes.flatMap((r) => r.stops.filter((s) => s.kind === "PICKUP").map((s) => s.tripId));
    expect(new Set(served).size).toBe(served.length);
    expect(merged.routes.map((r) => r.vehicleId)).toEqual(["taxi1", "taxi2", "vsl1"]);
    expect(merged.leftOut).toEqual([{ tripId: "f", inPlace: "off", next: null }]);
  });

  it("refusing a new route leaves its trips without a vehicle, named", () => {
    const merged = mergeSelection({
      inPlace: [route("taxi1", ["a", "b"])],
      next: [route("taxi1", ["a"]), route("taxi9", ["b"])],
      refused: new Set(["taxi9"]),
      vehicleIds: all(["taxi1", "taxi9"]),
      tripIds: all(["a", "b"]),
    });
    expect(merged.routes).toEqual([route("taxi1", ["a"])]);
    expect(merged.leftOut).toEqual([{ tripId: "b", inPlace: "taxi1", next: "taxi9" }]);
  });
});

describe("selection helpers", () => {
  it("keys the routes whatever their order", () => {
    expect(selectionKeySource([route("b", ["x"]), route("a", ["y"])])).toBe(selectionKeySource([route("a", ["y"]), route("b", ["x"])]));
    expect(selectionKeySource([route("a", ["y", "x"])])).not.toBe(selectionKeySource([route("a", ["x", "y"])]));
  });

  it("says how to keep the trips left without a vehicle", () => {
    const label = (id: string) => id.toUpperCase();
    expect(selectionHint([], new Set(), label)).toBeNull();
    expect(selectionHint([{ tripId: "b", inPlace: "taxi1", next: "taxi2" }], new Set(["taxi2"]), label)).toBe(
      "Pour qu'elle garde un véhicule, cochez aussi TAXI2, ou décochez TAXI1.",
    );
    expect(
      selectionHint(
        [
          { tripId: "b", inPlace: "off", next: "taxi2" },
          { tripId: "c", inPlace: "off", next: "taxi2" },
        ],
        new Set(["taxi2", "off"]),
        label,
      ),
    ).toBe("Pour qu'elles gardent un véhicule, cochez aussi TAXI2.");
  });

  it("offers to refuse a vehicle sent today, or a new route", () => {
    const changed = [
      { vehicleId: "taxi1", before: {} },
      { vehicleId: "off", before: {} },
      { vehicleId: "new", before: null },
    ];
    expect([...refusableVehicles(changed, all(["taxi1", "new"]))]).toEqual(["taxi1", "new"]);
  });
});
