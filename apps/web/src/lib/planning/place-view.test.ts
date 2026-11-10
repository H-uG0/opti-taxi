import { describe, expect, it } from "vitest";
import { planningFixture, vehicleRow } from "@/test/planning-fixtures";
import {
  groupPlaces,
  marginText,
  placeFiguresText,
  placesSummary,
  placeTimesText,
  sharedText,
  shiftsText,
  signedDurationText,
  signedKmText,
  unavailableReason,
  type PlaceOptionView,
  type PlacesView,
} from "./place-view";

function option(vehicleId: string, overrides: Partial<PlaceOptionView> = {}): PlaceOptionView {
  return {
    vehicleId,
    pickupMinute: 552,
    dropoffMinute: 580,
    shared: false,
    coPassengerTripIds: [],
    deltaKm: 6.24,
    deltaEmptyKm: 2.1,
    deltaDurationMin: 25,
    deltaRevenue: 30,
    deltaMargin: 18.4,
    shifts: [],
    remainingViolations: 0,
    ...overrides,
  };
}

function view(overrides: Partial<PlacesView> = {}): PlacesView {
  return { tripId: "trip-c", fromVehicleId: null, version: "v1", options: [], rejected: [], elapsedMs: 640, straightLine: false, ...overrides };
}

const aix = { id: "depot-aix", lat: 43.53, lng: 5.45, label: "Aix-en-Provence" };

describe("groupPlaces", () => {
  const { vehicles } = planningFixture();
  const fleet = [
    ...vehicles,
    vehicleRow({ id: "taxi-9", label: "Taxi 9 (Aix)", depot: aix, route: null }),
    vehicleRow({ id: "taxi-10", label: "Taxi 10 (Aix)", depot: aix, route: null }),
  ];

  it("puts the depot of the best place first, places by margin, then the vehicles without a place by name", () => {
    const groups = groupPlaces(
      view({
        options: [option("taxi-9", { deltaMargin: 40 }), option("vsl-1", { deltaMargin: 12 }), option("taxi-1", { deltaMargin: 3 })],
        rejected: [{ vehicleId: "taxi-10", kind: "BREAK", reason: "est en pause de 12:00 à 12:45" }],
      }),
      fleet,
      ["TAXI", "VSL"],
    );
    expect(groups.map((g) => g.depotLabel)).toEqual(["Aix-en-Provence", "Marseille", "Manosque"]);
    expect(groups[0]?.options.map((o) => o.label)).toEqual(["Taxi 9 (Aix)"]);
    expect(groups[0]?.rejected.map((r) => [r.label, r.kind])).toEqual([["Taxi 10 (Aix)", "BREAK"]]);
    expect(groups[1]?.options.map((o) => o.vehicleId)).toEqual(["vsl-1", "taxi-1"]);
  });

  it("greys the vehicles of an allowed type off the road that day, never the trip's own vehicle nor another type", () => {
    const groups = groupPlaces(view({ fromVehicleId: "taxi-1", options: [option("vsl-1")] }), fleet, ["TAXI", "VSL"]);
    const manosque = groups.find((g) => g.depotLabel === "Manosque");
    expect(manosque?.options).toEqual([]);
    expect(manosque?.rejected).toEqual([
      { vehicleId: "vsl-2", kind: "UNAVAILABLE", reason: "est indisponible ce jour\u00a0: révision au garage", label: "VSL 2 (Manosque)" },
    ]);
    const listed = groups.flatMap((g) => [...g.options, ...g.rejected].map((v) => v.vehicleId));
    expect(listed).not.toContain("taxi-1");
    expect(listed).not.toContain("amb-1");
    // Off the road but of a type the prescription excludes: not listed.
    expect(groupPlaces(view(), fleet, ["TAXI"]).flatMap((g) => g.rejected.map((r) => r.vehicleId))).not.toContain("vsl-2");
  });

  it("orders the depots without any place by name, after those with one", () => {
    const groups = groupPlaces(
      view({
        rejected: [
          { vehicleId: "taxi-1", kind: "OCCUPIED", reason: "transporte un autre patient de 07:00 à 07:30" },
          { vehicleId: "taxi-9", kind: "SHIFT", reason: "ne peut pas l'assurer dans ses heures de service (13:00–19:00)" },
        ],
      }),
      fleet,
      ["TAXI", "VSL"],
    );
    expect(groups.map((g) => g.depotLabel)).toEqual(["Aix-en-Provence", "Manosque", "Marseille"]);
  });
});

