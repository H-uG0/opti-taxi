import { describe, expect, it } from "vitest";
import { resolveDayCrews, type DayCrewInput, type DayCrewView, type StaffPerson } from "@/lib/staff/day-crews";
import {
  asShown,
  brokenFixedCrews,
  changedRows,
  concurrentChangeErrors,
  crewFormErrors,
  crewOrigin,
  fixIntentVehicle,
  mergeFixedCrews,
  ORIGIN_LABELS,
  PARK_VALUE,
  readCrewForm,
  shownVersions,
  takenFromFixedErrors,
  unavailableChoiceErrors,
  unfixIntentVehicle,
  type CrewFormRow,
} from "./schema";

const VEHICLES = [
  { id: "taxi", type: "TAXI" as const },
  { id: "amb", type: "AMBULANCE" as const },
];

function crew(overrides: Partial<DayCrewView>): DayCrewView {
  return {
    vehicleId: "taxi",
    driverId: "d1",
    crewMateId: null,
    source: "saved",
    proposedSeats: [],
    parked: false,
    shift: null,
    issues: [],
    blocked: null,
    unavailable: false,
    ...overrides,
  };
}

describe("readCrewForm", () => {
  it("reads every vehicle, empty meaning nobody, a crew mate only for an ambulance", () => {
    const { rows, errors } = readCrewForm(
      {
        "driver:taxi": "d1",
        "mate:taxi": "ignored",
        "was-driver:taxi": "d1",
        "driver:amb": "",
        "mate:amb": "m1",
        "was-driver:amb": "d2",
        "was-mate:amb": "m1",
        "version:amb": "2026-11-09T13:32:05.120Z",
      },
      VEHICLES,
    );
    expect(errors).toEqual({});
    expect(rows).toEqual([
      {
        vehicleId: "taxi",
        driverId: "d1",
        crewMateId: null,
        park: false,
        shown: { driverId: "d1", crewMateId: null, park: false },
        version: "",
      },
      {
        vehicleId: "amb",
        driverId: null,
        crewMateId: "m1",
        park: false,
        shown: { driverId: "d2", crewMateId: "m1", park: false },
        version: "2026-11-09T13:32:05.120Z",
      },
    ]);
    // Only the ambulance changed (its driver was removed): the taxi stays a proposal.
    expect(changedRows(rows).map((row) => row.vehicleId)).toEqual(["amb"]);
  });

  it("reads « Laisser au dépôt » as a change, even on a row that already shows nobody", () => {
    const { rows } = readCrewForm(
      {
        // Nobody available: choosing « Laisser au dépôt » keeps it there on purpose.
        "driver:taxi": PARK_VALUE,
        "was-driver:taxi": "",
        // Left at the depot already, crew mate select ignored.
        "driver:amb": PARK_VALUE,
        "mate:amb": "m1",
        "was-driver:amb": PARK_VALUE,
      },
      VEHICLES,
    );
    expect(rows.map((row) => [row.vehicleId, row.driverId, row.crewMateId, row.park, row.shown.park])).toEqual([
      ["taxi", null, null, true, false],
      ["amb", null, null, true, true],
    ]);
    expect(changedRows(rows).map((row) => row.vehicleId)).toEqual(["taxi"]);
    // « — Aucun chauffeur — » on a row showing nobody is no change.
    expect(changedRows(readCrewForm({ "driver:taxi": "", "was-driver:taxi": "" }, VEHICLES).rows)).toEqual([]);
  });

  it("reports a malformed id or version on its field", () => {
    expect(readCrewForm({ "driver:taxi": "../x" }, VEHICLES).errors).toEqual({
      "driver:taxi": "Personne inconnue : rechargez la page.",
    });
    expect(readCrewForm({ "version:taxi": "hier" }, VEHICLES).errors).toEqual({ "driver:taxi": "Page périmée : rechargez la page." });
  });
});

