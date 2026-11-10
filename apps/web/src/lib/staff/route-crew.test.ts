import { describe, expect, it } from "vitest";
import type { Qualification } from "@prisma/client";
import { DEFAULT_CREW_RULES, resolveDayCrews, type StaffPerson } from "./day-crews";
import {
  checkRouteCrewChange,
  choiceDepotText,
  choiceProblem,
  crewChoices,
  pairProblem,
  rankChoices,
  remainingPart,
  type RemainingStop,
  type RouteCrewChangeInput,
} from "./route-crew";

const MONDAY = "2026-11-09";

function person(id: string, qualifications: Qualification[], shift: [number, number] = [360, 1140], workDays = [1, 2, 3, 4, 5]): StaffPerson {
  return {
    id,
    firstName: id,
    lastName: id.toUpperCase(),
    active: true,
    workDays,
    qualifications,
    depotId: "dep_a",
    shiftStartMinute: shift[0],
    shiftEndMinute: shift[1],
  };
}

const PEOPLE = new Map(
  [
    person("aux1", ["AUXILIARY"]),
    person("aux2", ["AUXILIARY"]),
    person("dea1", ["DEA"]),
    person("dea2", ["DEA"]),
    person("taxi1", ["TAXI_CARD"]),
    person("late", ["DEA"], [600, 1140]),
    person("sat", ["DEA"], [360, 1140], [6]),
  ].map((p) => [p.id, p]),
);

function check(overrides: Partial<RouteCrewChangeInput>) {
  return checkRouteCrewChange({
    date: MONDAY,
    vehicle: { label: "Ambulance 1", type: "AMBULANCE" },
    current: { driverId: "aux1", crewMateId: "dea1" },
    next: { driverId: "aux1", crewMateId: "dea2" },
    remaining: { start: 420, end: 1080 },
    people: PEOPLE,
    absences: [],
    incompatibilities: [],
    otherRoutes: [],
    ...overrides,
  });
}

describe("remainingPart", () => {
  const stop = (sequence: number, startMinute: number, completedAt: Date | null, tripStatus: RemainingStop["tripStatus"] = "PLANNED"): RemainingStop => ({
    sequence,
    kind: sequence % 2 === 1 ? "PICKUP" : "DROPOFF",
    startMinute,
    completedAt,
    tripStatus,
  });
  const route = { startMinute: 400, endMinute: 1000 };

  it("runs from the departure until something is recorded, then from the next stop to do", () => {
    expect(remainingPart(route, [stop(1, 450, null), stop(2, 500, null)])).toEqual({ start: 400, end: 1000 });
    expect(remainingPart(route, [stop(1, 450, new Date()), stop(2, 500, new Date()), stop(3, 700, null)])).toEqual({ start: 700, end: 1000 });
  });

  it("is null once every stop is closed (done, absent or cancelled)", () => {
    expect(remainingPart(route, [stop(1, 450, new Date()), stop(2, 500, null, "CANCELLED")])).toBeNull();
  });
});

