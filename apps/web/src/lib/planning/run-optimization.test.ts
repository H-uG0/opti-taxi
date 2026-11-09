import { beforeEach, describe, expect, it, vi } from "vitest";
import { tripRef, type MoveTarget } from "./move";

// « Déplacer vers… » end to end against fakes: a refused move leaves its FAILED
// run with the trip named by its id (OptimizationRun.error is a technical
// column a patient's anonymisation would not reach), while the regulator reads
// the patient's name. Swapping the stored and the shown message fails here.
const fake = vi.hoisted(() => ({
  db: {
    route: { count: vi.fn() },
    trip: { count: vi.fn() },
    routeStop: { count: vi.fn() },
    optimizationRun: { findMany: vi.fn(), updateMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  },
  build: vi.fn(),
  optimize: vi.fn(),
  savePlan: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: fake.db }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/log", () => ({ logError: vi.fn() }));
vi.mock("@/lib/domain/settings", () => ({ getSettings: vi.fn() }));
vi.mock("@/lib/optimizer/client", () => ({ optimize: fake.optimize }));
vi.mock("@/lib/optimizer/build-request", () => ({
  loadOptimizeInput: vi.fn(async () => ({ settings: { solverTimeLimitSec: 10 } })),
  buildOptimizeRequest: fake.build,
  isStaleRun: () => false,
}));
vi.mock("@/lib/optimizer/persist", () => ({
  FIELD_TRIP_STATUSES: ["PICKED_UP", "DROPPED_OFF"],
  PlanBlockedError: class PlanBlockedError extends Error {},
  replanBlockReason: () => null,
  savePlan: fake.savePlan,
}));

const { runOptimization } = await import("./run-optimization");

const DATE = "2099-03-02";
const PATIENT = "Jeanne Martin";
const MOVE: MoveTarget = { tripId: "t1", vehicleId: "vsl_gre", vehicleLabel: "VSL Grenoble", patientName: PATIENT };
const REGULATOR = { id: "u-reg", role: "REGULATOR" as const };

function build(overrides: { excludedTrips?: { tripId: string; reason: string }[] } = {}) {
  return {
    request: {
      settings: { timeLimitSec: 10 },
      vehicles: [
        { id: "vsl_gre", label: "VSL Grenoble" },
        { id: "taxi_mrs", label: "Taxi Marseille 1" },
      ],
      trips: [
        { id: "t1", lockedVehicleId: "vsl_gre" },
        { id: "t2", lockedVehicleId: null },
      ],
    },
    excludedTrips: overrides.excludedTrips ?? [],
    droppedLocks: [],
    crews: [],
  };
}

/** A plan that serves the moved trip with another vehicle than the one asked. */
function planIgnoringTheMove() {
  const stop = (kind: "PICKUP" | "DROPOFF") => ({ tripId: "t1", kind });
  return {
    status: "OK",
    routes: [{ vehicleId: "taxi_mrs", stops: [stop("PICKUP"), stop("DROPOFF")] }],
    unassigned: [{ tripId: "t2", reason: "Hors des horaires du chauffeur." }],
    kpis: { tripsServed: 1, tripsTotal: 2 },
    validation: { valid: true, violations: [] },
    meta: { matrixSource: "haversine", trafficSource: "none", wallTimeMs: 1200 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.db.route.count.mockResolvedValue(0);
  fake.db.trip.count.mockResolvedValue(0);
  fake.db.routeStop.count.mockResolvedValue(0);
  fake.db.optimizationRun.findMany.mockResolvedValue([]);
  fake.db.optimizationRun.create.mockResolvedValue({ id: "run-1" });
  fake.db.optimizationRun.update.mockResolvedValue({});
  fake.build.mockReturnValue(build());
  fake.optimize.mockResolvedValue({ ok: true, data: planIgnoringTheMove() });
});

describe("runOptimization with a move", () => {
  it("stores the refused move with the trip's id and shows it with the patient's name", async () => {
    const outcome = await runOptimization(DATE, REGULATOR, { move: MOVE });

    expect(fake.savePlan).not.toHaveBeenCalled();
    expect(fake.db.optimizationRun.update).toHaveBeenCalledTimes(1);
    const stored = fake.db.optimizationRun.update.mock.calls[0]![0] as { where: { id: string }; data: { status: string; error: string } };
    expect(stored.where).toEqual({ id: "run-1" });
    expect(stored.data.status).toBe("FAILED");
    expect(stored.data.error).toContain(tripRef("t1"));
    expect(stored.data.error).toContain("Taxi Marseille 1");
    expect(stored.data.error).not.toContain(PATIENT);

    expect(outcome).toMatchObject({ ok: false, moveRejected: true });
    const shown = (outcome as { error: string }).error;
    expect(shown).toContain(`la course de ${PATIENT}`);
    expect(shown).not.toContain("{course:");
  });

  it("refuses a move the request cannot carry before any run is stored", async () => {
    fake.build.mockReturnValue(build({ excludedTrips: [{ tripId: "t1", reason: "Adresse de prise en charge manquante." }] }));
    const outcome = await runOptimization(DATE, REGULATOR, { move: MOVE });

    expect(outcome).toMatchObject({ ok: false, moveRejected: true });
    expect((outcome as { error: string }).error).toMatch(new RegExp(`^La course de ${PATIENT} est incomplète`));
    expect(fake.db.optimizationRun.create).not.toHaveBeenCalled();
    expect(fake.db.optimizationRun.update).not.toHaveBeenCalled();
    expect(fake.optimize).not.toHaveBeenCalled();
  });
});
