import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planResponseSchema, type PlanResponse } from "./contract";
import { readPendingPlan, readRunDetails, runDetailsJson, withoutPending, type StoredRun } from "./run-details";

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

const expected = {
  runId: "run_1",
  solverStatus: "ROUTING_SUCCESS",
  violations: response.validation.violations,
  warnings: ["Aucune grille tarifaire pour AMBULANCE 05"],
  unassigned: [{ tripId: "t9", reason: "Horaires inatteignables pour le véhicule figé" }],
  trafficSource: "factors",
};

/** What Prisma hands back for a Json column: plain JSON. */
function throughDatabase(value: unknown): StoredRun["details"] {
  return value === null ? null : (JSON.parse(JSON.stringify(value)) as StoredRun["details"]);
}

function storedRun(details: unknown, kpis: unknown): StoredRun {
  return { id: "run_1", details: throughDatabase(details), kpis: throughDatabase(kpis) };
}

describe("run details column", () => {
  it("holds the solver status, violations, warnings and unassigned reasons, and no KPI", () => {
    const json = runDetailsJson(response);
    expect(Object.keys(json).sort()).toEqual(["solverStatus", "trafficSource", "unassigned", "violations", "warnings"]);
  });

  it("reads back the details after a round trip, next to KPIs stored as they are", () => {
    expect(readRunDetails(storedRun(runDetailsJson(response), response.kpis))).toEqual(expected);
  });

  it("reads the details of runs saved before the column, from the kpis JSON", () => {
    const legacyKpis = { ...response.kpis, details: runDetailsJson(response) };
    expect(readRunDetails(storedRun(null, legacyKpis))).toEqual(expected);
  });

  it("prefers the details column to a legacy copy in the kpis JSON", () => {
    const legacyKpis = { ...response.kpis, details: { ...runDetailsJson(response), warnings: ["ancien"] } };
    expect(readRunDetails(storedRun(runDetailsJson(response), legacyKpis))?.warnings).toEqual(expected.warnings);
  });

  it("returns null for runs saved without details, or unreadable JSON", () => {
    expect(readRunDetails(storedRun(null, null))).toBeNull();
    expect(readRunDetails(storedRun(null, response.kpis))).toBeNull();
    expect(readRunDetails(storedRun({ violations: "?" }, null))).toBeNull();
    expect(readRunDetails(storedRun(null, { details: { violations: "?" } }))).toBeNull();
    expect(readRunDetails(storedRun([1, 2], [1, 2]))).toBeNull();
  });
});

describe("replanning guard details", () => {
  const comparison = {
    current: { served: 300, violations: 0, revenue: 10_000, margin: 4_800, km: 1_790 },
    next: { served: 280, violations: 2, revenue: 9_500, margin: 4_100, km: 1_850 },
    lostTripIds: ["t9"],
  };
  const previous = {
    runId: "run_0",
    figures: comparison.current,
    routes: [{ vehicleId: "v1", stops: [{ tripId: "t1", kind: "PICKUP" as const }, { tripId: "t1", kind: "DROPOFF" as const }] }],
  };
  const lockChange = { tripId: "t1", from: null, to: "v2" };
  const pending = { response, requestHash: "h", basedOnVersion: "v1", lockChange };

  it("keeps the kind, comparison, previous routes, question and lock change through the database", () => {
    const undrivable = { ...comparison, undrivable: { vehicles: ["Taxi 2"], trips: 8 } };
    const details = throughDatabase(
      runDetailsJson(response, { kind: "move", comparison: undrivable, previous, question: "Remplacer\u202f?", lockChange }),
    );
    expect(readRunDetails({ id: "run_1", details, kpis: null })).toEqual({
      ...expected,
      kind: "move",
      comparison: undrivable,
      previous,
      question: "Remplacer\u202f?",
      lockChange,
    });
  });

  it("reads the plan waiting for confirmation, and drops it once handled (the comparison stays)", () => {
    const details = throughDatabase(runDetailsJson(response, { comparison, pending }));
    expect(readPendingPlan(details)).toEqual(pending);
    const handled = throughDatabase(withoutPending(details));
    expect(readPendingPlan(handled)).toBeNull();
    expect(readRunDetails({ id: "run_1", details: handled, kpis: null })?.comparison).toEqual(comparison);
    expect(readPendingPlan(null)).toBeNull();
  });
});
