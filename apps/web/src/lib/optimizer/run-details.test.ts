import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planResponseSchema, type PlanResponse } from "./contract";
import { readRunDetails, runKpisJson } from "./run-details";

const fixtures = path.resolve(__dirname, "../../../../../contract/fixtures");
const fixture: PlanResponse = planResponseSchema.parse(
  JSON.parse(readFileSync(path.join(fixtures, "plan-response.json"), "utf8")),
);

const response: PlanResponse = {
  ...fixture,
  validation: {
    valid: false,
    violations: [
      { code: "TIME_WINDOW", message: "Arrivée 07:42 après le RDV de 07:30", tripId: "t1", vehicleId: "v1" },
      { code: "SHIFT", message: "Fin de service dépassée", tripId: null, vehicleId: "v2" },
    ],
  },
  unassigned: [{ tripId: "t9", reason: "Horaires inatteignables pour le véhicule figé" }],
  meta: { ...fixture.meta, solverStatus: "ROUTING_SUCCESS", warnings: ["Aucune grille tarifaire pour AMBULANCE 05"] },
};

/** What Prisma hands back for a Json column: plain JSON. */
function throughDatabase(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("run details stored with the KPIs", () => {
  it("keeps the optimizer KPIs at the top level of the JSON", () => {
    const json = runKpisJson(response);
    expect(json).toMatchObject(response.kpis);
  });

  it("reads back the violations, warnings and unassigned reasons after a round trip", () => {
    const stored = throughDatabase(runKpisJson(response));
    expect(readRunDetails("run_1", stored as never)).toEqual({
      runId: "run_1",
      solverStatus: "ROUTING_SUCCESS",
      violations: response.validation.violations,
      warnings: ["Aucune grille tarifaire pour AMBULANCE 05"],
      unassigned: [{ tripId: "t9", reason: "Horaires inatteignables pour le véhicule figé" }],
    });
  });

  it("returns null for runs saved without details, or unreadable JSON", () => {
    expect(readRunDetails("run_1", null)).toBeNull();
    expect(readRunDetails("run_1", undefined)).toBeNull();
    expect(readRunDetails("run_1", throughDatabase(response.kpis) as never)).toBeNull();
    expect(readRunDetails("run_1", { details: { violations: "?" } })).toBeNull();
    expect(readRunDetails("run_1", [1, 2])).toBeNull();
  });
});
