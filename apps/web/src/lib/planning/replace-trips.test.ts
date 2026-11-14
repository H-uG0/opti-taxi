import { describe, expect, it } from "vitest";
import { replaceSummary } from "./replace-trips";

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
