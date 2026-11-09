import { describe, expect, it } from "vitest";
import type { TripView } from "./types";
import { validationIssues, validationQuestion, type ValidationView } from "./validation";

const clean: ValidationView = {
  unassigned: [],
  violations: [],
  violationsKnown: true,
  staleTrips: [],
  trips: [],
  vehicleIssues: [],
};

const violation = { code: "TIME_WINDOW", label: "Hors fenêtre horaire", message: "Retard", tripId: "a", vehicleId: "v1" };

describe("validationIssues", () => {
  it("asks nothing for a clean day", () => {
    expect(validationIssues(clean)).toEqual([]);
  });

  it("lists routes planned before a vehicle or crew change, then overdue deadlines, then the trips", () => {
    const issues = validationIssues({
      ...clean,
      vehicleIssues: [
        { vehicleId: "v1", label: "Taxi 1", hasRoute: true, changes: ["Véhicule indisponible (entretien le 10/11/2026)"], compliance: [] },
        { vehicleId: "v2", label: "Taxi 2", hasRoute: true, changes: [], compliance: ["Assurance : échéance dépassée (01/11/2026)"] },
      ],
      unassigned: [{ tripId: "c", reason: "" }],
      violations: [violation, violation],
      staleTrips: [{ tripId: "d", reason: "Course annulée après l'optimisation" }],
      trips: [{ id: "r", outboundNoShow: true } as TripView, { id: "s", outboundNoShow: false } as TripView],
    });
    expect(issues).toEqual([
      "1 tournée planifiée avant un changement de véhicule ou d'équipage",
      "1 véhicule à l'échéance dépassée (contrôle technique ou assurance)",
      "1 course non affectée",
      "2 violations de contraintes",
      "1 retour à vérifier (patient absent à l'aller)",
      "1 course à revoir (annulée, patient absent ou figée ailleurs)",
    ]);
  });

  it("does not ask about an overdue vehicle that has no route that day", () => {
    const idle = { vehicleId: "v3", label: "Taxi 3", hasRoute: false, changes: [], compliance: ["Assurance : échéance dépassée (01/11/2026)"] };
    expect(validationIssues({ ...clean, vehicleIssues: [idle] })).toEqual([]);
  });

  it("still warns when the violations of the last computation were not recorded", () => {
    expect(validationIssues({ ...clean, violationsKnown: false })).toEqual(["des violations de contraintes"]);
  });
});

describe("validationQuestion", () => {
  it("joins the issues as a French sentence", () => {
    expect(validationQuestion(["2 courses non affectées"])).toBe("Le planning comporte 2 courses non affectées. Valider quand même ?");
    expect(validationQuestion(["a", "b", "c"])).toBe("Le planning comporte a, b et c. Valider quand même ?");
  });
});
