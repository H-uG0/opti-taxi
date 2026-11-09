import { describe, expect, it } from "vitest";
import {
  changedRoutes,
  comparePlans,
  comparisonQuestion,
  figuresLine,
  isDrivable,
  planFigures,
  replaceConcerns,
  restorableRoutes,
  routesInPlace,
  snapshotOf,
  type PlanFigures,
  type TodayCrew,
  undrivableNote,
} from "./plan-compare";

const DEFAULTS = { maxServedLoss: 0, maxMarginLoss: 0.1 };

/** French number formatting uses no-break spaces: compared as plain spaces. */
const plain = (text: string) => text.replace(/[\u00a0\u202f]/g, " ");
const inPlace: PlanFigures = { served: 300, violations: 0, revenue: 10_000, margin: 4_800, km: 1_790 };

function compare(next: Partial<PlanFigures>, current: PlanFigures | null = inPlace) {
  return comparePlans(
    current ? { figures: current, servedTripIds: ["a", "b", "c"] } : null,
    { figures: { ...inPlace, ...next }, servedTripIds: ["a", "b"] },
  );
}

describe("replaceConcerns (default thresholds: no trip lost, no new violation, 10 % of the revenue)", () => {
  it("lets an equal or better plan replace the routes in place", () => {
    expect(replaceConcerns(compare({}), DEFAULTS)).toEqual([]);
    expect(replaceConcerns(compare({ served: 302, margin: 5_000, km: 1_700 }), DEFAULTS)).toEqual([]);
  });

  it("asks before serving fewer trips, beyond the tolerance", () => {
    expect(replaceConcerns(compare({ served: 299 }), DEFAULTS)).toEqual(["served"]);
    expect(replaceConcerns(compare({ served: 299 }), { ...DEFAULTS, maxServedLoss: 1 })).toEqual([]);
    expect(replaceConcerns(compare({ served: 297 }), { ...DEFAULTS, maxServedLoss: 2 })).toEqual(["served"]);
  });

  it("asks before any new hard violation, also on a first computation", () => {
    expect(replaceConcerns(compare({ violations: 2 }), DEFAULTS)).toEqual(["violations"]);
    expect(replaceConcerns(compare({ violations: 2 }, { ...inPlace, violations: 2 }), DEFAULTS)).toEqual([]);
    expect(replaceConcerns(compare({ violations: 1 }, null), DEFAULTS)).toEqual(["violations"]);
    expect(replaceConcerns(compare({ violations: 0 }, null), DEFAULTS)).toEqual([]);
  });

  it("asks when the margin drops by more than the share of the revenue in place", () => {
    expect(replaceConcerns(compare({ margin: 3_801 }), DEFAULTS)).toEqual([]);
    expect(replaceConcerns(compare({ margin: 3_799 }), DEFAULTS)).toEqual(["margin"]);
    expect(replaceConcerns(compare({ margin: 4_700 }), { ...DEFAULTS, maxMarginLoss: 0 })).toEqual(["margin"]);
  });

  it("lists the trips served in place that the new plan leaves out", () => {
    expect(compare({}).lostTripIds).toEqual(["c"]);
    expect(compare({}, null).lostTripIds).toEqual([]);
  });
});

describe("comparisonQuestion", () => {
  it("names the concerns, as the regulator reads them", () => {
    const comparison = compare({ served: 280, violations: 2 });
    expect(comparisonQuestion(comparison, replaceConcerns(comparison, DEFAULTS))).toBe(
      "Ce calcul sert 280 courses contre 300 dans le planning actuel, avec 2 violations de contraintes (aucune actuellement) : remplacer quand même ?",
    );
    const margin = compare({ margin: 3_000 });
    expect(plain(comparisonQuestion(margin, ["margin"]))).toBe(
      "Ce calcul dégage une marge de 3 000 € contre 4 800 € : remplacer quand même ?",
    );
  });

  it("asks to save a first computation that breaks rules", () => {
    const first = compare({ violations: 1 }, null);
    expect(comparisonQuestion(first, ["violations"])).toBe("Ce calcul comporte 1 violation de contrainte : l'enregistrer quand même ?");
  });

  it("says first which routes in place can no longer be driven, and that they are not counted", () => {
    const comparison = comparePlans(
      { figures: inPlace, servedTripIds: ["a", "b", "c"], undrivable: { vehicles: ["Taxi 2", "VSL 2"], trips: 8 } },
      { figures: { ...inPlace, served: 299 }, servedTripIds: ["a", "b"] },
    );
    expect(comparison.undrivable).toEqual({ vehicles: ["Taxi 2", "VSL 2"], trips: 8 });
    expect(comparisonQuestion(comparison, ["served"])).toBe(
      "Les tournées de Taxi 2 et VSL 2 ne peuvent plus être assurées : 8 courses ne sont pas comptées comme servies dans le planning actuel. " +
        "Ce calcul sert 299 courses contre 300 dans le planning actuel : remplacer quand même ?",
    );
    expect(undrivableNote({ undrivable: { vehicles: ["VSL 2 (Manosque)"], trips: 1 } })).toBe(
      "La tournée de VSL 2 (Manosque) ne peut plus être assurée : 1 course n'est pas comptée comme servie dans le planning actuel.",
    );
    // Nothing to say when every route can be driven.
    const none = comparePlans(
      { figures: inPlace, servedTripIds: [], undrivable: { vehicles: [], trips: 0 } },
      { figures: inPlace, servedTripIds: [] },
    );
    expect(none).not.toHaveProperty("undrivable");
  });
});

