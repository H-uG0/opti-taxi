import { describe, expect, it } from "vitest";
import { isFiltered, matchesDriverFilter, parseDriverFilter, type FilterableDriver } from "./list-filter";

const ANA: FilterableDriver = {
  firstName: "Anaïs",
  lastName: "Bérard",
  email: "anais.berard@opti-taxi.test",
  phone: "06 12 34 56 78",
  depotId: "gap",
  qualifications: ["TAXI_CARD"],
  active: true,
  breakToFix: false,
  multiSeat: false,
  hasActiveAccount: true,
  tomorrow: { kind: "vehicle", vehicleId: "v1", seat: "driver", replacement: false },
};
const DEA: FilterableDriver = {
  ...ANA,
  firstName: "Marc",
  lastName: "Dupuis",
  email: null,
  phone: null,
  depotId: null,
  qualifications: ["AUXILIARY", "DEA"],
  breakToFix: true,
  hasActiveAccount: false,
  tomorrow: { kind: "absent", text: "Garde le 11/11/2026", label: "Garde", endDate: "2026-11-11" },
};
const GONE: FilterableDriver = { ...ANA, firstName: "Léa", active: false, tomorrow: null };

const pick = (query: string) => {
  const filter = parseDriverFilter(Object.fromEntries(new URLSearchParams(query)));
  return [ANA, DEA, GONE].filter((d) => matchesDriverFilter(d, filter)).map((d) => d.firstName);
};

describe("Chauffeurs filters", () => {
  it("shows active people by default", () => {
    expect(pick("")).toEqual(["Anaïs", "Marc"]);
    expect(pick("statut=inactifs")).toEqual(["Léa"]);
    expect(pick("inactifs=1")).toHaveLength(3);
    expect(isFiltered(parseDriverFilter({}))).toBe(false);
  });

  it("searches the name and the e-mail without accents, a phone number by its digits", () => {
    expect(pick("q=berard")).toEqual(["Anaïs"]);
    expect(pick("q=anais.berard")).toEqual(["Anaïs"]);
    expect(pick("q=06 12 34")).toEqual(["Anaïs"]);
    expect(pick("q=+33 6 12 34 56 78")).toEqual(["Anaïs"]);
    expect(pick("q=0699")).toEqual([]);
  });

  it("filters by depot (or none), qualification, alerts and tomorrow", () => {
    expect(pick("depot=gap")).toEqual(["Anaïs"]);
    expect(pick("depot=aucun")).toEqual(["Marc"]);
    expect(pick("qualification=DEA")).toEqual(["Marc"]);
    expect(pick("alerte=pause")).toEqual(["Marc"]);
    expect(pick("alerte=sans-compte")).toEqual(["Marc"]);
    expect(pick("alerte=toutes")).toEqual(["Marc"]);
    expect(pick("demain=absent")).toEqual(["Marc"]);
    expect(pick("demain=en-poste")).toEqual(["Anaïs"]);
    expect(pick("demain=libre")).toEqual([]);
  });
});