describe("checkRouteCrewChange", () => {
  it("accepts an available, qualified replacement whose shift covers the rest of the route", () => {
    expect(check({})).toEqual({ errors: {}, notes: [] });
    // The auxiliary drives, the DEA rides beside the patient (R. 6312-10).
    expect(check({ next: { driverId: "aux2", crewMateId: "dea1" } }).errors).toEqual({});
  });

  it("refuses a finished route, an unchanged crew or an empty seat", () => {
    expect(check({ remaining: null }).errors).toEqual({ form: "Tournée terminée\u00a0: son équipage ne se change plus." });
    expect(check({ next: { driverId: "aux1", crewMateId: "dea1" } }).errors).toEqual({ form: "Équipage inchangé." });
    expect(check({ next: { driverId: "aux1", crewMateId: null } }).errors).toEqual({
      crewMate: "Une ambulance part à deux\u00a0: choisissez un équipier.",
    });
    expect(check({ next: { driverId: "dea1", crewMateId: "dea1" } }).errors.crewMate).toMatch(/deux personnes différentes/);
  });

  it("applies the rules of the crews of the day to the people put on the route", () => {
    expect(check({ absences: [{ driverId: "dea2", kind: "SICK", startDate: MONDAY, endDate: MONDAY }] }).errors).toEqual({
      crewMate: "DEA2 dea2\u00a0: absence le 09/11/2026.",
    });
    expect(check({ people: new Map([...PEOPLE, ["dea2", { ...PEOPLE.get("dea2")!, active: false }]]) }).errors.crewMate).toBe(
      "DEA2 dea2 est désactivé.",
    );
    expect(check({ next: { driverId: "taxi1", crewMateId: "dea1" } }).errors.driver).toBe(
      "TAXI1 taxi1 n'a pas la qualification requise pour être chauffeur (Auxiliaire ambulancier ou Ambulancier DE).",
    );
    expect(check({ otherRoutes: [{ vehicleLabel: "VSL 2", driverId: "dea2", crewMateId: null }] }).errors.crewMate).toBe(
      "DEA2 dea2 est déjà sur la tournée de VSL 2 ce jour.",
    );
    expect(check({ next: { driverId: "aux1", crewMateId: "late" } }).errors.crewMate).toBe(
      "Horaire de LATE late (10:00 – 19:00)\u00a0: ne couvre pas la suite de la tournée (07:00 – 18:00).",
    );
  });

  it("checks the pair: incompatible, or no DEA left on board", () => {
    expect(check({ incompatibilities: [{ driverAId: "aux1", driverBId: "dea2" }] }).errors.crewMate).toBe(
      "AUX1 aux1 et DEA2 dea2 ne doivent pas travailler ensemble.",
    );
    expect(check({ next: { driverId: "aux1", crewMateId: "aux2" } }).errors.crewMate).toBe(
      "Il faut au moins un ambulancier DE dans l'équipage, au volant ou auprès du patient\u00a0: ni AUX1 aux1 ni AUX2 aux2 ne l'est.",
    );
  });

  it("requires the shared working time of the crews of the day, so the fixed crew written resolves", () => {
    // Driver 06:00 – 18:00, new crew mate 15:00 – 19:00: both cover 15:30 – 17:50, but share 3 h only.
    const people = new Map([...PEOPLE, ["drv", person("drv", ["AUXILIARY"], [360, 1080])], ["eve", person("eve", ["DEA"], [900, 1140])]]);
    const late = { people, current: { driverId: "drv", crewMateId: "dea1" }, remaining: { start: 930, end: 1070 } };
    expect(check({ ...late, next: { driverId: "drv", crewMateId: "eve" } }).errors.crewMate).toBe(
      "DRV drv et EVE eve n'ont que 3\u00a0h 00 d'horaire commun (4\u00a0h 00 au moins, Paramètres).",
    );
    expect(check({ ...late, next: { driverId: "drv", crewMateId: "eve" }, rules: { minPairOverlapMin: 180 } }).errors).toEqual({});
    // Every change accepted gives a crew of the day (DayCrew) that resolves without a blocking problem.
    const vehicle = { id: "amb", label: "Ambulance 1", type: "AMBULANCE" as const, active: true, depotId: "dep_a", defaultDriverId: null, defaultCrewMateId: null };
    for (const driverId of ["aux1", "dea1", "drv"]) {
      for (const crewMateId of ["aux2", "dea2", "eve", "late"]) {
        const next = { driverId, crewMateId };
        const { errors } = checkRouteCrewChange({
          date: MONDAY,
          vehicle,
          current: { driverId: "dea1", crewMateId: "aux1" },
          next,
          remaining: { start: 930, end: 1070 },
          people,
          absences: [],
          incompatibilities: [],
          otherRoutes: [],
          rules: DEFAULT_CREW_RULES,
        });
        if (Object.keys(errors).length > 0) continue;
        const plan = resolveDayCrews({
          date: MONDAY,
          vehicles: [vehicle],
          people: [...people.values()],
          absences: [],
          incompatibilities: [],
          saved: [{ vehicleId: "amb", ...next }],
        });
        expect(plan.crews[0]?.blocked, `${driverId} + ${crewMateId}`).toBeNull();
      }
    }
  });

  it("says why a pair cannot work together, before submitting too", () => {
    const aux = person("aux1", ["AUXILIARY"]);
    expect(pairProblem(aux, person("aux2", ["AUXILIARY"]), "AMBULANCE", DEFAULT_CREW_RULES)).toMatch(/^Il faut au moins un ambulancier DE/);
    expect(pairProblem(aux, person("dea", ["DEA"], [960, 1140]), "AMBULANCE", DEFAULT_CREW_RULES)).toBe(
      "AUX1 aux1 et DEA dea n'ont que 3\u00a0h 00 d'horaire commun (4\u00a0h 00 au moins, Paramètres).",
    );
    // Exactly the minimum is enough.
    expect(pairProblem(aux, person("dea", ["DEA"], [900, 1140]), "AMBULANCE", DEFAULT_CREW_RULES)).toBeNull();
    expect(pairProblem(aux, person("dea", ["DEA"]), "AMBULANCE", DEFAULT_CREW_RULES)).toBeNull();
    expect(pairProblem(aux, person("aux2", ["AUXILIARY"]), "VSL", DEFAULT_CREW_RULES)).toBeNull();
  });

  it("does not hold an unchanged member against the change, and notes an unusual working day", () => {
    // The driver stays (absent or not, it is the seat not being changed); only the new crew mate is checked.
    expect(check({ absences: [{ driverId: "aux1", kind: "LEAVE", startDate: MONDAY, endDate: MONDAY }] }).errors).toEqual({});
    expect(check({ next: { driverId: "aux1", crewMateId: "sat" } })).toEqual({
      errors: {},
      notes: ["SAT sat ne travaille pas habituellement le lundi\u00a0: affectation exceptionnelle."],
    });
  });

  it("has a single seat on a taxi", () => {
    const taxi = { vehicle: { label: "Taxi 1", type: "TAXI" as const }, current: { driverId: "dea1", crewMateId: null } };
    expect(check({ ...taxi, next: { driverId: "taxi1", crewMateId: "aux2" } })).toEqual({ errors: {}, notes: [] });
  });
});

