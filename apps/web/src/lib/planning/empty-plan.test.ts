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

  it("counts together the reasons that only differ by their trip's times and vehicles", () => {
    const noRoom = (times: string, what: string) => `Pas de place dans les tournées pour le trajet de ${times} : ${what}`;
    const reasons = [
      noRoom("11:30 à 11:54", "Ambulance 1 (Marseille) est en pause de 11:46 à 12:31"),
      noRoom("07:53 à 09:00", "Ambulance 2 (Gap) ne peut pas arriver à temps après son arrêt de 07:00"),
      noRoom("13:10 à 14:00", "les 8 véhicules compatibles transportent d'autres patients"),
      "Aucun véhicule de type autorisé (Ambulance) disponible ce jour",
      "Aucun véhicule de type autorisé (Ambulance) disponible ce jour",
    ];
    expect(emptyPlanIssue(plan(0, 5, reasons))).toBe(
      "L'optimisation n'a placé aucune des 5 courses : le planning actuel est conservé. " +
        "Motif le plus fréquent (3 sur 5) : Pas de place dans les tournées.",
    );
    expect(emptyPlanIssue(plan(0, 3, [UNREACHABLE, UNREACHABLE.replace("09:00", "10:30"), TIME_LIMIT]))).toBe(
      "L'optimisation n'a placé aucune des 3 courses : le planning actuel est conservé. " +
        "Motif le plus fréquent (2 sur 3) : Horaires inatteignables : aucun véhicule compatible ne peut assurer la course.",
    );
  });

  it("still refuses an empty plan that gives no reason", () => {
    expect(emptyPlanIssue(plan(0, 2, []))).toBe("L'optimisation n'a placé aucune des 2 courses : le planning actuel est conservé.");
  });
});
