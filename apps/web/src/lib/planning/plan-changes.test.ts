import { describe, expect, it } from "vitest";
import {
  changeCounts,
  changesOfVehicle,
  changesText,
  placementsOf,
  planChanges,
  reviewQuestion,
  routeChangeText,
  SHIFT_NOTICE_MIN,
  type PlanSide,
  type RouteSide,
} from "./plan-changes";

const route = (vehicleId: string, trips: string[], km = 10, margin = 20): RouteSide => ({
  vehicleId,
  distanceKm: km,
  margin,
  stops: trips.flatMap((tripId) => [
    { tripId, kind: "PICKUP" as const },
    { tripId, kind: "DROPOFF" as const },
  ]),
});

function side(routes: RouteSide[], pickups: Record<string, number>): PlanSide {
  return { routes, placements: placementsOf(routes, (id) => pickups[id] ?? null) };
}

describe("planChanges", () => {
  it("lists the trips that change vehicle, move by 10 min or more, lose or get a vehicle", () => {
    const before = side([route("taxi1", ["a", "b", "c"]), route("vsl1", ["d"])], { a: 480, b: 500, c: 600, d: 700 });
    const after = side([route("taxi1", ["a", "c"]), route("vsl1", ["b", "e"])], {
      a: 480 + SHIFT_NOTICE_MIN - 1,
      b: 505,
      c: 600 + SHIFT_NOTICE_MIN,
      e: 720,
    });
    const changes = planChanges(before, after);
    expect(changes.trips).toEqual([
      { tripId: "d", kind: "unassigned", from: "vsl1", to: null, fromPickupMinute: 700, toPickupMinute: null },
      { tripId: "b", kind: "vehicle", from: "taxi1", to: "vsl1", fromPickupMinute: 500, toPickupMinute: 505 },
      { tripId: "c", kind: "time", from: "taxi1", to: "taxi1", fromPickupMinute: 600, toPickupMinute: 610 },
      { tripId: "e", kind: "assigned", from: null, to: "vsl1", fromPickupMinute: null, toPickupMinute: 720 },
    ]);
    expect(changeCounts(changes)).toEqual({ unassigned: 1, vehicle: 1, time: 1, assigned: 1 });
  });

  it("lists every vehicle whose stop sequence changes, a route created or removed included", () => {
    const before = side([route("taxi1", ["a", "b"], 30, 50), route("taxi2", ["c"]), route("vsl1", ["d"])], {});
    const after = side([route("taxi1", ["b", "a"], 28, 55), route("taxi2", ["c"]), route("amb1", ["d"], 12, 40)], {});
    expect(planChanges(before, after).routes).toEqual([
      { vehicleId: "taxi1", before: { trips: 2, km: 30, margin: 50 }, after: { trips: 2, km: 28, margin: 55 } },
      { vehicleId: "vsl1", before: { trips: 1, km: 10, margin: 20 }, after: null },
      { vehicleId: "amb1", before: null, after: { trips: 1, km: 12, margin: 40 } },
    ]);
  });

  it("reads stored stops by their sequence, whatever their order", () => {
    const stored: RouteSide = {
      vehicleId: "taxi1",
      distanceKm: 10,
      margin: 20,
      stops: [
        { tripId: "a", kind: "DROPOFF", sequence: 1 },
        { tripId: "a", kind: "PICKUP", sequence: 0 },
      ],
    };
    expect(planChanges(side([stored], {}), side([route("taxi1", ["a"])], {})).routes).toEqual([]);
  });

  it("leaves out the trips the new plan was not computed for", () => {
    const before = side([route("taxi1", ["a", "gone"])], { a: 480, gone: 500 });
    const after = side([route("taxi1", ["a"])], { a: 480 });
    expect(planChanges(before, after, new Set(["a"])).trips).toEqual([]);
    expect(planChanges(before, after).trips).toHaveLength(1);
  });
});

describe("texts", () => {
  it("says the changes, most serious first", () => {
    expect(changesText({ unassigned: 1, vehicle: 3, time: 2, assigned: 0 })).toBe(
      "1 course resterait sans véhicule, 3 courses changent de véhicule, 2 prises en charge décalées de 10\u00a0min ou plus",
    );
    expect(changesText({ unassigned: 0, vehicle: 1, time: 0, assigned: 2 })).toBe("1 course change de véhicule, 2 courses placées");
  });

  it("asks to review, with or without the per-vehicle choice", () => {
    const changes = { trips: [{ tripId: "a", kind: "vehicle" as const, from: "x", to: "y", fromPickupMinute: 1, toPickupMinute: 2 }] };
    expect(reviewQuestion(changes, "Ce calcul", true)).toBe(
      "Ce calcul change 1 course du planning en place\u00a0: 1 course change de véhicule. Vérifiez la liste «\u202fChangements\u202f», puis enregistrez tout ou véhicule par véhicule.",
    );
    expect(reviewQuestion(changes, "Ce placement", false)).toMatch(/avant de l'enregistrer\.$/);
  });

  it("does not count a trip it only places as a change of the plan in place", () => {
    const placed = { tripId: "p", kind: "assigned" as const, from: null, to: "y", fromPickupMinute: null, toPickupMinute: 600 };
    const moved = { tripId: "a", kind: "vehicle" as const, from: "x", to: "y", fromPickupMinute: 1, toPickupMinute: 2 };
    expect(reviewQuestion({ trips: [placed] }, "Ce calcul", false)).toBe(
      "Ce calcul place 1 course de plus. Vérifiez la liste «\u202fChangements\u202f» avant de l'enregistrer.",
    );
    expect(reviewQuestion({ trips: [moved, placed, { ...placed, tripId: "q" }] }, "Ce calcul", false)).toMatch(
      /^Ce calcul change 1 course du planning en place\u00a0: 1 course change de véhicule, et place 2 courses de plus\. /,
    );
  });

  it("sums up a vehicle's route before and after", () => {
    expect(routeChangeText({ before: { trips: 6, km: 120, margin: 80 }, after: { trips: 5, km: 108, margin: 100 } })).toBe(
      "6 → 5 courses · \u221212,0\u00a0km · marge\u00a0+20\u00a0€",
    );
    expect(routeChangeText({ before: null, after: { trips: 3, km: 41.6, margin: 30 } })).toBe(
      "nouvelle tournée, 3 courses · 42\u00a0km · marge\u00a0+30\u00a0€",
    );
    expect(routeChangeText({ before: { trips: 4, km: 50, margin: 10 }, after: null })).toBe("tournée retirée (4 courses)");
  });

  it("finds the changes of a vehicle on both ends", () => {
    const changes = planChanges(
      side([route("taxi1", ["a"]), route("taxi2", ["b"])], { a: 1, b: 2 }),
      side([route("taxi2", ["a", "b"])], { a: 1, b: 2 }),
    );
    expect(changesOfVehicle(changes, "taxi1").map((c) => c.tripId)).toEqual(["a"]);
    expect(changesOfVehicle(changes, "taxi2").map((c) => c.tripId)).toEqual(["a"]);
  });
});