describe("isDrivable (routes in place against the vehicles and crews of today's request)", () => {
  const today = new Map<string, TodayCrew>([
    ["taxi", { driverId: "d1" }],
    ["amb", { driverId: "d2", crewMateId: "d3" }],
  ]);

  it("keeps a route on a vehicle sent today with the same crew", () => {
    expect(isDrivable({ vehicleId: "taxi", driverId: "d1", crewMateId: null }, today)).toBe(true);
    expect(isDrivable({ vehicleId: "amb", driverId: "d2", crewMateId: "d3" }, today)).toBe(true);
    // A crew mate left on a taxi route (legacy data) does not matter: only an ambulance has a crew of two.
    expect(isDrivable({ vehicleId: "taxi", driverId: "d1", crewMateId: "d7" }, today)).toBe(true);
  });

  it("drops a route whose vehicle is no longer sent (unavailable, deactivated) or whose crew changed", () => {
    expect(isDrivable({ vehicleId: "vsl", driverId: "d4", crewMateId: null }, today)).toBe(false);
    expect(isDrivable({ vehicleId: "taxi", driverId: "d9", crewMateId: null }, today)).toBe(false);
    expect(isDrivable({ vehicleId: "amb", driverId: "d2", crewMateId: "d8" }, today)).toBe(false);
    expect(isDrivable({ vehicleId: "taxi", driverId: null, crewMateId: null }, today)).toBe(false);
  });
});

describe("figures", () => {
  it("sums the routes and formats a short line", () => {
    const figures = planFigures(
      [
        { revenue: 100.123, margin: 40.5, distanceKm: 80.25 },
        { revenue: 50, margin: -10, distanceKm: 20 },
      ],
      3,
      0,
    );
    expect(figures).toEqual({ served: 3, violations: 0, revenue: 150.12, margin: 30.5, km: 100.25 });
    expect(plain(figuresLine(figures))).toBe("3 courses servies · aucune violation · marge 31 € · 100 km");
  });
});