describe("concurrency on the fixed crews", () => {
  const row = (vehicleId: string, version: string): CrewFormRow => ({
    vehicleId,
    driverId: "d9",
    crewMateId: null,
    park: false,
    shown: { driverId: "d1", crewMateId: null, park: false },
    version,
  });
  const at = new Date("2026-11-09T13:32:05.120Z");

  it("accepts a row whose fixed crew is still the version shown", () => {
    expect(concurrentChangeErrors([row("taxi", at.toISOString())], new Map([["taxi", { updatedAt: at, updatedBy: "Marie" }]]))).toEqual({});
    expect(concurrentChangeErrors([row("taxi", "")], new Map())).toEqual({});
  });

  it("refuses a row a colleague fixed, changed or reset since, and says who", () => {
    const later = new Date("2026-11-09T13:40:00.000Z");
    expect(concurrentChangeErrors([row("taxi", "")], new Map([["taxi", { updatedAt: later, updatedBy: "Marie Dupont" }]]))).toEqual({
      "driver:taxi": "Modifié par Marie Dupont le 09/11 à 14:40 entre-temps : rechargez la page pour voir son choix.",
    });
    expect(concurrentChangeErrors([row("taxi", at.toISOString())], new Map([["taxi", { updatedAt: later, updatedBy: null }]]))).toEqual({
      "driver:taxi": "Modifié le 09/11 à 14:40 entre-temps : rechargez la page pour voir son choix.",
    });
    expect(concurrentChangeErrors([row("taxi", at.toISOString())], new Map())).toEqual({
      "driver:taxi": "Remis à la proposition automatique par un collègue entre-temps : rechargez la page.",
    });
  });

  it("applies the changed rows over the fixed crews of the database", () => {
    const merged = mergeFixedCrews(
      [
        { vehicleId: "taxi", driverId: "d1", crewMateId: null },
        { vehicleId: "amb", driverId: "d2", crewMateId: "m1" },
      ],
      [row("taxi", "")],
    );
    expect(merged).toEqual([
      { vehicleId: "taxi", driverId: "d9", crewMateId: null },
      { vehicleId: "amb", driverId: "d2", crewMateId: "m1" },
    ]);
  });

  it("refuses a person chosen while absent or deactivated", () => {
    const people = new Map([
      ["d9", { firstName: "Paul", lastName: "Roux", active: true }],
      ["m2", { firstName: "Léa", lastName: "Faure", active: false }],
    ]);
    const amb = { ...row("amb", ""), crewMateId: "m2" };
    expect(
      unavailableChoiceErrors([amb], people, [{ driverId: "d9", kind: "SICK", startDate: "2026-11-09", endDate: "2026-11-10" }], "2026-11-09"),
    ).toEqual({ "driver:amb": "Paul Roux : absence du 09/11/2026 au 10/11/2026", "mate:amb": "Léa Faure est désactivé" });
    expect(unavailableChoiceErrors([amb], people, [], "2026-11-09")).toEqual({ "mate:amb": "Léa Faure est désactivé" });
  });

  it("reads the vehicle of a « Revenir à la proposition » or « Fixer cette proposition » button", () => {
    expect(unfixIntentVehicle("unfix:veh_12")).toBe("veh_12");
    expect(unfixIntentVehicle("unfix:../x")).toBeNull();
    expect(unfixIntentVehicle("save")).toBeNull();
    expect(fixIntentVehicle("fix:veh_12")).toBe("veh_12");
    expect(fixIntentVehicle("unfix:veh_12")).toBeNull();
  });

  it("fixes a proposal as it was shown, with the version it showed", () => {
    const shown = { ...row("taxi", "2026-11-09T13:32:05.120Z"), shown: { driverId: "rep", crewMateId: null, park: false } };
    expect(asShown(shown)).toMatchObject({ vehicleId: "taxi", driverId: "rep", crewMateId: null, park: false, version: "2026-11-09T13:32:05.120Z" });
  });

  it("reads the versions a page showed, for « Revenir aux propositions »", () => {
    const values = { "version:taxi": "2026-11-09T13:32:05.120Z", "version:amb": "", "version:old": "hier" };
    expect(shownVersions(values, ["taxi", "amb", "old"])).toEqual([{ vehicleId: "taxi", updatedAt: new Date("2026-11-09T13:32:05.120Z") }]);
  });
});

describe("crewFormErrors", () => {
  it("puts each error on its seat, the first one only", () => {
    const errors = crewFormErrors({
      crews: [
        crew({
          issues: [
            { level: "info", seat: "driver", message: "affectation exceptionnelle" },
            { level: "error", seat: "driver", message: "Paul ROUX : congé le 09/11/2026" },
            { level: "error", seat: "driver", message: "second" },
          ],
        }),
        crew({
          vehicleId: "amb",
          crewMateId: "m1",
          issues: [{ level: "error", seat: "crewMate", message: "ne doivent pas travailler ensemble" }],
        }),
      ],
    });
    expect(errors).toEqual({ "driver:taxi": "Paul ROUX : congé le 09/11/2026", "mate:amb": "ne doivent pas travailler ensemble" });
  });

  it("only checks the rows asked for (the changed ones)", () => {
    const broken = crew({ issues: [{ level: "error", seat: "driver", message: "absent" }] });
    expect(crewFormErrors({ crews: [broken] }, new Set(["amb"]))).toEqual({});
    expect(crewFormErrors({ crews: [broken] }, new Set(["taxi"]))).toEqual({ "driver:taxi": "absent" });
  });

  it("accepts a vehicle left at the depot, but not a crew mate without driver", () => {
    const off = crew({ driverId: null, issues: [{ level: "error", seat: "driver", message: "Pas de chauffeur ce jour" }] });
    expect(crewFormErrors({ crews: [off] })).toEqual({});
    const mateOnly = crew({ vehicleId: "amb", driverId: null, crewMateId: "m1", issues: [] });
    expect(crewFormErrors({ crews: [mateOnly] })).toEqual({ "driver:amb": "Choisissez aussi un chauffeur, ou retirez l'équipier." });
  });

  it("says so for a crew mate without driver on a resolved plan too", () => {
    const resolved = resolveDayCrews({
      ...INPUT,
      saved: [{ vehicleId: "amb", driverId: null, crewMateId: "aux" }],
    });
    expect(crewFormErrors(resolved, new Set(["amb"]))).toEqual({ "driver:amb": "Choisissez aussi un chauffeur, ou retirez l'équipier." });
  });
});

