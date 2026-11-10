import { describe, expect, it } from "vitest";
import type { Qualification } from "@prisma/client";
import {
  absenceOn,
  absenceText,
  DEFAULT_CREW_RULES,
  planningAbsenceText,
  resolveDayCrews,
  type CrewVehicle,
  type DatedAbsence,
  type DayCrewInput,
  type StaffPerson,
  workTimeBlock,
} from "./day-crews";

const MONDAY = "2026-11-09";
const SATURDAY = "2026-11-14";
const MON_FRI = [1, 2, 3, 4, 5];

function person(
  id: string,
  qualifications: Qualification[],
  depotId: string | null = "dep_a",
  workDays = MON_FRI,
  shift: [number, number] = [360, 1140],
): StaffPerson {
  return {
    id,
    firstName: id,
    lastName: id.toUpperCase(),
    active: true,
    workDays,
    qualifications,
    depotId,
    shiftStartMinute: shift[0],
    shiftEndMinute: shift[1],
  };
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
      "Chauffeur attitré indisponible (TAXI1 taxi1\u00a0: absence du 09/11/2026 au 13/11/2026)",
      "Chauffeur remplaçant proposé\u00a0: SPARE_A spare_a",
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
    // The crew fixed on Taxi A reserves nobody: taxi1 is free again and replaces taxi2 on Taxi B
    // (same depot, taxi only), so spare_a, who can also drive a VSL or crew an ambulance, stays free.
    expect(crewOf(result, "Taxi B")).toMatchObject({ driverId: "taxi1", source: "replacement", blocked: null });
    expect(result.idle).toContain("spare_a");
  });

  it("takes someone from another depot when its own has nobody, and says so", () => {
    const result = plan({ absences: [leave("taxi1"), leave("spare_a")] });
    const crew = crewOf(result, "Taxi A");
    expect(crew.driverId).toBe("spare_b");
    expect(crew.issues.at(-1)?.message).toBe("Chauffeur remplaçant proposé\u00a0: SPARE_B spare_b (autre dépôt)");
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
    expect(crewOf(result, "Taxi A").issues[0]?.message).toBe("Chauffeur attitré indisponible (TAXI1 taxi1\u00a0: ne travaille pas le samedi)");
  });

  it("accepts weekend duty fixed by the regulator, noted only", () => {
    const result = plan({ date: SATURDAY, saved: [{ vehicleId: "Taxi A", driverId: "taxi1", crewMateId: null }] });
    const crew = crewOf(result, "Taxi A");
    expect(crew).toMatchObject({ driverId: "taxi1", source: "saved", blocked: null });
    expect(crew.issues).toEqual([
      { level: "info", seat: "driver", message: "TAXI1 taxi1 ne travaille pas habituellement le samedi\u00a0: affectation exceptionnelle" },
    ]);
  });

  it("proposes a replacement on a fixed crew whose member became unavailable", () => {
    const fixed = [{ vehicleId: "Taxi A", driverId: "taxi1", crewMateId: null }];
    const absent = plan({ absences: [{ ...leave("taxi1"), kind: "SICK" }], saved: fixed });
    expect(crewOf(absent, "Taxi A")).toMatchObject({ driverId: "spare_a", source: "saved", proposedSeats: ["driver"], blocked: null });
    expect(crewOf(absent, "Taxi A").issues.map((i) => i.message)).toEqual([
      "Chauffeur fixé indisponible (TAXI1 taxi1\u00a0: absence le 09/11/2026)",
      "Chauffeur remplaçant proposé\u00a0: SPARE_A spare_a",
    ]);
    const onCall = plan({ absences: [{ ...leave("taxi1"), kind: "ON_CALL" }], saved: fixed });
    expect(crewOf(onCall, "Taxi A").issues[0]?.message).toBe("Chauffeur fixé indisponible (TAXI1 taxi1\u00a0: garde le 09/11/2026)");
    const deactivated = plan({ people: PEOPLE.map((p) => (p.id === "taxi1" ? { ...p, active: false } : p)), saved: fixed });
    expect(crewOf(deactivated, "Taxi A").issues[0]?.message).toBe("Chauffeur fixé indisponible (TAXI1 taxi1\u00a0: désactivé)");
  });

  it("keeps the other member of a fixed ambulance crew and replaces the absent one", () => {
    const result = plan({ absences: [leave("aux1")], saved: [{ vehicleId: "Amb", driverId: "dea1", crewMateId: "aux1" }] });
    expect(crewOf(result, "Amb")).toMatchObject({ driverId: "dea1", crewMateId: "aux2", proposedSeats: ["crewMate"], blocked: null });
    // Nobody to replace: the vehicle stays blocked, the other member stays on it.
    const none = plan({
      people: PEOPLE.filter((p) => !["aux2", "spare_a"].includes(p.id)),
      absences: [leave("aux1")],
      saved: [{ vehicleId: "Amb", driverId: "dea1", crewMateId: "aux1" }],
    });
    expect(crewOf(none, "Amb")).toMatchObject({ driverId: "dea1", crewMateId: null, blocked: "Aucun équipier disponible" });
  });

  it("blocks a fixed crew whose member is unqualified", () => {
    const unqualified = plan({ saved: [{ vehicleId: "Taxi A", driverId: "aux2", crewMateId: null }] });
    expect(crewOf(unqualified, "Taxi A").blocked).toBe("AUX2 aux2 n'a pas la qualification requise pour ce poste");
  });

  it("refuses an incompatible pair fixed by the regulator", () => {
    const result = plan({
      incompatibilities: [{ driverAId: "aux1", driverBId: "dea1" }],
      saved: [{ vehicleId: "Amb", driverId: "dea1", crewMateId: "aux1" }],
    });
    expect(crewOf(result, "Amb").blocked).toBe("DEA1 dea1 et AUX1 aux1 ne doivent pas travailler ensemble");
  });

  it("replaces a default crew mate incompatible with the driver", () => {
    const result = plan({ incompatibilities: [{ driverAId: "aux1", driverBId: "dea1" }] });
    const crew = crewOf(result, "Amb");
    expect(crew).toMatchObject({ driverId: "dea1", crewMateId: "aux2", source: "replacement", blocked: null });
    expect(crew.issues[0]?.message).toBe("Équipier attitré indisponible (AUX1 aux1\u00a0: incompatible avec le chauffeur)");
  });

  it("reports a person fixed on two vehicles: the first in display order keeps them", () => {
    const result = plan({
      saved: [
        { vehicleId: "Taxi B", driverId: "taxi1", crewMateId: null },
        { vehicleId: "Taxi A", driverId: "taxi1", crewMateId: null },
      ],
    });
    expect(crewOf(result, "Taxi A").blocked).toBeNull();
    expect(crewOf(result, "Taxi B").blocked).toBe("TAXI1 taxi1 est déjà affecté à Taxi A ce jour");
    // taxi2 has no seat (Taxi B is fixed with taxi1): idle.
    expect(result.idle).toContain("taxi2");
  });

  it("keeps a vehicle at the depot when the regulator fixed no driver, unlike nobody available", () => {
    const result = plan({ saved: [{ vehicleId: "Taxi A", driverId: null, crewMateId: null }] });
    expect(crewOf(result, "Taxi A")).toMatchObject({ source: "saved", parked: true, blocked: "Laissé au dépôt ce jour (choix du régulateur)" });
    // A choice, not a problem: no error on the row.
    expect(crewOf(result, "Taxi A").issues).toEqual([{ level: "info", seat: "driver", message: "Laissé au dépôt ce jour (choix du régulateur)" }]);
    expect(result.idle).toContain("taxi1");
    const nobody = plan({ absences: [leave("taxi1"), leave("spare_a"), leave("spare_b")] });
    expect(crewOf(nobody, "Taxi A")).toMatchObject({ source: "none", parked: false, blocked: "Aucun chauffeur disponible" });
  });

  it("ignores a crew mate saved on a taxi, and inactive vehicles", () => {
    const result = plan({
      vehicles: [...VEHICLES, { ...vehicle("Old", "TAXI", "spare_a"), active: false }],
      saved: [{ vehicleId: "Taxi A", driverId: "taxi1", crewMateId: "aux2" }],
    });
    expect(crewOf(result, "Taxi A").crewMateId).toBeNull();
    expect(result.crews.map((c) => c.vehicleId)).not.toContain("Old");
  });

  it("accepts an auxiliary at the wheel with a DEA beside the patient (R. 6312-10)", () => {
    const result = plan({ vehicles: [vehicle("Amb", "AMBULANCE", "aux1", "dea1")] });
    expect(crewOf(result, "Amb")).toMatchObject({ driverId: "aux1", crewMateId: "dea1", source: "default", blocked: null });
    const fixed = plan({ saved: [{ vehicleId: "Amb", driverId: "aux2", crewMateId: "dea1" }] });
    expect(crewOf(fixed, "Amb")).toMatchObject({ source: "saved", blocked: null });
  });

  it("gives an auxiliary driver a DEA crew mate, never a second auxiliary", () => {
    const dea2 = person("dea2", ["DEA"]);
    // The DEA crew mate is absent: aux2 is free, but only dea2 completes the crew.
    const result = plan({
      vehicles: [vehicle("Amb", "AMBULANCE", "aux1", "dea1")],
      people: [...PEOPLE, dea2],
      absences: [leave("dea1")],
    });
    expect(crewOf(result, "Amb")).toMatchObject({ driverId: "aux1", crewMateId: "dea2", source: "replacement", blocked: null });
    const none = plan({ vehicles: [vehicle("Amb", "AMBULANCE", "aux1", "dea1")], absences: [leave("dea1")] });
    expect(crewOf(none, "Amb")).toMatchObject({ driverId: "aux1", crewMateId: null, blocked: "Aucun équipier ambulancier DE disponible" });
  });

  it("refuses a fixed ambulance crew without any DEA", () => {
    const result = plan({ saved: [{ vehicleId: "Amb", driverId: "aux1", crewMateId: "aux2" }] });
    expect(crewOf(result, "Amb").blocked).toBe("Il faut au moins un ambulancier DE dans l'équipage, au volant ou auprès du patient");
  });

  it("requires a second person on an ambulance", () => {
    const result = plan({ people: PEOPLE.filter((p) => !["aux1", "aux2", "spare_a"].includes(p.id)) });
    expect(crewOf(result, "Amb")).toMatchObject({ driverId: "dea1", crewMateId: null, blocked: "Aucun équipier disponible" });
  });

  it("says the regulator left the driver seat of a fixed ambulance empty", () => {
    const result = plan({ saved: [{ vehicleId: "Amb", driverId: null, crewMateId: "aux1" }] });
    expect(crewOf(result, "Amb")).toMatchObject({
      driverId: null,
      crewMateId: "aux1",
      parked: false,
      blocked: "Pas de chauffeur ce jour (choix du régulateur)",
    });
  });

  it("offers a default member alone on an ambulance nobody can complete to another vehicle", () => {
    // aux1 drives the ambulance, its DEA is absent and no DEA is free; the VSL's driver is absent too.
    const vehicles = [vehicle("VSL", "VSL", "vslHolder"), vehicle("Amb", "AMBULANCE", "aux1", "dea1")];
    const people = [person("vslHolder", ["AUXILIARY"]), person("aux1", ["AUXILIARY"]), person("dea1", ["DEA"])];
    const result = plan({ vehicles, people, absences: [leave("vslHolder"), leave("dea1")] });
    expect(crewOf(result, "VSL")).toMatchObject({ driverId: "aux1", source: "replacement", blocked: null });
    const amb = crewOf(result, "Amb");
    expect(amb).toMatchObject({ driverId: null, crewMateId: null, source: "none", blocked: "Aucun équipier ambulancier DE disponible" });
    expect(amb.issues.map((i) => i.message)).toContain(
      "Chauffeur attitré proposé sur VSL (AUX1 aux1)\u00a0: aucun équipier ambulancier DE disponible pour cette ambulance",
    );
    expect(result.idle).toEqual([]);
    // Nobody else needs them: they stay on their ambulance.
    const alone = plan({ vehicles: [vehicles[1]!], people, absences: [leave("dea1")] });
    expect(crewOf(alone, "Amb")).toMatchObject({ driverId: "aux1", blocked: "Aucun équipier ambulancier DE disponible" });
    expect(alone.idle).toEqual(["vslHolder"]);
  });
});

