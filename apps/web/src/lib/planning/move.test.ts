import { describe, expect, it } from "vitest";
import type { BuildResult } from "@/lib/optimizer/build-request";
import type { OptimizerTrip, PlanResponse, PlanRoute } from "@/lib/optimizer/contract";
import {
  movePlacementIssue,
  moveRequestIssue,
  plannedVehicleOf,
  resolveTripRefs,
  tripRef,
  tripRefIds,
  type MoveTarget,
  type TripName,
} from "./move";

const MOVE: MoveTarget = { tripId: "t1", vehicleId: "vsl_gre", vehicleLabel: "VSL Grenoble", patientName: "Jeanne Martin" };

function trip(id: string, lockedVehicleId: string | null): OptimizerTrip {
  return {
    id,
    patientId: `p_${id}`,
    facilityId: null,
    direction: "OUTBOUND",
    pickup: { lat: 43.3, lng: 5.4 },
    dropoff: { lat: 43.29, lng: 5.38 },
    appointmentMin: 420,
    readyMin: null,
    allowedVehicleTypes: ["TAXI", "VSL"],
    shareable: false,
    lockedVehicleId,
  };
}

function build(overrides: Partial<Pick<BuildResult, "excludedTrips" | "droppedLocks">> & { trips?: OptimizerTrip[] } = {}) {
  return {
    request: {
      date: "2026-11-03",
      settings: {
        waitBeforeAppointmentMin: 30,
        waitAfterSessionMin: 30,
        maxTotalWaitMin: 45,
        maxDetourKmPerExtraPatient: 10,
        maxDetourKmTotal: 30,
        pickupServiceMin: 5,
        dropoffServiceMin: 5,
        unassignedPenalty: 1000,
        timeLimitSec: 10,
      },
      vehicles: [],
      trips: overrides.trips ?? [trip("t1", "vsl_gre"), trip("t2", null)],
      tariffs: [],
    },
    excludedTrips: overrides.excludedTrips ?? [],
    droppedLocks: overrides.droppedLocks ?? [],
  };
}

function route(vehicleId: string, tripIds: string[]): PlanRoute {
  return {
    vehicleId,
    startMin: 380,
    endMin: 700,
    distanceKm: 80,
    emptyKm: 20,
    loadedKm: 60,
    durationMin: 320,
    revenue: 120,
    cost: 90,
    margin: 30,
    break: null,
    stops: tripIds.flatMap((tripId) =>
      (["PICKUP", "DROPOFF"] as const).map((kind, i) => ({
        tripId,
        kind,
        location: { lat: 43.3, lng: 5.4 },
        arrivalMin: 400 + i * 20,
        startMin: 400 + i * 20,
        departureMin: 405 + i * 20,
        loadAfter: kind === "PICKUP" ? 1 : 0,
      })),
    ),
  };
}

const labels = new Map([
  ["vsl_gre", "VSL Grenoble"],
  ["taxi_mrs", "Taxi Marseille 1"],
]);

/** The message as the regulator reads it: the trip reference resolved to the patient's name. */
const shown = (text: string | null) =>
  text === null ? null : resolveTripRefs(text, (id) => (id === "t1" ? "Jeanne Martin" : null));

describe("moveRequestIssue", () => {
  it("accepts a trip sent to the optimizer with its new lock", () => {
    expect(moveRequestIssue(build(), MOVE)).toBeNull();
  });

  it("refuses an incomplete trip, which the optimizer never receives", () => {
    const issue = moveRequestIssue(
      build({ trips: [trip("t2", null)], excludedTrips: [{ tripId: "t1", reason: "Aller sans heure de rendez-vous" }] }),
      MOVE,
    );
    expect(shown(issue)).toBe(
      "La course de Jeanne Martin est incomplète (Aller sans heure de rendez-vous)\u00a0: complétez-la dans Courses avant de la déplacer.",
    );
  });

  it("refuses a lock the request builder had to drop", () => {
    const issue = moveRequestIssue(
      build({
        trips: [trip("t1", null)],
        droppedLocks: [{ tripId: "t1", vehicleId: "vsl_gre", vehicleLabel: "VSL Grenoble", reason: "Véhicule indisponible ce jour\u00a0: Chauffeur absent le mardi" }],
      }),
      MOVE,
    );
    expect(shown(issue)).toBe(
      "VSL Grenoble ne peut pas recevoir la course de Jeanne Martin\u00a0: Véhicule indisponible ce jour\u00a0: Chauffeur absent le mardi.",
    );
  });

  it("detects a trip cancelled or locked elsewhere meanwhile", () => {
    expect(shown(moveRequestIssue(build({ trips: [trip("t2", null)] }), MOVE))).toBe(
      "La course de Jeanne Martin n'est plus à planifier (annulée entre-temps\u202f?).",
    );
    expect(shown(moveRequestIssue(build({ trips: [trip("t1", "taxi_mrs")] }), MOVE))).toMatch(/autre véhicule entre-temps/);
  });
});

