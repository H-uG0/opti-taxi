import { describe, expect, it } from "vitest";
import { isFiltered, matchesVehicleFilter, parseVehicleFilter, type FilterableVehicle } from "./list-filter";

const TAXI: FilterableVehicle = {
  label: "Taxi 12 (Gap)",
  registration: "AB-123-CD",
  type: "TAXI",
  energy: "ELECTRIC",
  depotId: "gap",
  active: true,
  crewNames: ["Hélène Martin"],
  overdueDeadlines: 0,
  soonDeadlines: 1,
  crewProblem: false,
  tomorrow: { kind: "crew", driver: "Hélène Martin", crewMate: null, source: "default" },
};

const AMBULANCE: FilterableVehicle = {
  ...TAXI,
  label: "Ambulance 3 (Aix)",
  registration: "ZZ-999-ZZ",
  type: "AMBULANCE",
  energy: null,
  depotId: "aix",
  crewNames: [],
  soonDeadlines: 0,
  overdueDeadlines: 1,
  crewProblem: true,
  tomorrow: { kind: "off", text: "Garde le 11/11/2026" },
};

const OLD: FilterableVehicle = { ...TAXI, label: "Taxi 1", active: false, tomorrow: null };

const pick = (query: string) => {
  const filter = parseVehicleFilter(Object.fromEntries(new URLSearchParams(query)));
  return [TAXI, AMBULANCE, OLD].filter((v) => matchesVehicleFilter(v, filter)).map((v) => v.label);
};

describe("Véhicules filters", () => {
  it("shows the active vehicles by default, the others on demand", () => {
    expect(pick("")).toEqual(["Taxi 12 (Gap)", "Ambulance 3 (Aix)"]);
    expect(pick("statut=inactifs")).toEqual(["Taxi 1"]);
    expect(pick("statut=tous")).toHaveLength(3);
    // The old « Afficher les désactivés » link.
    expect(pick("inactifs=1")).toHaveLength(3);
    expect(isFiltered(parseVehicleFilter({}))).toBe(false);
    expect(isFiltered(parseVehicleFilter({ statut: "actifs" }))).toBe(false);
  });

  it("searches the label, the registration with or without dashes and the crew, without accents", () => {
    expect(pick("q=taxi 12")).toEqual(["Taxi 12 (Gap)"]);
    expect(pick("q=ab123")).toEqual(["Taxi 12 (Gap)"]);
    expect(pick("q=helene")).toEqual(["Taxi 12 (Gap)"]);
    expect(pick("q=nobody")).toEqual([]);
  });

  it("filters by depot, type and energy (or none filled in)", () => {
    expect(pick("depot=aix")).toEqual(["Ambulance 3 (Aix)"]);
    expect(pick("type=TAXI")).toEqual(["Taxi 12 (Gap)"]);
    expect(pick("energie=ELECTRIC")).toEqual(["Taxi 12 (Gap)"]);
    expect(pick("energie=none")).toEqual(["Ambulance 3 (Aix)"]);
    expect(pick("type=BUS")).toHaveLength(2);
  });

  it("filters on the alerts and on tomorrow", () => {
    expect(pick("alerte=echeance-depassee")).toEqual(["Ambulance 3 (Aix)"]);
    expect(pick("alerte=echeance")).toEqual(["Taxi 12 (Gap)", "Ambulance 3 (Aix)"]);
    expect(pick("alerte=equipage")).toEqual(["Ambulance 3 (Aix)"]);
    expect(pick("demain=indisponible")).toEqual(["Ambulance 3 (Aix)"]);
    expect(pick("demain=en-service")).toEqual(["Taxi 12 (Gap)"]);
    expect(pick("demain=sans-equipage")).toEqual([]);
  });
});
