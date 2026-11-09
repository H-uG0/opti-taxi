import { describe, expect, it } from "vitest";
import type { Qualification } from "@prisma/client";
import {
  absenceOn,
  absenceText,
  planningAbsenceText,
  resolveDayCrews,
  type CrewVehicle,
  type DatedAbsence,
  type DayCrewInput,
  type StaffPerson,
} from "./day-crews";

const MONDAY = "2026-11-09";
const SATURDAY = "2026-11-14";
const MON_FRI = [1, 2, 3, 4, 5];

function person(id: string, qualifications: Qualification[], depotId: string | null = "dep_a", workDays = MON_FRI): StaffPerson {
  return { id, firstName: id, lastName: id.toUpperCase(), active: true, workDays, qualifications, depotId };
}

function vehicle(id: string, type: CrewVehicle["type"], driver: string | null, mate: string | null = null, depotId = "dep_a"): CrewVehicle {
  return { id, label: id, type, active: true, depotId, defaultDriverId: driver, defaultCrewMateId: mate };
}

const PEOPLE = [
  person("taxi1", ["TAXI_CARD"]),
  person("taxi2", ["TAXI_CARD"]),
  person("spare_a", ["TAXI_CARD", "AUXILIARY"]),
  person("spare_b", ["TAXI_CARD"], "dep_b"),
  person("dea1", ["DEA"]),
  person("aux1", ["AUXILIARY"]),
  person("aux2", ["AUXILIARY"]),
];
const VEHICLES = [vehicle("Taxi A", "TAXI", "taxi1"), vehicle("Taxi B", "TAXI", "taxi2"), vehicle("Amb", "AMBULANCE", "dea1", "aux1")];

function plan(overrides: Partial<DayCrewInput> = {}) {
  return resolveDayCrews({
    date: MONDAY,
    vehicles: VEHICLES,
    people: PEOPLE,
    absences: [],
    incompatibilities: [],
    saved: [],
    ...overrides,
  });
}

function crewOf(result: ReturnType<typeof plan>, vehicleId: string) {
  const crew = result.crews.find((c) => c.vehicleId === vehicleId);
  if (!crew) throw new Error(`no crew for ${vehicleId}`);
  return crew;
}

const leave = (driverId: string, startDate = MONDAY, endDate = MONDAY): DatedAbsence => ({ driverId, kind: "LEAVE", startDate, endDate });