describe("replacement ranking (depots, shifts, versatility)", () => {
  const DEPOTS = [
    { id: "dep_a", name: "Marseille", lat: 43.3, lng: 5.4 },
    // About 45 km from Marseille.
    { id: "dep_b", name: "Aix", lat: 43.53, lng: 5.85 },
    // About 160 km from Marseille.
    { id: "dep_c", name: "Gap", lat: 44.56, lng: 6.08 },
  ];

  it("takes the nearest depot within the maximum distance, and says how far", () => {
    const people = [
      person("taxi1", ["TAXI_CARD"]),
      person("far", ["TAXI_CARD"], "dep_c"),
      person("near", ["TAXI_CARD"], "dep_b"),
    ];
    const result = plan({ vehicles: [vehicle("Taxi A", "TAXI", "taxi1")], people, depots: DEPOTS, absences: [leave("taxi1")] });
    expect(crewOf(result, "Taxi A").driverId).toBe("near");
    expect(crewOf(result, "Taxi A").issues.at(-1)?.message).toMatch(/^Chauffeur remplaçant proposé\u00a0: NEAR near \(dépôt de Aix, \d+ km\)$/);
    // Gap is beyond the limit: nobody rather than a driver 160 km away.
    const onlyFar = plan({
      vehicles: [vehicle("Taxi A", "TAXI", "taxi1")],
      people: people.filter((p) => p.id !== "near"),
      depots: DEPOTS,
      absences: [leave("taxi1")],
    });
    expect(crewOf(onlyFar, "Taxi A")).toMatchObject({
      driverId: null,
      // The free driver kept out by the distance is named, so the « Disponibles » card does not contradict the row.
      blocked: "Aucun chauffeur disponible dans un rayon de 60\u00a0km (Paramètres)\u00a0: FAR far (dépôt de Gap, 150\u00a0km) est libre",
    });
    const wider = plan({
      vehicles: [vehicle("Taxi A", "TAXI", "taxi1")],
      people: people.filter((p) => p.id !== "near"),
      depots: DEPOTS,
      absences: [leave("taxi1")],
      rules: { ...DEFAULT_CREW_RULES, maxReplacementKm: 200 },
    });
    expect(crewOf(wider, "Taxi A").driverId).toBe("far");
  });

  it("keeps the DEA for the ambulance: a VSL takes the auxiliary", () => {
    // Display order puts the VSL first; the ambulance still gets the only DEA.
    const vehicles = [vehicle("VSL", "VSL", "vslHolder"), vehicle("Amb", "AMBULANCE", "deaHolder", "aux1")];
    const people = [person("vslHolder", ["AUXILIARY"]), person("deaHolder", ["DEA"]), person("aux1", ["AUXILIARY"]), person("adea", ["DEA"]), person("zaux", ["AUXILIARY"])];
    const result = plan({ vehicles, people, absences: [leave("vslHolder"), leave("deaHolder")] });
    expect(crewOf(result, "Amb")).toMatchObject({ driverId: "adea", crewMateId: "aux1", blocked: null });
    expect(crewOf(result, "VSL")).toMatchObject({ driverId: "zaux", blocked: null });
  });

  it("keeps the DEA for an ambulance even when a fixed VSL would take it for its shift", () => {
    // The fixed VSL loses its driver; the DEA covers its shift one minute better than the auxiliary,
    // but the default ambulance (auxiliary at the wheel, DEA absent) can only be completed by the DEA.
    const vehicles = [vehicle("VSL", "VSL", null), vehicle("Amb", "AMBULANCE", "aux1", "deaHolder")];
    const people = [
      person("vslFixed", ["AUXILIARY"]),
      person("aux1", ["AUXILIARY"]),
      person("deaHolder", ["DEA"]),
      person("early", ["DEA"], "dep_a", MON_FRI, [360, 1140]),
      person("late", ["AUXILIARY"], "dep_a", MON_FRI, [361, 1140]),
    ];
    const result = plan({
      vehicles,
      people,
      absences: [leave("vslFixed"), leave("deaHolder")],
      saved: [{ vehicleId: "VSL", driverId: "vslFixed", crewMateId: null }],
    });
    expect(crewOf(result, "Amb")).toMatchObject({ driverId: "aux1", crewMateId: "early", blocked: null });
    expect(crewOf(result, "VSL")).toMatchObject({ driverId: "late", proposedSeats: ["driver"], blocked: null });
  });

  it("says a spare vehicle stays empty to keep the reserve of the depot", () => {
    const result = plan({
      vehicles: [vehicle("Spare", "TAXI", null)],
      people: [person("t1", ["TAXI_CARD"])],
      rules: { ...DEFAULT_CREW_RULES, reservePerDepot: 1 },
    });
    expect(crewOf(result, "Spare").blocked).toBe(
      "Aucun chauffeur disponible sans entamer la réserve du dépôt (Paramètres)\u00a0: T1 t1 reste en réserve",
    );
  });

  it("puts the auxiliary at the wheel and the DEA beside the patient when both seats are free", () => {
    const people = [person("adea", ["DEA"]), person("zaux", ["AUXILIARY"])];
    const result = plan({ vehicles: [vehicle("Amb", "AMBULANCE", null)], people });
    expect(crewOf(result, "Amb")).toMatchObject({ driverId: "zaux", crewMateId: "adea", proposedSeats: ["driver", "crewMate"], blocked: null });
  });

  it("prefers the replacement who covers the holder's shift, and shows a shorter one", () => {
    const people = [
      person("taxi1", ["TAXI_CARD"], "dep_a", MON_FRI, [360, 1080]),
      person("afternoon", ["TAXI_CARD"], "dep_a", MON_FRI, [780, 1140]),
      person("fullday", ["TAXI_CARD", "AUXILIARY"], "dep_a", MON_FRI, [360, 1140]),
    ];
    const result = plan({ vehicles: [vehicle("Taxi A", "TAXI", "taxi1")], people, absences: [leave("taxi1")] });
    // fullday is more versatile, but covers the shift: coverage comes first.
    expect(crewOf(result, "Taxi A")).toMatchObject({ driverId: "fullday", shift: { start: 360, end: 1140 } });
    const short = plan({ vehicles: [vehicle("Taxi A", "TAXI", "taxi1")], people: people.filter((p) => p.id !== "fullday"), absences: [leave("taxi1")] });
    expect(crewOf(short, "Taxi A").issues.at(-1)?.message).toBe(
      "Chauffeur remplaçant proposé\u00a0: AFTERNOON afternoon (horaire 13:00 – 19:00 au lieu de 06:00 – 18:00)",
    );
  });

  it("requires the shared working time of an ambulance pair", () => {
    const people = [
      person("dea1", ["DEA"], "dep_a", MON_FRI, [360, 840]),
      person("aux1", ["AUXILIARY"], "dep_a", MON_FRI, [780, 1260]),
      person("aux2", ["AUXILIARY"], "dep_a", MON_FRI, [420, 1080]),
    ];
    // aux1 (default crew mate) shares 1 h with the driver: aux2 takes the seat.
    const result = plan({ vehicles: [vehicle("Amb", "AMBULANCE", "dea1", "aux1")], people });
    const crew = crewOf(result, "Amb");
    expect(crew).toMatchObject({ driverId: "dea1", crewMateId: "aux2", blocked: null, shift: { start: 420, end: 840 } });
    expect(crew.issues[0]?.message).toBe("Équipier attitré indisponible (AUX1 aux1\u00a0: 1\u00a0h\u00a000 d'horaire commun avec le chauffeur, 4\u00a0h\u00a000 au moins)");
    // Fixed by the regulator: refused with the numbers.
    const fixed = plan({ vehicles: [vehicle("Amb", "AMBULANCE", "dea1", "aux1")], people, saved: [{ vehicleId: "Amb", driverId: "dea1", crewMateId: "aux1" }] });
    expect(crewOf(fixed, "Amb").blocked).toBe("DEA1 dea1 et AUX1 aux1 n'ont que 1\u00a0h\u00a000 d'horaire commun (4\u00a0h\u00a000 au moins, Paramètres)");
  });

  it("keeps a reserve per depot before staffing a spare vehicle", () => {
    const vehicles = [vehicle("Spare", "TAXI", null)];
    const people = [person("t1", ["TAXI_CARD"]), person("t2", ["TAXI_CARD"])];
    const one = plan({ vehicles, people, rules: { ...DEFAULT_CREW_RULES, reservePerDepot: 1 } });
    expect(crewOf(one, "Spare").driverId).toBe("t1");
    expect(one.idle).toEqual(["t2"]);
    const two = plan({ vehicles, people, rules: { ...DEFAULT_CREW_RULES, reservePerDepot: 2 } });
    expect(crewOf(two, "Spare").driverId).toBeNull();
    expect(two.idle).toEqual(["t1", "t2"]);
    // A vehicle with a default crew is not held back by the reserve.
    const replaced = plan({
      vehicles: [vehicle("Taxi A", "TAXI", "holder")],
      people: [...people, person("holder", ["TAXI_CARD"])],
      absences: [leave("holder")],
      rules: { ...DEFAULT_CREW_RULES, reservePerDepot: 5 },
    });
    expect(crewOf(replaced, "Taxi A").driverId).toBe("t1");
  });

  it("resolves 120 vehicles and 150 people well under 50 ms", () => {
    const depots = Array.from({ length: 6 }, (_, i) => ({ id: `dep${i}`, name: `Dépôt ${i}`, lat: 43.3 + i * 0.25, lng: 5.4 + i * 0.12 }));
    const quals: Qualification[][] = [["TAXI_CARD"], ["AUXILIARY"], ["DEA"], ["DEA", "AUXILIARY"], ["TAXI_CARD", "AUXILIARY"]];
    const staff = Array.from({ length: 150 }, (_, i) =>
      person(`p${i}`, quals[i % quals.length]!, `dep${i % 6}`, i % 7 === 0 ? [2, 3, 4, 5, 6] : MON_FRI, [360 + (i % 4) * 60, 1080 + (i % 3) * 60]),
    );
    const types: CrewVehicle["type"][] = ["TAXI", "VSL", "AMBULANCE"];
    const fleet = Array.from({ length: 120 }, (_, i) =>
      vehicle(`V${i}`, types[i % 3]!, i < 100 ? `p${i}` : null, i % 3 === 2 && i < 100 ? `p${(i + 50) % 150}` : null, `dep${i % 6}`),
    );
    const absences = Array.from({ length: 20 }, (_, i) => leave(`p${i * 7}`));
    const input = { date: MONDAY, vehicles: fleet, people: staff, absences, incompatibilities: [], saved: [], depots };
    resolveDayCrews(input);
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const result = resolveDayCrews(input);
      times.push(performance.now() - start);
      expect(result.crews).toHaveLength(120);
    }
    expect(Math.min(...times)).toBeLessThan(50);
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

describe("work time of the crew (art. L. 3121-16)", () => {
  it("blocks a crew working more than 6 hours when the driver's break is not a legal one", () => {
    const withBreak = (id: string, breakMinutes: number, shift: [number, number] = [360, 1140]): StaffPerson => ({
      ...person(id, ["TAXI_CARD"], "dep_a", MON_FRI, shift),
      breakWindowStartMinute: 690,
      breakWindowEndMinute: 840,
      breakMinutes,
    });
    const result = plan({
      vehicles: [vehicle("Taxi A", "TAXI", "a"), vehicle("Taxi B", "TAXI", "b"), vehicle("Taxi C", "TAXI", "c")],
      people: [withBreak("a", 0), withBreak("b", 30), withBreak("c", 0, [480, 840])],
    });
    const taxiA = crewOf(result, "Taxi A");
    expect(taxiA.blocked).toMatch(/^Horaire de 13\u00a0h\u00a000 sans pause\u00a0: .*art\. L\. 3121-16/);
    expect(workTimeBlock(taxiA)).toBe("Pause de 20\u00a0min requise\u00a0: horaire de 13\u00a0h\u00a000 sans pause (art. L. 3121-16)");
    expect(crewOf(result, "Taxi B").blocked).toBeNull();
    expect(crewOf(result, "Taxi C").blocked).toBeNull(); // 6 hours: no break owed
    // People without break settings (older callers) are not checked.
    expect(crewOf(plan(), "Taxi A").blocked).toBeNull();
    // Another blocking problem has no short form: the lists show it as it is.
    const nobody = crewOf(plan({ absences: [leave("taxi1"), leave("spare_a"), leave("spare_b")] }), "Taxi A");
    expect(nobody.blocked).toBe("Aucun chauffeur disponible");
    expect(workTimeBlock(nobody)).toBeNull();
  });

  it("does not propose a replacement whose hours with the crew would need a break they do not have", () => {
    const withBreak = (id: string, breakMinutes: number, shift: [number, number] = [360, 1140]): StaffPerson => ({
      ...person(id, ["TAXI_CARD"], "dep_a", MON_FRI, shift),
      breakWindowStartMinute: 690,
      breakWindowEndMinute: 840,
      breakMinutes,
    });
    // Sorted first by name, the free driver without a break would be proposed before the one with a break.
    const people = [withBreak("titular", 45), withBreak("a_breakless", 0), withBreak("b_lawful", 45)];
    const result = plan({ vehicles: [vehicle("Taxi A", "TAXI", "titular")], people, absences: [leave("titular")] });
    expect(crewOf(result, "Taxi A")).toMatchObject({ driverId: "b_lawful", source: "replacement", blocked: null });
    expect(result.idle).toEqual(["a_breakless"]);
    // Nobody else: the seat stays empty and says why the free driver was not proposed.
    const alone = plan({ vehicles: [vehicle("Taxi A", "TAXI", "titular")], people: people.slice(0, 2), absences: [leave("titular")] });
    expect(crewOf(alone, "Taxi A").blocked).toBe(
      "Aucun chauffeur disponible\u00a0: A_BREAKLESS a_breakless est libre, mais l'équipage dépasserait 6\u00a0h de travail sans pause de 20\u00a0min (art. L. 3121-16)",
    );
    // A shift of 6 hours needs no break: proposed.
    const short = plan({
      vehicles: [vehicle("Taxi A", "TAXI", "titular")],
      people: [withBreak("titular", 45), withBreak("a_breakless", 0, [480, 840])],
      absences: [leave("titular")],
    });
    expect(crewOf(short, "Taxi A")).toMatchObject({ driverId: "a_breakless", blocked: null });
  });

  it("checks the driver's break on the hours shared with the crew mate of an ambulance", () => {
    const dea1: StaffPerson = {
      ...person("dea1", ["DEA"]),
      breakWindowStartMinute: 690,
      breakWindowEndMinute: 840,
      breakMinutes: 45,
    };
    // Usual crew mate absent; two free auxiliaries cover the holder's hours (06:00–12:05) alike.
    const result = plan({
      vehicles: [vehicle("Amb", "AMBULANCE", "dea1", "aux_off")],
      people: [
        dea1,
        person("aux_off", ["AUXILIARY"], "dep_a", MON_FRI, [360, 725]),
        person("aux_a", ["AUXILIARY"], "dep_a", MON_FRI, [360, 725]),
        person("aux_b", ["AUXILIARY"]),
      ],
      absences: [leave("aux_off")],
    });
    // aux_a is first by name, but 06:00–12:05 with the driver leaves 35 min of the 45 min break's window (11:30–14:00).
    expect(crewOf(result, "Amb")).toMatchObject({ driverId: "dea1", crewMateId: "aux_b", blocked: null });
  });
});