describe("snapshot and restoration", () => {
  const figures = planFigures([], 2, 0);
  const snapshot = snapshotOf(
    "run_0",
    [
      {
        vehicleId: "v1",
        revenue: 0,
        margin: 0,
        distanceKm: 0,
        stops: [
          { tripId: "b", kind: "DROPOFF", sequence: 3 },
          { tripId: "a", kind: "PICKUP", sequence: 0 },
          { tripId: "b", kind: "PICKUP", sequence: 1 },
          { tripId: "a", kind: "DROPOFF", sequence: 2 },
        ],
      },
      { vehicleId: "v2", revenue: 0, margin: 0, distanceKm: 0, stops: [] },
    ],
    figures,
  );

  it("keeps the stop sequences in order, without empty routes", () => {
    expect(snapshot.routes).toEqual([
      {
        vehicleId: "v1",
        stops: [
          { tripId: "a", kind: "PICKUP" },
          { tripId: "b", kind: "PICKUP" },
          { tripId: "a", kind: "DROPOFF" },
          { tripId: "b", kind: "DROPOFF" },
        ],
      },
    ]);
  });

  it("restores only what can still be evaluated: vehicles and trips still sent, complete pairs", () => {
    expect(restorableRoutes(snapshot, new Set(["v1"]), new Set(["a", "b"]))).toEqual(snapshot.routes);
    // Trip b cancelled since: its stops go, a keeps its order.
    expect(restorableRoutes(snapshot, new Set(["v1"]), new Set(["a"]))).toEqual([
      { vehicleId: "v1", stops: [{ tripId: "a", kind: "PICKUP" }, { tripId: "a", kind: "DROPOFF" }] },
    ]);
    // Vehicle unavailable since: nothing on it.
    expect(restorableRoutes(snapshot, new Set(["v2"]), new Set(["a", "b"]))).toEqual([]);
  });

  it("drops a trip whose drop-off comes before its pick-up, and a trip met on two routes keeps the first", () => {
    const odd = {
      routes: [
        { vehicleId: "v1", stops: [{ tripId: "a", kind: "DROPOFF" as const }, { tripId: "a", kind: "PICKUP" as const }] },
        { vehicleId: "v2", stops: [{ tripId: "b", kind: "PICKUP" as const }, { tripId: "b", kind: "DROPOFF" as const }] },
        { vehicleId: "v3", stops: [{ tripId: "b", kind: "PICKUP" as const }, { tripId: "b", kind: "DROPOFF" as const }] },
      ],
    };
    expect(restorableRoutes(odd, new Set(["v1", "v2", "v3"]), new Set(["a", "b"]))).toEqual([odd.routes[1]]);
  });
});

describe("routesInPlace (start of a re-optimization)", () => {
  const request = { vehicles: [{ id: "v1" }, { id: "v2" }], trips: [{ id: "a" }, { id: "b" }] };

  it("sends the stop sequences in their order, on the vehicles and trips of the request", () => {
    const routes = [
      {
        vehicleId: "v1",
        stops: [
          { tripId: "a", kind: "DROPOFF" as const, sequence: 3 },
          { tripId: "a", kind: "PICKUP" as const, sequence: 0 },
          { tripId: "cancelled", kind: "PICKUP" as const, sequence: 1 },
          { tripId: "cancelled", kind: "DROPOFF" as const, sequence: 2 },
        ],
      },
      { vehicleId: "off_today", stops: [{ tripId: "b", kind: "PICKUP" as const, sequence: 0 }, { tripId: "b", kind: "DROPOFF" as const, sequence: 1 }] },
    ];
    expect(routesInPlace(routes, request)).toEqual([
      { vehicleId: "v1", stops: [{ tripId: "a", kind: "PICKUP" }, { tripId: "a", kind: "DROPOFF" }] },
    ]);
  });

  it("is null when nothing of the routes in place is still to plan", () => {
    expect(routesInPlace([], request)).toBeNull();
    expect(routesInPlace([{ vehicleId: "v2", stops: [] }], request)).toBeNull();
    expect(routesInPlace([{ vehicleId: "v1", stops: [{ tripId: "x", kind: "PICKUP", sequence: 0 }] }], request)).toBeNull();
  });
});

describe("changedRoutes", () => {
  const stored = (vehicleId: string, ...trips: string[]) => ({
    vehicleId,
    // Stored in any order: read by sequence.
    stops: trips
      .flatMap((tripId) => [
        { tripId, kind: "PICKUP" as const },
        { tripId, kind: "DROPOFF" as const },
      ])
      .map((stop, sequence) => ({ ...stop, sequence }))
      .reverse(),
  });
  const planned = (vehicleId: string, ...trips: string[]) => ({
    vehicleId,
    stops: trips.flatMap((tripId) => [
      { tripId, kind: "PICKUP" as const },
      { tripId, kind: "DROPOFF" as const },
    ]),
  });

  it("finds the routes in place given back unchanged", () => {
    const inPlace = [stored("v1", "a", "b"), stored("v2", "c"), { vehicleId: "v3", stops: [] }];
    expect(changedRoutes(inPlace, [planned("v1", "a", "b"), planned("v2", "c")])).toEqual({ changed: 0, removed: 0, total: 2 });
  });

  it("counts the routes reordered, moved or new, and those taken off", () => {
    const inPlace = [stored("v1", "a", "b"), stored("v2", "c"), stored("v3", "d")];
    const next = [planned("v1", "b", "a"), planned("v2", "c"), planned("v4", "d")];
    expect(changedRoutes(inPlace, next)).toEqual({ changed: 2, removed: 1, total: 3 });
    expect(changedRoutes([], next)).toEqual({ changed: 3, removed: 0, total: 3 });
  });
});
