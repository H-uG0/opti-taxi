import type { TariffAreaRule } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { fromIsoDate } from "@/lib/time";
import {
  areasInForce,
  communeOfAddress,
  normalizeCommune,
  parseCommuneList,
  tripAreaFlags,
  tripInArea,
  type AreaInput,
  type Commune,
} from "./tariff-areas";

function area(overrides: Partial<AreaInput> & { rule: TariffAreaRule }): AreaInput {
  return {
    kind: "AGGLOMERATION",
    name: "Zone",
    department: "13",
    communes: [],
    hubCommune: null,
    validFrom: null,
    validTo: null,
    ...overrides,
  };
}

const at = (city: string, postalCode: string | null = null): Commune => ({ city, postalCode });
const marseille = at("Marseille", "13005");
const allauch = at("Allauch", "13190");
const aix = at("Aix-en-Provence", "13100");
const avignon = at("Avignon", "84000");
const sorgues = at("Sorgues", "84700");
const lePontet = at("Le Pontet", "84130");

describe("communes", () => {
  it("normalizes accents, hyphens, saints and Marseille's arrondissements", () => {
    expect(normalizeCommune("Saint-Martin-d'Hères")).toBe(normalizeCommune("ST MARTIN D HERES"));
    expect(normalizeCommune("Marseille 5e Arrondissement")).toBe("marseille");
    expect(normalizeCommune("Marseille 1er")).toBe("marseille");
    expect(normalizeCommune("La Penne-sur-Huveaune")).toBe("la penne sur huveaune");
  });

  it("reads the commune of an address snapshot", () => {
    expect(communeOfAddress("12 rue des Lilas, 13012 Marseille")).toEqual({ postalCode: "13012", city: "Marseille" });
    expect(communeOfAddress("Centre hospitalier, 2 avenue X, 04100 Manosque")).toEqual({ postalCode: "04100", city: "Manosque" });
    expect(communeOfAddress("Lieu-dit sans code postal")).toBeNull();
  });

  it("parses a list of communes, without duplicates", () => {
    expect(parseCommuneList("Marseille\nAllauch, Plan-de-Cuques ; marseille\n\n")).toEqual(["Marseille", "Allauch", "Plan-de-Cuques"]);
  });
});

describe("trip rules", () => {
  const bigCity = area({ kind: "BIG_CITY", rule: "ANY_END", communes: ["Marseille"] });
  const marseilleAgglo = area({ rule: "BOTH_INSIDE", communes: ["Marseille", "Allauch", "Plan-de-Cuques"] });
  const avignonAgglo = area({ rule: "TO_HUB", department: "84", communes: ["Sorgues", "Le Pontet"], hubCommune: "Avignon" });

  it("ANY_END: picked up or dropped in the area", () => {
    expect(tripInArea(bigCity, aix, marseille)).toBe(true);
    expect(tripInArea(bigCity, marseille, aix)).toBe(true);
    expect(tripInArea(bigCity, aix, aix)).toBe(false);
  });

  it("BOTH_INSIDE: both ends in the area", () => {
    expect(tripInArea(marseilleAgglo, allauch, marseille)).toBe(true);
    expect(tripInArea(marseilleAgglo, aix, marseille)).toBe(false);
  });

  it("TO_HUB: between a commune of the area and the centre, both ways", () => {
    expect(tripInArea(avignonAgglo, sorgues, avignon)).toBe(true);
    expect(tripInArea(avignonAgglo, avignon, lePontet)).toBe(true);
    expect(tripInArea(avignonAgglo, sorgues, lePontet)).toBe(false);
  });

  it("reads the department written after a commune of another department", () => {
    const withGard = area({ rule: "TO_HUB", department: "84", communes: ["Les Angles (30)"], hubCommune: "Avignon" });
    expect(tripInArea(withGard, at("Les Angles", "30133"), avignon)).toBe(true);
    expect(tripInArea(withGard, at("Les Angles", "84000"), avignon)).toBe(false);
  });

  it("checks the department of the postal code when there is one", () => {
    expect(tripInArea(bigCity, at("Marseille", "75001"), aix)).toBe(false);
    expect(tripInArea(bigCity, at("Marseille"), aix)).toBe(true);
  });

  it("agglomeration fare only for a company based in the agglomeration", () => {
    const areas = [bigCity, marseilleAgglo];
    expect(tripAreaFlags(areas, allauch, marseille, marseille)).toEqual({ bigCity: true, agglomeration: true });
    expect(tripAreaFlags(areas, allauch, marseille, at("Manosque", "04100"))).toEqual({ bigCity: true, agglomeration: false });
    expect(tripAreaFlags(areas, allauch, marseille, null)).toEqual({ bigCity: true, agglomeration: false });
    expect(tripAreaFlags(areas, aix, aix, marseille)).toEqual({ bigCity: false, agglomeration: false });
  });

  it("keeps the areas valid on the date", () => {
    const later = area({ rule: "ANY_END", validFrom: fromIsoDate("2026-04-01") });
    const ended = area({ rule: "ANY_END", validTo: fromIsoDate("2025-12-31") });
    expect(areasInForce([later, ended, bigCity], "2026-03-31")).toEqual([bigCity]);
    expect(areasInForce([later, ended, bigCity], "2026-04-01")).toEqual([later, bigCity]);
  });
});
