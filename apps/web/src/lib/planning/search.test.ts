import { describe, expect, it } from "vitest";
import { planningFixture, tripView } from "@/test/planning-fixtures";
import { matchScore, normalizeText, searchPlanning } from "./search";

const { trips, vehicles } = planningFixture();
const list = Object.values(trips);

describe("normalizeText and matchScore", () => {
  it("ignores case, accents and punctuation", () => {
    expect(normalizeText("  Élodie FABRE-Héraud ")).toBe("elodie fabre heraud");
    expect(normalizeText("VSL 1 (Marseille)")).toBe("vsl 1 marseille");
  });

  it("ranks a prefix above word starts above a match inside a word, and needs every word", () => {
    expect(matchScore("monique aubert", "mon")).toBe(3);
    expect(matchScore("monique aubert", "aub")).toBe(2);
    expect(matchScore("monique aubert", "aubert mon")).toBe(2);
    expect(matchScore("monique aubert", "niq")).toBe(1);
    expect(matchScore("monique aubert", "aubert gerard")).toBe(0);
    expect(matchScore("monique aubert", "")).toBe(0);
  });
});

describe("searchPlanning", () => {
  it("finds a patient's trips, without accents, with the leg, the time and the vehicle", () => {
    const results = searchPlanning("gerard", list, vehicles);
    expect(results).toEqual([
      {
        kind: "trip",
        id: "trip-b",
        title: "Gérard Blanc",
        detail: "Aller, RDV 07:30 · Taxi 1 (Marseille) · Centre de dialyse des Oliviers (fictif)",
        vehicleId: "taxi-1",
      },
    ]);
    expect(searchPlanning("imbert", list, vehicles)[0]).toMatchObject({ id: "trip-c", detail: expect.stringContaining("Non affectée") });
  });

  it("finds a vehicle by its label, registration, driver, crew mate or depot", () => {
    expect(searchPlanning("vsl 1", list, vehicles).map((r) => r.id)).toEqual(["vsl-1"]);
    expect(searchPlanning("GH-218", list, vehicles).map((r) => r.id)).toEqual(["taxi-1", "vsl-1", "amb-1", "vsl-2"]);
    expect(searchPlanning("giraud", list, vehicles)).toEqual([
      expect.objectContaining({ kind: "vehicle", id: "amb-1", detail: "Julien Marchetti + Laurent Giraud · dépôt Marseille · libre" }),
    ]);
    expect(searchPlanning("manosque", list, vehicles).map((r) => r.id)).toEqual(["vsl-2"]);
    expect(searchPlanning("élodie", list, vehicles)[0]).toMatchObject({ kind: "vehicle", id: "vsl-1" });
  });

  it("lists every trip of a facility in time order, after the patients whose name matches better", () => {
    const early = tripView({ id: "t-early", patientName: "Zoé Dialyse", plannedPickupMinute: 300 });
    const results = searchPlanning("dialyse", [...list, early], vehicles);
    expect(results[0]?.id).toBe("t-early"); // the patient's own name starts with « dialyse »
    expect(results.slice(1).map((r) => r.id)).toEqual(["trip-a", "trip-b", "trip-c"]);
  });

  it("needs two characters, and stops at the limit", () => {
    expect(searchPlanning("m", list, vehicles)).toEqual([]);
    expect(searchPlanning("ma", list, vehicles, 2)).toHaveLength(2);
  });

  it("says when a trip is cancelled or its patient absent", () => {
    const cancelled = tripView({ id: "t-x", patientName: "Paul Durand", status: "CANCELLED" });
    expect(searchPlanning("durand", [cancelled], vehicles)[0]?.detail).toMatch(/· annulée$/);
  });
});
