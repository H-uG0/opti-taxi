import { beforeEach, describe, expect, it, vi } from "vitest";
import { tripRef, type MoveTarget } from "./move";

// « Déplacer vers… » end to end against fakes: a refused move leaves its FAILED
// run with the trip named by its id (OptimizationRun.error is a technical
// column a patient's anonymisation would not reach), while the regulator reads
// the patient's name. Swapping the stored and the shown message fails here.
const fake = vi.hoisted(() => ({
  db: {
    route: { count: vi.fn() },
    routeStop: { count: vi.fn() },
    optimizationRun: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    trip: { count: vi.fn(), updateMany: vi.fn() },
    // Interactive transactions run against the same fakes; the advisory lock is a no-op.
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
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
vi.mock("@/lib/optimizer/client", () => ({ optimize: fake.optimize, evaluate: vi.fn() }));
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

const { confirmPendingRun, discardPendingRun, runOptimization } = await import("./run-optimization");
const { requestHash } = await import("./version");

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
    tariffGaps: [],
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
  fake.db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(fake.db));
  fake.db.$executeRaw.mockResolvedValue(1);
  fake.db.optimizationRun.updateMany.mockResolvedValue({ count: 1 });
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

describe("two computations of the same date", () => {
  it("checks for a running computation and creates the run under the planning lock of the date", async () => {
    const order: string[] = [];
    fake.db.$executeRaw.mockImplementation(async () => {
      order.push("lock");
      return 1;
    });
    fake.db.optimizationRun.findMany.mockImplementation(async ({ where }: { where: { status: string } }) => {
      order.push(where.status === "RUNNING" ? "check" : "drop pending");
      return [];
    });
    fake.db.optimizationRun.create.mockImplementation(async () => {
      order.push("create");
      return { id: "run-1" };
    });
    fake.savePlan.mockResolvedValue({ routes: 1, served: 1, unassigned: 1 });
    await runOptimization(DATE, REGULATOR);
    expect(order).toEqual(["lock", "check", "drop pending", "create"]);
    expect(fake.db.$transaction).toHaveBeenCalled();
  });

  it("the second click finds the first run and starts nothing", async () => {
    fake.db.optimizationRun.findMany.mockResolvedValue([{ id: "run-0", startedAt: new Date(), tripsCount: 2 }]);
    const outcome = await runOptimization(DATE, REGULATOR);
    expect(outcome).toMatchObject({ ok: false, error: expect.stringMatching(/optimisation de cette date est en cours/) });
    expect(fake.db.optimizationRun.create).not.toHaveBeenCalled();
    expect(fake.optimize).not.toHaveBeenCalled();
  });
});

/** savePlan as the guard sees it: called with the comparison of the new plan with the routes in place. */
function savePlanComparing(comparison: unknown, version = "v1", tx: unknown = fake.db) {
  fake.savePlan.mockImplementation(async (_db: unknown, args: { check?: (c: unknown) => unknown }) => {
    await args.check?.({ tx, comparison, version });
    return { routes: 1, served: 1, unassigned: 1, comparison };
  });
}

const figures = (served: number, violations = 0) => ({ served, violations, revenue: 200, margin: 80, km: 120 });

describe("never replacing the routes in place silently with a worse plan", () => {
  beforeEach(() => {
    fake.optimize.mockResolvedValue({ ok: true, data: { ...planIgnoringTheMove(), routes: [] } });
  });

  it("keeps a plan serving fewer trips waiting for confirmation, with what to save later", async () => {
    savePlanComparing({ current: figures(2), next: figures(1, 2), lostTripIds: ["t2"] });
    const outcome = await runOptimization(DATE, REGULATOR);

    expect(outcome).toMatchObject({ ok: false, needsConfirmation: true });
    expect((outcome as { error: string }).error).toBe(
      "Ce calcul sert 1 course contre 2 dans le planning actuel, avec 2 violations de contraintes (aucune actuellement) : remplacer quand même ?",
    );
    const stored = fake.db.optimizationRun.update.mock.calls.at(-1)![0] as {
      data: { status: string; details: { pending: { requestHash: string; basedOnVersion: string; move: unknown }; question: string } };
    };
    expect(stored.data.status).toBe("AWAITING_CONFIRMATION");
    expect(stored.data.details.pending).toMatchObject({ requestHash: requestHash(build().request), basedOnVersion: "v1", move: null });
    expect(stored.data.details.question).toMatch(/remplacer quand même/);
  });

  it("saves an equal or better plan at once", async () => {
    savePlanComparing({ current: figures(2), next: figures(2), lostTripIds: [] });
    expect(await runOptimization(DATE, REGULATOR)).toMatchObject({ ok: true });
  });

  it("refuses a move that would leave other trips without a vehicle, naming them by id only", async () => {
    const stop = (kind: "PICKUP" | "DROPOFF") => ({ tripId: "t1", kind });
    fake.optimize.mockResolvedValue({
      ok: true,
      data: { ...planIgnoringTheMove(), routes: [{ vehicleId: "vsl_gre", stops: [stop("PICKUP"), stop("DROPOFF")] }] },
    });
    savePlanComparing({ current: figures(2), next: figures(1), lostTripIds: ["t2"] });
    const outcome = await runOptimization(DATE, REGULATOR, { move: MOVE });

    expect(outcome).toMatchObject({ ok: false, moveRejected: true });
    expect((outcome as { error: string }).error).toMatch(/laisserait sans véhicule 1 autre course/);
    const stored = fake.db.optimizationRun.update.mock.calls.at(-1)![0] as { data: { status: string; error: string } };
    expect(stored.data.status).toBe("FAILED");
    expect(stored.data.error).toContain(tripRef("t2"));
    expect(stored.data.error).not.toContain(PATIENT);
  });
});

describe("a plan waiting for confirmation", () => {
  const pendingRun = (overrides: { requestHash?: string; status?: string } = {}) => ({
    id: "run-p",
    serviceDate: new Date(`${DATE}T00:00:00Z`),
    status: overrides.status ?? "AWAITING_CONFIRMATION",
    kpis: null,
    details: {
      solverStatus: "OK",
      violations: [],
      warnings: [],
      unassigned: [],
      kind: "optimize",
      pending: {
        response: {
          status: "OK",
          routes: [],
          trips: [],
          unassigned: [],
          kpis: {
            tripsTotal: 2,
            tripsServed: 1,
            tripsUnassigned: 1,
            vehiclesUsed: 1,
            tripsPerVehicle: 1,
            totalKm: 10,
            emptyKm: 2,
            emptyKmRatio: 0.2,
            sharedTrips: 0,
            sharedTripRatio: 0,
            revenue: 20,
            cost: 10,
            margin: 10,
          },
          validation: { valid: true, violations: [] },
          meta: { matrixSource: "haversine", trafficSource: "none", solverStatus: "OK", objective: null, wallTimeMs: 10, warnings: [] },
        },
        requestHash: overrides.requestHash ?? requestHash(build().request),
        basedOnVersion: "v1",
        move: null,
      },
    },
  });

  it("is saved by « Remplacer quand même » when neither the data nor the plan changed", async () => {
    fake.db.optimizationRun.findUnique.mockImplementation(async (args: { select: { serviceDate?: boolean } }) =>
      args.select.serviceDate ? pendingRun() : { status: "AWAITING_CONFIRMATION" },
    );
    savePlanComparing({ current: figures(2), next: figures(1), lostTripIds: ["t2"] });
    const outcome = await confirmPendingRun("run-p", REGULATOR);
    expect(outcome).toMatchObject({ ok: true, message: expect.stringMatching(/^Nouveau planning enregistré/) });
  });

  it("is dropped when the day's data changed since the computation", async () => {
    fake.db.optimizationRun.findUnique.mockResolvedValue(pendingRun({ requestHash: "other" }));
    const outcome = await confirmPendingRun("run-p", REGULATOR);
    expect(outcome).toMatchObject({ ok: false, error: expect.stringMatching(/données du jour ont changé/) });
    expect(fake.savePlan).not.toHaveBeenCalled();
    expect(fake.db.optimizationRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "run-p", status: "AWAITING_CONFIRMATION" }, data: expect.objectContaining({ status: "FAILED" }) }),
    );
  });

  it("is not saved when the routes in place changed since the comparison", async () => {
    fake.db.optimizationRun.findUnique.mockImplementation(async (args: { select: { serviceDate?: boolean } }) =>
      args.select.serviceDate ? pendingRun() : { status: "AWAITING_CONFIRMATION" },
    );
    savePlanComparing({ current: figures(2), next: figures(1), lostTripIds: [] }, "v2");
    const outcome = await confirmPendingRun("run-p", REGULATOR);
    expect(outcome).toMatchObject({ ok: false, error: expect.stringMatching(/planning en place a changé/) });
  });

  it("is refused once handled elsewhere, and can be discarded once", async () => {
    fake.db.optimizationRun.findUnique.mockResolvedValue(pendingRun({ status: "FAILED" }));
    expect(await confirmPendingRun("run-p", REGULATOR)).toMatchObject({ ok: false, error: expect.stringMatching(/n'attend plus/) });

    fake.db.optimizationRun.findUnique.mockResolvedValue(pendingRun());
    const trace = vi.fn(async () => {});
    expect(await discardPendingRun("run-p", trace)).toBe(true);
    expect(trace).toHaveBeenCalledWith(fake.db, DATE);
    const dropped = fake.db.optimizationRun.updateMany.mock.calls.at(-1)![0] as { data: { details: object } };
    expect(dropped.data.details).not.toHaveProperty("pending");
  });
});
