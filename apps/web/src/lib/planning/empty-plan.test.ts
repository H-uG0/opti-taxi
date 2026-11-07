import { describe, expect, it } from "vitest";
import type { PlanResponse } from "@/lib/optimizer/contract";
import { emptyPlanIssue } from "./empty-plan";

type Guarded = Pick<PlanResponse, "kpis" | "unassigned">;

function plan(served: number, total: number, reasons: string[]): Guarded {
  return {
    kpis: {
      tripsTotal: total,
      tripsServed: served,
      tripsUnassigned: total - served,
      vehiclesUsed: served > 0 ? 1 : 0,
      tripsPerVehicle: served,
      totalKm: 0,
      emptyKm: 0,
      emptyKmRatio: 0,
      sharedTrips: 0,
      sharedTripRatio: 0,
      revenue: 0,
      cost: 0,
      margin: 0,
    },
    unassigned: reasons.map((reason, i) => ({ tripId: `t${i}`, reason })),
  };
}

const TIME_LIMIT = "Non placée dans le temps de calcul imparti : augmenter le temps de calcul (Paramètres) ou placer la course à la main";
const UNREACHABLE = "Horaires inatteignables (rendez-vous à 09:00) : aucun véhicule compatible ne peut assurer la course";

describe("emptyPlanIssue", () => {
  it("lets through a plan that serves at least one trip", () => {
    expect(emptyPlanIssue(plan(1, 300, Array(299).fill(TIME_LIMIT)))).toBeNull();
  });

  it("lets through a day without trips", () => {
    expect(emptyPlanIssue(plan(0, 0, []))).toBeNull();
  });

  it("refuses a plan that serves none of the trips, with the most frequent reason", () => {
    const issue = emptyPlanIssue(plan(0, 300, [...Array(297).fill(TIME_LIMIT), UNREACHABLE, UNREACHABLE, UNREACHABLE]));
    expect(issue).toBe(
      "L'optimisation n'a placé aucune des 300 courses : le planning actuel est conservé. " +
        `Motif le plus fréquent (297 sur 300) : ${TIME_LIMIT}.`,
    );
  });

  it("still refuses an empty plan that gives no reason", () => {
    expect(emptyPlanIssue(plan(0, 2, []))).toBe("L'optimisation n'a placé aucune des 2 courses : le planning actuel est conservé.");
  });
});