describe("movePlacementIssue", () => {
  const plan = (routes: PlanRoute[], unassigned: PlanResponse["unassigned"] = []) => ({ routes, unassigned });

  it("accepts a plan serving the trip with the target vehicle", () => {
    const served = plan([route("taxi_mrs", ["t2"]), route("vsl_gre", ["t1"])]);
    expect(plannedVehicleOf(served, "t1")).toBe("vsl_gre");
    expect(movePlacementIssue(served, MOVE, labels)).toBeNull();
  });

  it("refuses a plan leaving the moved trip unassigned, with the optimizer's reason", () => {
    const issue = movePlacementIssue(
      plan([route("taxi_mrs", ["t2"])], [{ tripId: "t1", reason: "Horaires inatteignables pour le véhicule figé VSL Grenoble." }]),
      MOVE,
      labels,
    );
    expect(shown(issue)).toBe(
      "Déplacement refusé\u00a0: VSL Grenoble ne peut pas servir la course de Jeanne Martin (Horaires inatteignables pour le véhicule figé VSL Grenoble). Le planning n'a pas été modifié.",
    );
    expect(shown(movePlacementIssue(plan([]), MOVE, labels))).toBe(
      "Déplacement refusé\u00a0: VSL Grenoble ne peut pas servir la course de Jeanne Martin. Le planning n'a pas été modifié.",
    );
  });

  it("refuses a plan placing the trip on another vehicle", () => {
    expect(shown(movePlacementIssue(plan([route("taxi_mrs", ["t1"])]), MOVE, labels))).toMatch(
      /placé la course de Jeanne Martin sur Taxi Marseille 1 et non sur VSL Grenoble/,
    );
  });
});

describe("patient names and technical records (OptimizationRun.error)", () => {
  const plan = (routes: PlanRoute[], unassigned: PlanResponse["unassigned"] = []) => ({ routes, unassigned });

  it("stores the trip id, never the patient's name, whatever the refusal", () => {
    const stored = [
      movePlacementIssue(plan([route("taxi_mrs", ["t1"])]), MOVE, labels),
      movePlacementIssue(plan([], [{ tripId: "t1", reason: "Horaires inatteignables." }]), MOVE, labels),
      movePlacementIssue(plan([]), MOVE, labels),
      moveRequestIssue(build({ trips: [trip("t2", null)] }), MOVE),
      moveRequestIssue(build({ trips: [trip("t1", "taxi_mrs")] }), MOVE),
      moveRequestIssue(build({ trips: [trip("t2", null)], excludedTrips: [{ tripId: "t1", reason: "Sans heure" }] }), MOVE),
    ];
    for (const message of stored) {
      expect(message).not.toBeNull();
      expect(message).not.toMatch(/Jeanne|Martin/);
      expect(message).toContain(tripRef("t1"));
    }
  });

  it("resolves a reference to the patient's name, or to «\u202fune course\u202f» once the trip is gone", () => {
    expect(resolveTripRefs(`${tripRef("t1")} a été figée ailleurs.`, () => "Jeanne Martin")).toBe(
      "La course de Jeanne Martin a été figée ailleurs.",
    );
    expect(resolveTripRefs(`Refusé\u00a0: ${tripRef("cmabc_123")} ailleurs.`, () => null)).toBe("Refusé\u00a0: une course ailleurs.");
    // A message without reference (every other run error) is left as is.
    expect(resolveTripRefs("aucune solution trouvée", () => "X")).toBe("aucune solution trouvée");
  });

  it("names the leg when it is known, and lists the trips a message refers to", () => {
    const text = `${tripRef("a")} et ${tripRef("b")}, puis ${tripRef("a")}`;
    expect(tripRefIds(text)).toEqual(["a", "b"]);
    const legs: Record<string, TripName> = {
      a: { patient: "René Espitalier", direction: "OUTBOUND" },
      b: { patient: "René Espitalier", direction: "RETURN" },
    };
    expect(resolveTripRefs(text, (id) => legs[id] ?? null)).toBe(
      "L'aller de René Espitalier et le retour de René Espitalier, puis l'aller de René Espitalier",
    );
    expect(resolveTripRefs(tripRef("c"), () => ({ patient: "Jeanne Martin", direction: null }))).toBe("La course de Jeanne Martin");
  });
});
