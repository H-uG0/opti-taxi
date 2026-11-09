import { describe, expect, it } from "vitest";
import type { Qualification } from "@prisma/client";
import { resolveDayCrews, type CrewVehicle, type DayCrewInput, type StaffPerson } from "@/lib/staff/day-crews";
import { vehicleIssues, type RouteCrewRow, type VehicleIssuesInput } from "./route-issues";

const MONDAY = "2026-11-09";
const MON_FRI = [1, 2, 3, 4, 5];

function person(id: string, qualifications: Qualification[]): StaffPerson {
  return {
    id,
    firstName: id,
    lastName: "X",
    active: true,
    workDays: MON_FRI,
    qualifications,
    depotId: "dep_a",
    shiftStartMinute: 360,
    shiftEndMinute: 1140,
  };
}

function vehicle(id: string, type: CrewVehicle["type"], driver: string | null, mate: string | null = null): CrewVehicle {
  return { id, label: `Véhicule ${id}`, type, active: true, depotId: "dep_a", defaultDriverId: driver, defaultCrewMateId: mate };
}

const PEOPLE = [
  person("taxi1", ["TAXI_CARD"]),
  person("taxi2", ["TAXI_CARD"]),
  person("dea1", ["DEA"]),
  person("aux1", ["AUXILIARY"]),
];
const VEHICLES = [vehicle("A", "TAXI", "taxi1"), vehicle("B", "TAXI", "taxi2"), vehicle("Amb", "AMBULANCE", "dea1", "aux1")];

/** The routes as computed in the morning, with the default crews. */
const ROUTES: RouteCrewRow[] = [
  { vehicleId: "A", driverId: "taxi1", crewMateId: null },
  { vehicleId: "Amb", driverId: "dea1", crewMateId: "aux1" },
];

function issuesAfter(changes: Partial<DayCrewInput> = {}, overrides: Partial<VehicleIssuesInput> = {}) {
  const crewInput: DayCrewInput = {
    date: MONDAY,
    vehicles: VEHICLES,
    people: PEOPLE,
    absences: [],
    incompatibilities: [],
    saved: [],
    ...changes,
  };
  return vehicleIssues({
    date: MONDAY,
    routes: ROUTES,
    vehicles: VEHICLES,
    plan: resolveDayCrews(crewInput),
    absences: crewInput.absences,
    people: new Map(crewInput.people.map((p) => [p.id, p])),
    fleetAlerts: new Map(),
    ...overrides,
  });
}

describe("vehicleIssues", () => {
  it("is empty when the routes still match the crews of the day", () => {
    expect(issuesAfter()).toEqual([]);
  });

  it("flags a route whose vehicle was made unavailable after the computation", () => {
    const issues = issuesAfter({
      vehicleUnavailabilities: [{ vehicleId: "A", kind: "MAINTENANCE", startDate: MONDAY, endDate: "2026-11-10" }],
    });
    expect(issues).toEqual([
      {
        vehicleId: "A",
        label: "Véhicule A",
        hasRoute: true,
        changes: ["Véhicule indisponible (entretien du 09/11/2026 au 10/11/2026)"],
        compliance: [],
      },
    ]);
  });

  it("names who replaces an absent driver in the crew of the day", () => {
    const people = [...PEOPLE, person("spare", ["TAXI_CARD"])];
    const [issue] = issuesAfter({ people, absences: [{ driverId: "taxi1", kind: "LEAVE", startDate: MONDAY, endDate: MONDAY }] });
    expect(issue?.changes).toEqual(["taxi1 X (chauffeur) : absence le 09/11/2026 ; équipage du jour : spare X"]);
  });

  it("flags a route whose driver is now absent, without saying why", () => {
    const [issue] = issuesAfter({ absences: [{ driverId: "taxi1", kind: "SICK", startDate: MONDAY, endDate: MONDAY }] });
    // The day crew found nobody else: the vehicle is blocked, and the route's driver is absent.
    expect(issue?.vehicleId).toBe("A");
    expect(issue?.changes).toContain("taxi1 X (chauffeur) : absence le 09/11/2026");
    expect(issue?.changes.join(" ")).not.toMatch(/maladie/i);
  });

  it("flags a crew of the day that can no longer work, in a few words for the work-time rule", () => {
    const breakless = { breakWindowStartMinute: null, breakWindowEndMinute: null, breakMinutes: 0 };
    const [issue] = issuesAfter({ people: PEOPLE.map((p) => (p.id === "taxi1" ? { ...p, ...breakless } : p)) });
    expect(issue?.changes).toEqual(["Pause de 20 min requise : horaire de 13 h 00 sans pause (art. L. 3121-16)"]);
    const blocked = issuesAfter({ saved: [{ vehicleId: "A", driverId: "dea1", crewMateId: null }] }).find((i) => i.vehicleId === "A");
    expect(blocked?.changes).toContain("Équipage du jour bloqué : dea1 X n'a pas la qualification requise pour ce poste");
  });

  it("flags a crew changed on the crew screen after the computation", () => {
    const [issue] = issuesAfter({ saved: [{ vehicleId: "A", driverId: "taxi2", crewMateId: null }] });
    expect(issue?.changes).toEqual(["Chauffeur changé : taxi1 X sur la tournée, taxi2 X dans l'équipage du jour"]);
  });

  it("checks the crew mate of an ambulance", () => {
    const [issue] = issuesAfter({ people: PEOPLE.map((p) => (p.id === "aux1" ? { ...p, active: false } : p)) });
    expect(issue?.vehicleId).toBe("Amb");
    expect(issue?.changes).toContain("aux1 X (équipier) : désactivé depuis le calcul");
  });

  it("flags a route on a vehicle deactivated since", () => {
    const issues = issuesAfter({ vehicles: VEHICLES.map((v) => (v.id === "A" ? { ...v, active: false } : v)) });
    expect(issues).toEqual([
      { vehicleId: "A", label: "Véhicule A", hasRoute: true, changes: ["Véhicule désactivé depuis le calcul"], compliance: [] },
    ]);
  });

  it("reports an overdue inspection or insurance on every vehicle that drives that day", () => {
    const alert = "Contrôle technique : échéance dépassée (01/11/2026)";
    const issues = issuesAfter({}, { fleetAlerts: new Map([["B", [alert]], ["A", [alert]]]) });
    expect(issues.map((i) => [i.vehicleId, i.hasRoute, i.changes, i.compliance])).toEqual([
      ["A", true, [], [alert]],
      ["B", false, [], [alert]],
    ]);
  });
});