describe("crewChoices", () => {
  it("lists the active people and the current crews, with what blocks each seat", () => {
    const absent = { ...person("abs", ["DEA"]), active: true };
    const gone = { ...person("gone", ["AUXILIARY"]), active: false };
    const choices = crewChoices(
      MONDAY,
      [...PEOPLE.values(), absent, gone],
      [{ driverId: "abs", kind: "SICK", startDate: MONDAY, endDate: MONDAY }],
      [{ vehicleId: "vsl2", vehicleLabel: "VSL 2", driverId: "aux2", crewMateId: null }],
    );
    expect(choices.map((c) => c.id)).not.toContain("gone");
    const byId = new Map(choices.map((c) => [c.id, c]));
    const amb = { id: "amb1", type: "AMBULANCE" as const };
    const remaining = { start: 420, end: 1080 };
    expect(choiceProblem(byId.get("abs")!, "crewMate", amb, remaining)).toBe("absence le 09/11/2026");
    expect(choiceProblem(byId.get("taxi1")!, "driver", amb, remaining)).toBe("non qualifié");
    expect(choiceProblem(byId.get("aux2")!, "driver", amb, remaining)).toBe("sur VSL 2");
    expect(choiceProblem(byId.get("aux2")!, "driver", { id: "vsl2", type: "VSL" }, remaining)).toBeNull();
    expect(choiceProblem(byId.get("late")!, "crewMate", amb, remaining)).toBe("horaire 10:00 – 19:00");
    expect(choiceProblem(byId.get("dea2")!, "crewMate", amb, remaining)).toBeNull();
    expect(byId.get("dea2")).toMatchObject({ name: "DEA2 dea2", completesAmbulance: true, worksThatDay: true });
    expect(byId.get("sat")?.worksThatDay).toBe(false);
  });

  it("names the depot of a person from another depot and ranks the choices like the replacements", () => {
    const depots = [
      { id: "mrs", name: "Marseille", lat: 43.3, lng: 5.4 },
      { id: "mnq", name: "Manosque", lat: 43.83, lng: 5.79 },
    ];
    const people = [
      { ...person("zdea", ["DEA"]), depotId: "mrs" },
      { ...person("aux", ["AUXILIARY"]), depotId: "mrs" },
      { ...person("kevin", ["AUXILIARY"]), depotId: "mnq" },
      { ...person("nowhere", ["AUXILIARY"]), depotId: null },
    ];
    const choices = crewChoices(MONDAY, people, [], [], depots);
    const marseille = { lat: 43.3, lng: 5.4 };
    const byId = new Map(choices.map((c) => [c.id, c]));
    expect(choiceDepotText(byId.get("aux")!, marseille)).toBeNull();
    expect(choiceDepotText(byId.get("kevin")!, marseille)).toMatch(/^dépôt de Manosque, \d+ km$/);
    expect(choiceDepotText(byId.get("nowhere")!, marseille)).toBe("sans dépôt");
    // Same depot first (the auxiliary before the more versatile DEA), then the nearest depot, then no depot.
    expect(rankChoices(choices, marseille).map((c) => c.id)).toEqual(["aux", "zdea", "kevin", "nowhere"]);
  });
});