describe("resolveDayCrews", () => {
  it("keeps the default crews when everyone is available", () => {
    const result = plan();
    expect(result.crews.map((c) => [c.vehicleId, c.driverId, c.crewMateId, c.source, c.blocked])).toEqual([
      ["Taxi A", "taxi1", null, "default", null],
      ["Taxi B", "taxi2", null, "default", null],
      ["Amb", "dea1", "aux1", "default", null],
    ]);
    expect(result.idle).toEqual(["aux2", "spare_a", "spare_b"]);
  });

  it("replaces an absent driver, from the vehicle's depot first", () => {
    const result = plan({ absences: [leave("taxi1", "2026-11-09", "2026-11-13")] });
    const crew = crewOf(result, "Taxi A");
    expect(crew).toMatchObject({ driverId: "spare_a", source: "replacement", blocked: null });
    expect(crew.issues.map((i) => i.message)).toEqual([
      "Chauffeur attitré indisponible (taxi1 TAXI1 : absence du 09/11/2026 au 13/11/2026)",
      "Chauffeur remplaçant proposé : spare_a SPARE_A",
    ]);
    expect(result.absent).toEqual([
      { driverId: "taxi1", startDate: "2026-11-09", endDate: "2026-11-13", text: "Absence du 09/11/2026 au 13/11/2026" },
    ]);
  });

  it("serves a vehicle missing its default driver before a spare vehicle", () => {
    // "Spare" has no default driver and comes first in display order: it still waits.
    const spare = vehicle("A spare", "TAXI", null);
    const result = plan({
      vehicles: [spare, ...VEHICLES],
      people: PEOPLE.filter((p) => p.id !== "spare_b"),
      absences: [leave("taxi1")],
    });
    expect(crewOf(result, "Taxi A").driverId).toBe("spare_a");
    expect(crewOf(result, "A spare")).toMatchObject({ driverId: null, blocked: "Aucun chauffeur disponible" });
  });

  it("staffs a spare vehicle with a person left without a seat", () => {
    const result = plan({ vehicles: [vehicle("A spare", "TAXI", null), ...VEHICLES] });
    expect(crewOf(result, "A spare")).toMatchObject({ driverId: "spare_a", source: "replacement", blocked: null });
  });

  it("gives nobody to an unavailable vehicle, and its default driver replaces elsewhere", () => {
    const result = plan({
      absences: [leave("taxi2")],
      saved: [{ vehicleId: "Taxi A", driverId: "taxi1", crewMateId: null }],
      vehicleUnavailabilities: [{ vehicleId: "Taxi A", kind: "MAINTENANCE", startDate: "2026-11-09", endDate: "2026-11-10" }],
    });
    expect(crewOf(result, "Taxi A")).toMatchObject({
      driverId: null,
      unavailable: true,
      blocked: "Véhicule indisponible (entretien du 09/11/2026 au 10/11/2026)",
    });
    // The crew fixed on Taxi A reserves nobody: taxi1 is free again. Taxi B takes the first
    // qualified person of its depot by name (spare_a), taxi1 is left idle.
    expect(crewOf(result, "Taxi B")).toMatchObject({ driverId: "spare_a", source: "replacement", blocked: null });
    expect(result.idle).toContain("taxi1");
  });

  it("takes someone from another depot when its own has nobody, and says so", () => {
    const result = plan({ absences: [leave("taxi1"), leave("spare_a")] });
    const crew = crewOf(result, "Taxi A");
    expect(crew.driverId).toBe("spare_b");
    expect(crew.issues.at(-1)?.message).toBe("Chauffeur remplaçant proposé : spare_b SPARE_B (autre dépôt)");
  });

  it("leaves the vehicle out when nobody qualified is available", () => {
    const result = plan({ absences: [leave("taxi1"), leave("spare_a"), leave("spare_b")] });
    expect(crewOf(result, "Taxi A")).toMatchObject({ driverId: null, source: "none", blocked: "Aucun chauffeur disponible" });
  });

  it("only proposes qualified people: an auxiliary does not drive a taxi", () => {
    const result = plan({ people: PEOPLE.filter((p) => !p.id.startsWith("spare")), absences: [leave("taxi1")] });
    expect(crewOf(result, "Taxi A").blocked).toBe("Aucun chauffeur disponible");
  });

  it("does not propose a person on a day they do not work", () => {
    const result = plan({ date: SATURDAY });
    expect(crewOf(result, "Taxi A")).toMatchObject({ driverId: null, blocked: "Aucun chauffeur disponible" });
    expect(crewOf(result, "Taxi A").issues[0]?.message).toBe("Chauffeur attitré indisponible (taxi1 TAXI1 : ne travaille pas le samedi)");
  });

  it("accepts weekend duty fixed by the regulator, noted only", () => {
    const result = plan({ date: SATURDAY, saved: [{ vehicleId: "Taxi A", driverId: "taxi1", crewMateId: null }] });
    const crew = crewOf(result, "Taxi A");
    expect(crew).toMatchObject({ driverId: "taxi1", source: "saved", blocked: null });
    expect(crew.issues).toEqual([
      { level: "info", seat: "driver", message: "taxi1 TAXI1 ne travaille pas habituellement le samedi : affectation exceptionnelle" },
    ]);
  });

  it("blocks a fixed crew whose member is absent or unqualified", () => {
    const absent = plan({ absences: [{ ...leave("taxi1"), kind: "SICK" }], saved: [{ vehicleId: "Taxi A", driverId: "taxi1", crewMateId: null }] });
    expect(crewOf(absent, "Taxi A").blocked).toBe("taxi1 TAXI1 : absence le 09/11/2026");
    const onCall = plan({ absences: [{ ...leave("taxi1"), kind: "ON_CALL" }], saved: [{ vehicleId: "Taxi A", driverId: "taxi1", crewMateId: null }] });
    expect(crewOf(onCall, "Taxi A").blocked).toBe("taxi1 TAXI1 : garde le 09/11/2026");
    const unqualified = plan({ saved: [{ vehicleId: "Taxi A", driverId: "aux2", crewMateId: null }] });
    expect(crewOf(unqualified, "Taxi A").blocked).toBe("aux2 AUX2 n'a pas la qualification requise pour ce poste");
  });

  it("refuses an incompatible pair fixed by the regulator", () => {
    const result = plan({
      incompatibilities: [{ driverAId: "aux1", driverBId: "dea1" }],
      saved: [{ vehicleId: "Amb", driverId: "dea1", crewMateId: "aux1" }],
    });
    expect(crewOf(result, "Amb").blocked).toBe("dea1 DEA1 et aux1 AUX1 ne doivent pas travailler ensemble");
  });

  it("replaces a default crew mate incompatible with the driver", () => {
    const result = plan({ incompatibilities: [{ driverAId: "aux1", driverBId: "dea1" }] });
    const crew = crewOf(result, "Amb");
    expect(crew).toMatchObject({ driverId: "dea1", crewMateId: "aux2", source: "replacement", blocked: null });
    expect(crew.issues[0]?.message).toBe("Équipier attitré indisponible (aux1 AUX1 : incompatible avec le chauffeur)");
  });

  it("reports a person fixed on two vehicles: the first in display order keeps them", () => {
    const result = plan({
      saved: [
        { vehicleId: "Taxi B", driverId: "taxi1", crewMateId: null },
        { vehicleId: "Taxi A", driverId: "taxi1", crewMateId: null },
      ],
    });
    expect(crewOf(result, "Taxi A").blocked).toBeNull();
    expect(crewOf(result, "Taxi B").blocked).toBe("taxi1 TAXI1 est déjà affecté à Taxi A ce jour");
    // taxi2 has no seat (Taxi B is fixed with taxi1): idle.
    expect(result.idle).toContain("taxi2");
  });

  it("keeps a vehicle at the depot when the regulator fixed no driver", () => {
    const result = plan({ saved: [{ vehicleId: "Taxi A", driverId: null, crewMateId: null }] });
    expect(crewOf(result, "Taxi A")).toMatchObject({ source: "saved", blocked: "Pas de chauffeur ce jour (choix du régulateur)" });
    expect(result.idle).toContain("taxi1");
  });

  it("ignores a crew mate saved on a taxi, and inactive vehicles", () => {
    const result = plan({
      vehicles: [...VEHICLES, { ...vehicle("Old", "TAXI", "spare_a"), active: false }],
      saved: [{ vehicleId: "Taxi A", driverId: "taxi1", crewMateId: "aux2" }],
    });
    expect(crewOf(result, "Taxi A").crewMateId).toBeNull();
    expect(result.crews.map((c) => c.vehicleId)).not.toContain("Old");
  });

  it("requires a second person on an ambulance", () => {
    const result = plan({ people: PEOPLE.filter((p) => !["aux1", "aux2", "spare_a"].includes(p.id)) });
    expect(crewOf(result, "Amb")).toMatchObject({ driverId: "dea1", crewMateId: null, blocked: "Aucun équipier disponible" });
  });
});

