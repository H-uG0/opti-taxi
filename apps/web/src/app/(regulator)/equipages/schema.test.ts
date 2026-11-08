import { describe, expect, it } from "vitest";
import type { DayCrewView } from "@/lib/staff/day-crews";
import { crewFormErrors, readCrewForm } from "./schema";

const VEHICLES = [
  { id: "taxi", type: "TAXI" as const },
  { id: "amb", type: "AMBULANCE" as const },
];

function crew(overrides: Partial<DayCrewView>): DayCrewView {
  return { vehicleId: "taxi", driverId: "d1", crewMateId: null, source: "saved", issues: [], blocked: null, ...overrides };
}

describe("readCrewForm", () => {
  it("reads every vehicle, empty meaning nobody, a crew mate only for an ambulance", () => {
    const { saved, errors } = readCrewForm(
      { "driver:taxi": "d1", "mate:taxi": "ignored", "driver:amb": "", "mate:amb": "m1" },
      VEHICLES,
    );
    expect(errors).toEqual({});
    expect(saved).toEqual([
      { vehicleId: "taxi", driverId: "d1", crewMateId: null },
      { vehicleId: "amb", driverId: null, crewMateId: "m1" },
    ]);
  });

  it("reports a malformed id on its field", () => {
    expect(readCrewForm({ "driver:taxi": "../x" }, VEHICLES).errors).toEqual({
      "driver:taxi": "Personne inconnue : rechargez la page.",
    });
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

  it("accepts a vehicle left at the depot, but not a crew mate without driver", () => {
    const off = crew({ driverId: null, issues: [{ level: "error", seat: "driver", message: "Pas de chauffeur ce jour" }] });
    expect(crewFormErrors({ crews: [off] })).toEqual({});
    const mateOnly = crew({ vehicleId: "amb", driverId: null, crewMateId: "m1", issues: [] });
    expect(crewFormErrors({ crews: [mateOnly] })).toEqual({ "driver:amb": "Choisissez aussi un chauffeur, ou retirez l'équipier." });
  });
});