describe("unavailableReason", () => {
  it("follows the vehicle's name, the reason in lower case after the colon unless an acronym", () => {
    expect(unavailableReason({ unavailableReason: "Aucun chauffeur disponible" })).toBe("est indisponible ce jour\u00a0: aucun chauffeur disponible");
    expect(unavailableReason({ unavailableReason: "VSL en révision" })).toBe("est indisponible ce jour\u00a0: VSL en révision");
    expect(unavailableReason({ unavailableReason: null })).toBe("est indisponible ce jour\u00a0: véhicule hors service");
  });
});

describe("place texts", () => {
  it("says the margin, km, duration and times of a place with French spacing and signs", () => {
    expect(marginText(18.4)).toBe("marge\u00a0+18\u00a0€");
    expect(marginText(-12.6)).toMatch(/^marge\u00a0[\u2212-]13\u00a0€$/);
    expect(marginText(0.3)).toBe("marge inchangée");
    expect(signedKmText(6.24)).toBe("+6,2\u00a0km");
    expect(signedKmText(-3)).toMatch(/^[\u2212-]3,0\u00a0km$/);
    expect(signedKmText(0.01)).toBe("0\u00a0km");
    expect(signedDurationText(25)).toBe("+25\u00a0min");
    expect(signedDurationText(-65)).toBe("\u22121\u00a0h\u00a005");
    expect(placeTimesText(option("x"))).toBe("prise en charge 09:12 · dépose 09:40");
    expect(placeFiguresText(option("x"))).toBe("+6,2\u00a0km dont +2,1\u00a0km à vide · +25\u00a0min de service · CA\u00a0+30\u00a0€");
    expect(placeFiguresText(option("x", { deltaEmptyKm: 0, deltaRevenue: 0.2 }))).toBe("+6,2\u00a0km · +25\u00a0min de service · CA inchangé");
  });

  it("names the co-passengers and the patients delayed, without agreeing a participle with them", () => {
    const names: Record<string, string> = { "trip-a": "Monique Aubert", "trip-b": "Gérard Blanc" };
    const nameOf = (id: string) => names[id] ?? null;
    expect(sharedText([], nameOf)).toBeNull();
    expect(sharedText(["trip-a"], nameOf)).toBe("Partagée avec Monique Aubert");
    expect(sharedText(["trip-a", "trip-b", "trip-x"], nameOf)).toBe("Partagée avec Monique Aubert, Gérard Blanc et un patient");
    expect(shiftsText([], nameOf)).toBeNull();
    expect(shiftsText([{ tripId: "trip-a", minutes: 8 }], nameOf)).toBe("Décale Monique Aubert de +8\u00a0min");
    expect(shiftsText([{ tripId: "trip-a", minutes: 3 }, { tripId: "trip-b", minutes: -12 }], nameOf)).toMatch(
      /^Décale 2 patients \(jusqu'à [\u2212-]12\u00a0min\)$/,
    );
  });

  it("sums up the answer", () => {
    expect(placesSummary(view())).toBe("Aucun autre véhicule compatible ce jour");
    expect(placesSummary(view({ rejected: [{ vehicleId: "a", kind: "SHIFT", reason: "" }] }))).toBe("Aucune place sur 1 véhicule compatible");
    expect(placesSummary(view({ options: [option("a")], rejected: [{ vehicleId: "b", kind: "SHIFT", reason: "" }] }))).toBe(
      "1 place possible sur 2 véhicules compatibles",
    );
    expect(placesSummary(view({ options: [option("a"), option("b")] }))).toBe("2 places possibles sur 2 véhicules compatibles");
  });
});