describe("absences", () => {
  it("covers both bounds and labels the kind on the person's sheet only", () => {
    const list = [leave("p", "2026-11-09", "2026-11-11")];
    expect(absenceOn("p", "2026-11-09", list)).not.toBeNull();
    expect(absenceOn("p", "2026-11-11", list)).not.toBeNull();
    expect(absenceOn("p", "2026-11-12", list)).toBeNull();
    expect(absenceText({ kind: "SICK", startDate: "2026-11-09", endDate: "2026-11-09" })).toBe("Arrêt maladie le 09/11/2026");
    expect(planningAbsenceText({ kind: "SICK", startDate: "2026-11-09", endDate: "2026-11-09" })).toBe("Absence le 09/11/2026");
    expect(planningAbsenceText({ kind: "LEAVE", startDate: "2026-11-09", endDate: "2026-11-11" })).toBe("Absence du 09/11/2026 au 11/11/2026");
    expect(planningAbsenceText({ kind: "OTHER", startDate: "2026-11-09", endDate: "2026-11-09" })).toBe("Absence le 09/11/2026");
    // Duties the regulator needs to know about keep their name.
    expect(planningAbsenceText({ kind: "ON_CALL", startDate: "2026-11-11", endDate: "2026-11-11" })).toBe("Garde le 11/11/2026");
    expect(planningAbsenceText({ kind: "TRAINING", startDate: "2026-11-12", endDate: "2026-11-13" })).toBe("Formation du 12/11/2026 au 13/11/2026");
  });

  it("never lets a private reason reach the planning (crews, problems, absent list)", () => {
    // Leave, sick leave and other reasons all read « absence »: none can be told from the others.
    for (const kind of ["SICK", "LEAVE", "OTHER"] as const) {
      const absence = { ...leave("taxi1"), kind };
      const proposed = plan({ absences: [absence] });
      const fixed = plan({ absences: [absence], saved: [{ vehicleId: "Taxi A", driverId: "taxi1", crewMateId: null }] });
      const shown = JSON.stringify([proposed, fixed]);
      expect(shown).not.toMatch(/maladie|congé|formation|garde|SICK|LEAVE|TRAINING|ON_CALL|OTHER|"kind"/i);
      expect(shown).toMatch(/absence le 09\/11\/2026/);
    }
  });

  it("names the duties the regulator needs: on-call duty and training", () => {
    const shown = JSON.stringify(plan({ absences: [{ ...leave("taxi1"), kind: "ON_CALL" }, { ...leave("taxi2"), kind: "TRAINING" }] }));
    expect(shown).toMatch(/garde le 09\/11\/2026/i);
    expect(shown).toMatch(/formation le 09\/11\/2026/i);
    expect(shown).not.toMatch(/ON_CALL|TRAINING|"kind"/);
  });
});
