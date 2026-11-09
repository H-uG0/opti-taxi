import { describe, expect, it } from "vitest";
import type { DayCrewView } from "@/lib/staff/day-crews";
import {
  changedRows,
  concurrentChangeErrors,
  crewFormErrors,
  crewOrigin,
  mergeFixedCrews,
  ORIGIN_LABELS,
  readCrewForm,
  unavailableChoiceErrors,
  unfixIntentVehicle,
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
      { vehicleId: "taxi", driverId: "d1", crewMateId: null, shown: { driverId: "d1", crewMateId: null }, version: "" },
      {
        vehicleId: "amb",
        driverId: null,
        crewMateId: "m1",
        shown: { driverId: "d2", crewMateId: "m1" },
        version: "2026-11-09T13:32:05.120Z",
      },
    ]);
    // Only the ambulance changed (its driver was removed): the taxi stays a proposal.
    expect(changedRows(rows).map((row) => row.vehicleId)).toEqual(["amb"]);
  });

  it("reports a malformed id or version on its field", () => {
    expect(readCrewForm({ "driver:taxi": "../x" }, VEHICLES).errors).toEqual({
      "driver:taxi": "Personne inconnue : rechargez la page.",
    });
    expect(readCrewForm({ "version:taxi": "hier" }, VEHICLES).errors).toEqual({ "driver:taxi": "Page périmée : rechargez la page." });
  });
});

describe("concurrency on the fixed crews", () => {
  const row = (vehicleId: string, version: string) => ({
    vehicleId,
    driverId: "d9",
    crewMateId: null,
    shown: { driverId: "d1", crewMateId: null },
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

  it("reads the vehicle of a « Revenir à la proposition » button", () => {
    expect(unfixIntentVehicle("unfix:veh_12")).toBe("veh_12");
    expect(unfixIntentVehicle("unfix:../x")).toBeNull();
    expect(unfixIntentVehicle("save")).toBeNull();
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
