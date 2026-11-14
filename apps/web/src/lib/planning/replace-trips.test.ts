import { describe, expect, it } from "vitest";
import { chosenPlace, noPlaceReason, replaceSummary } from "./replace-trips";

describe("replaceSummary (« Replacer les courses », DAY-03)", () => {
  it("lists the trips placed with their vehicle and pickup, and those left with why", () => {
    const summary = replaceSummary(
      [
        { patient: "MARTIN Jeanne", placed: true, vehicleId: "v4", pickupMinute: 700 },
        { patient: "DUPONT Paul", placed: false, reason: "Aucune place (Taxi 2 transporte d'autres patients)." },
      ],
      new Map([["v4", "Taxi 4"]]),
    );
    expect(summary).toEqual({
      text:
        "1 course replacée (MARTIN Jeanne sur Taxi 4 à 11:40). 1 course non replacée\u00a0: DUPONT Paul, aucune place (Taxi 2 transporte d'autres patients)" +
        ". Elle reste dans «\u202fÀ placer\u202f».",
      left: 1,
    });
    expect(replaceSummary([], new Map()).text).toBe("Aucune course à replacer\u00a0: elles ont déjà un véhicule.");
  });
});

describe("noPlaceReason and chosenPlace (« Replacer »)", () => {
  const labels = new Map([
    ["vsl37", "VSL 37 (Grenoble)"],
    ["taxi2", "Taxi 2 (Gap)"],
  ]);

  it("says the most frequent refusal through one vehicle named, and how many others share it", () => {
    const rejected = [
      { vehicleId: "taxi2", kind: "SHIFT", reason: "ne peut pas l'assurer dans ses heures de service (11:10–18:30)" },
      { vehicleId: "vsl37", kind: "WINDOW", reason: "la prendrait en charge à 11:30, plus de 15 min après la fin de séance." },
      { vehicleId: "vsl38", kind: "WINDOW", reason: "la prendrait en charge à 11:35, plus de 15 min après la fin de séance." },
      { vehicleId: "vsl40", kind: "WINDOW", reason: "la prendrait en charge à 11:40, plus de 15 min après la fin de séance." },
    ];
    expect(noPlaceReason(rejected, labels)).toBe(
      "aucune place\u00a0: VSL 37 (Grenoble) la prendrait en charge à 11:30, plus de 15 min après la fin de séance, de même que 2 autres véhicules",
    );
    expect(noPlaceReason(rejected.slice(0, 1), labels)).toBe("aucune place\u00a0: Taxi 2 (Gap) ne peut pas l'assurer dans ses heures de service (11:10–18:30)");
    expect(noPlaceReason([], labels)).toBe("aucun véhicule n'a de place");
  });

  it("takes the earliest pickup for a patient waiting by a vehicle, the best margin otherwise", () => {
    const options = [{ pickupMinute: 760 }, { pickupMinute: 700 }, { pickupMinute: 730 }];
    expect(chosenPlace(options, false)).toEqual({ pickupMinute: 760 });
    expect(chosenPlace(options, true)).toEqual({ pickupMinute: 700 });
    expect(chosenPlace([], true)).toBeUndefined();
  });
});