const staff = (id: string, qualifications: StaffPerson["qualifications"]): StaffPerson => ({
  id,
  firstName: id,
  lastName: id.toUpperCase(),
  active: true,
  workDays: [1, 2, 3, 4, 5],
  qualifications,
  depotId: "dep",
  shiftStartMinute: 360,
  shiftEndMinute: 1140,
});

const INPUT: DayCrewInput = {
  date: "2026-11-09",
  vehicles: [
    { id: "taxiA", label: "Taxi A", type: "TAXI", active: true, depotId: "dep", defaultDriverId: "a", defaultCrewMateId: null },
    { id: "taxiB", label: "Taxi B", type: "TAXI", active: true, depotId: "dep", defaultDriverId: "b", defaultCrewMateId: null },
    { id: "amb", label: "Amb", type: "AMBULANCE", active: true, depotId: "dep", defaultDriverId: null, defaultCrewMateId: null },
  ],
  people: [staff("a", ["TAXI_CARD"]), staff("b", ["TAXI_CARD"]), staff("x", ["TAXI_CARD"]), staff("aux", ["AUXILIARY"])],
  absences: [],
  incompatibilities: [],
  saved: [],
};

describe("a change taking a person from another fixed crew", () => {
  const people = new Map(INPUT.people.map((p) => [p.id, p]));
  const labels = new Map(INPUT.vehicles.map((v) => [v.id, v.label]));
  const change = (vehicleId: string, driverId: string, shownDriver: string): CrewFormRow => ({
    vehicleId,
    driverId,
    crewMateId: null,
    park: false,
    shown: { driverId: shownDriver, crewMateId: null, park: false },
    version: "",
  });

  /** The errors saveDayCrews checks, for `changed` over the fixed crews `saved`. */
  function check(saved: DayCrewInput["saved"], changed: CrewFormRow[]) {
    const before = resolveDayCrews({ ...INPUT, saved });
    const after = resolveDayCrews({ ...INPUT, saved: mergeFixedCrews(saved, changed) });
    const ids = new Set(changed.map((row) => row.vehicleId));
    return {
      errors: { ...crewFormErrors(after, ids), ...takenFromFixedErrors(changed, before, people, labels) },
      broken: brokenFixedCrews(before, after, ids),
    };
  }

  const message =
    "x X fait déjà partie de l'équipage fixé de Taxi B ce jour : revenez d'abord à la proposition sur Taxi B, ou choisissez quelqu'un d'autre.";

  it("refuses it on the changed row when that row comes first in display order", () => {
    // Taxi A (changed) comes before Taxi B (fixed with x): the crews of the day would give x to Taxi A.
    const { errors, broken } = check([{ vehicleId: "taxiB", driverId: "x", crewMateId: null }], [change("taxiA", "x", "a")]);
    expect(errors).toEqual({ "driver:taxiA": message });
    expect(broken).toEqual([{ vehicleId: "taxiB", message: "x X est déjà affecté à Taxi A ce jour" }]);
  });

  it("refuses it with the same message when the changed row comes later", () => {
    // Taxi A (fixed with x) comes first: the changed Taxi B gets « déjà affecté », replaced by the same message.
    const { errors, broken } = check([{ vehicleId: "taxiA", driverId: "x", crewMateId: null }], [change("taxiB", "x", "b")]);
    expect(errors).toEqual({
      "driver:taxiB":
        "x X fait déjà partie de l'équipage fixé de Taxi A ce jour : revenez d'abord à la proposition sur Taxi A, ou choisissez quelqu'un d'autre.",
    });
    expect(broken).toEqual([]);
  });

  it("accepts taking a person who is only a proposal elsewhere, or moving people between two changed rows", () => {
    // b is Taxi B's default driver (a proposal): fixing b on Taxi A leaves Taxi B to the proposals.
    expect(check([], [change("taxiA", "b", "a")])).toEqual({ errors: {}, broken: [] });
    // Both rows changed: a swap.
    expect(
      check(
        [
          { vehicleId: "taxiA", driverId: "a", crewMateId: null },
          { vehicleId: "taxiB", driverId: "b", crewMateId: null },
        ],
        [change("taxiA", "b", "a"), change("taxiB", "a", "b")],
      ),
    ).toEqual({ errors: {}, broken: [] });
  });
});

describe("crewOrigin", () => {
  it("tells a vehicle left at the depot on purpose from nobody available", () => {
    expect(crewOrigin({ source: "saved", parked: true })).toBe("parked");
    expect(crewOrigin({ source: "saved", parked: false })).toBe("fixed");
    expect(crewOrigin({ source: "none", parked: false })).toBe("none");
    expect(ORIGIN_LABELS.parked).toBe("Laissé au dépôt");
    expect(ORIGIN_LABELS.none).toBe("Aucun disponible");
  });
});
