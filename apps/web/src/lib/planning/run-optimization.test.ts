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
    trip: { count: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    // Interactive transactions run against the same fakes; the advisory lock is a no-op.
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    // The plan version (version.ts loadPlanVersion).
    $queryRaw: vi.fn(),
  },
  loadInput: vi.fn(),
  build: vi.fn(),
  optimize: vi.fn(),
  evaluate: vi.fn(),
  savePlan: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: fake.db }));
vi.mock("@/lib/audit", () => ({ audit: fake.audit }));
vi.mock("@/lib/log", () => ({ logError: vi.fn() }));
vi.mock("@/lib/domain/settings", () => ({ getSettings: vi.fn() }));
vi.mock("@/lib/optimizer/client", () => ({ optimize: fake.optimize, evaluate: fake.evaluate }));
vi.mock("@/lib/optimizer/build-request", () => ({
  loadOptimizeInput: fake.loadInput,
  buildOptimizeRequest: fake.build,
  isStaleRun: () => false,
}));
vi.mock("@/lib/optimizer/persist", () => ({
  FIELD_TRIP_STATUSES: ["PICKED_UP", "DROPPED_OFF"],
  PlanBlockedError: class PlanBlockedError extends Error {},
  replanBlockReason: () => null,
  savePlan: fake.savePlan,
}));

const { confirmPendingRun, discardPendingRun, restorePreviousPlan, runOptimization } = await import("./run-optimization");
const { planVersionToken, requestHash } = await import("./version");

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

/** A plan response the contract accepts (a plan waiting for confirmation is re-read with it), with `routes`. */
function planResponse(routes: unknown[] = []) {
  return {
    status: "OK",
    routes,
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

/** The day's trips as loaded (locks as in the database). */
function input(locks: Record<string, string | null> = {}) {
  return {
    settings: { solverTimeLimitSec: 10 },
    trips: [
      { id: "t1", lockedVehicleId: locks.t1 ?? null },
      { id: "t2", lockedVehicleId: locks.t2 ?? null },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.loadInput.mockResolvedValue(input());
  fake.db.trip.updateMany.mockResolvedValue({ count: 1 });
  fake.db.trip.findMany.mockResolvedValue([]);
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

type Client = { $transaction: (work: (tx: unknown) => Promise<unknown>) => Promise<unknown> };

/**
 * savePlan as the guard sees it: in a transaction of the client it is given
 * (the caller's writes added to it run too), called with the comparison of
 * the new plan with the routes in place, at plan version `version`.
 */
function savePlanComparing(comparison: unknown, version = "v1") {
  fake.savePlan.mockImplementation(async (client: Client, args: { check?: (c: unknown) => unknown }) =>
    client.$transaction(async (tx) => {
      await args.check?.({ tx, comparison, version });
      return { routes: 1, served: 1, unassigned: 1, comparison };
    }),
  );
}

/** Audit actions written, in order. */
const audited = () => fake.audit.mock.calls.map((call) => (call[2] as { action: string }).action);

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
      data: { status: string; details: { pending: { requestHash: string; basedOnVersion: string; lockChange: unknown }; question: string } };
    };
    expect(stored.data.status).toBe("AWAITING_CONFIRMATION");
    expect(stored.data.details.pending).toMatchObject({ requestHash: requestHash(build().request), basedOnVersion: "v1", lockChange: null });
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
    fake.db.trip.findMany.mockResolvedValue([{ id: "t2", direction: "RETURN", patient: { firstName: "Paul", lastName: "Durand" } }]);
    const outcome = await runOptimization(DATE, REGULATOR, { move: { ...MOVE, previousLock: null } });

    expect(outcome).toMatchObject({ ok: false, moveRejected: true });
    // Every trip named, with its leg: the regulator can tell which patients the move would leave out.
    expect((outcome as { error: string }).error).toMatch(/laisserait sans véhicule 1 autre course \(le retour de Paul Durand\)/);
    const stored = fake.db.optimizationRun.update.mock.calls.at(-1)![0] as { data: { status: string; error: string } };
    expect(stored.data.status).toBe("FAILED");
    expect(stored.data.error).toContain(tripRef("t2"));
    expect(stored.data.error).not.toContain(PATIENT);
    expect(stored.data.error).not.toContain("Durand");
    // The lock the move set is put back.
    expect(fake.db.trip.updateMany).toHaveBeenCalledWith({ where: { id: "t1", lockedVehicleId: "vsl_gre" }, data: { lockedVehicleId: null } });
    expect(audited()).toEqual(["trip.unlock"]);
  });

  it("does not blame a move for trips the computation was not given: they wait for confirmation", async () => {
    const stop = (kind: "PICKUP" | "DROPOFF") => ({ tripId: "t1", kind });
    fake.optimize.mockResolvedValue({
      ok: true,
      data: { ...planIgnoringTheMove(), routes: [{ vehicleId: "vsl_gre", stops: [stop("PICKUP"), stop("DROPOFF")] }] },
    });
    // t9 is no longer sent to the optimizer (incomplete since): any new plan loses it.
    savePlanComparing({ current: figures(2), next: figures(1), lostTripIds: ["t9"] });
    const outcome = await runOptimization(DATE, REGULATOR, { move: MOVE });
    expect(outcome).toMatchObject({ ok: false, needsConfirmation: true });
    expect((outcome as { error: string }).error).toBe(
      `Déplacement de la course de ${PATIENT} vers VSL Grenoble : ce calcul sert 1 course contre 2 dans le planning actuel : remplacer quand même ?`,
    );
  });
});

describe("a move whose plan waits for confirmation", () => {
  /** Plan version parts before and after the undo of the move's lock (Trip.updatedAt moves). */
  const parts = (at: string) => ({ routes: 2, routesAt: new Date(at), stops: 8, trips: 4, tripsAt: new Date(at) });
  const before = parts("2026-11-09T08:00:00Z");
  const after = parts("2026-11-09T08:00:05Z");

  beforeEach(() => {
    const stop = (kind: "PICKUP" | "DROPOFF") => ({
      tripId: "t1",
      kind,
      location: { lat: 45.1, lng: 5.7 },
      arrivalMin: 480,
      startMin: 480,
      departureMin: 482,
      loadAfter: kind === "PICKUP" ? 1 : 0,
    });
    const route = {
      vehicleId: "vsl_gre",
      startMin: 470,
      endMin: 540,
      distanceKm: 20,
      emptyKm: 5,
      loadedKm: 15,
      durationMin: 70,
      revenue: 40,
      cost: 20,
      margin: 20,
      break: null,
      stops: [stop("PICKUP"), stop("DROPOFF")],
    };
    fake.optimize.mockResolvedValue({ ok: true, data: planResponse([route]) });
  });

  it("undoes the lock, compares against the version after the undo, and is confirmed with its lock set again", async () => {
    savePlanComparing({ current: figures(2), next: { ...figures(2), margin: 10 }, lostTripIds: [] }, planVersionToken(before));
    fake.db.$queryRaw.mockResolvedValueOnce([before]).mockResolvedValueOnce([after]);
    const outcome = await runOptimization(DATE, REGULATOR, { move: { ...MOVE, previousLock: null } });
    expect(outcome).toMatchObject({ ok: false, needsConfirmation: true });
    expect(fake.db.trip.updateMany).toHaveBeenCalledWith({ where: { id: "t1", lockedVehicleId: "vsl_gre" }, data: { lockedVehicleId: null } });
    expect(audited()).toEqual(["trip.unlock"]);
    const stored = fake.db.optimizationRun.update.mock.calls.at(-1)![0] as {
      data: { status: string; details: Record<string, unknown> & { pending: { basedOnVersion: string; lockChange: unknown } } };
    };
    expect(stored.data.status).toBe("AWAITING_CONFIRMATION");
    expect(stored.data.details.pending.basedOnVersion).toBe(planVersionToken(after));
    expect(stored.data.details.pending.lockChange).toEqual({ tripId: "t1", from: null, to: "vsl_gre" });

    // « Remplacer quand même »: the trip is unlocked now; the request is rebuilt with the move's lock.
    vi.clearAllMocks();
    fake.loadInput.mockResolvedValue(input({ t1: null }));
    fake.build.mockReturnValue(build());
    fake.db.trip.updateMany.mockResolvedValue({ count: 1 });
    fake.db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(fake.db));
    fake.db.route.count.mockResolvedValue(0);
    fake.db.trip.count.mockResolvedValue(0);
    fake.db.routeStop.count.mockResolvedValue(0);
    const waiting = {
      id: "run-1",
      serviceDate: new Date(`${DATE}T00:00:00Z`),
      status: "AWAITING_CONFIRMATION",
      finishedAt: null,
      kpis: null,
      details: stored.data.details,
    };
    fake.db.optimizationRun.findUnique.mockImplementation(async (args: { select: { serviceDate?: boolean } }) =>
      args.select.serviceDate ? waiting : { status: "AWAITING_CONFIRMATION" },
    );
    savePlanComparing({ current: figures(2), next: { ...figures(2), margin: 10 }, lostTripIds: [] }, planVersionToken(after));

    const confirmed = await confirmPendingRun("run-1", REGULATOR);
    expect(confirmed).toMatchObject({ ok: true });
    expect((fake.build.mock.calls[0]![0] as ReturnType<typeof input>).trips[0]).toEqual({ id: "t1", lockedVehicleId: "vsl_gre" });
    expect(fake.db.trip.updateMany).toHaveBeenCalledWith({ where: { id: "t1", lockedVehicleId: null }, data: { lockedVehicleId: "vsl_gre" } });
    expect(audited()).toEqual(["plan.optimize", "trip.move"]);
    expect(fake.savePlan.mock.calls[0]![1]).toMatchObject({ lockChange: { tripId: "t1", from: null, to: "vsl_gre" } });
  });

  it("keeps the version compared when the plan changed before the undo: the confirmation is then refused", async () => {
    savePlanComparing({ current: figures(2), next: { ...figures(2), margin: 10 }, lostTripIds: [] }, planVersionToken(before));
    fake.db.$queryRaw.mockResolvedValueOnce([parts("2026-11-09T08:00:03Z")]).mockResolvedValueOnce([after]);
    await runOptimization(DATE, REGULATOR, { move: { ...MOVE, previousLock: null } });
    const stored = fake.db.optimizationRun.update.mock.calls.at(-1)![0] as { data: { details: { pending: { basedOnVersion: string } } } };
    expect(stored.data.details.pending.basedOnVersion).toBe(planVersionToken(before));
  });
});

describe("« Revenir au planning précédent » after a move", () => {
  it("puts the lock the move had replaced back, with the routes, in the same transaction", async () => {
    const snapshot = {
      runId: "run-0",
      figures: figures(2),
      routes: [{ vehicleId: "taxi_mrs", stops: [{ tripId: "t1", kind: "PICKUP" }, { tripId: "t1", kind: "DROPOFF" }] }],
    };
    fake.db.optimizationRun.findFirst.mockResolvedValue({
      id: "run-move",
      kpis: null,
      details: {
        solverStatus: "OK",
        violations: [],
        warnings: [],
        unassigned: [],
        kind: "move",
        previous: snapshot,
        lockChange: { tripId: "t1", from: null, to: "vsl_gre" },
      },
    });
    // The move's lock is still set.
    fake.loadInput.mockResolvedValue(input({ t1: "vsl_gre" }));
    fake.evaluate.mockResolvedValue({ ok: true, data: { ...planIgnoringTheMove(), unassigned: [] } });
    savePlanComparing({ current: figures(2), next: figures(2), lostTripIds: [] });

    const outcome = await restorePreviousPlan(DATE, REGULATOR);
    expect(outcome).toMatchObject({ ok: true, message: expect.stringMatching(/^Planning précédent rétabli/) });
    // Evaluated without the move's lock: no « course figée déplacée » violation.
    expect((fake.build.mock.calls[0]![0] as ReturnType<typeof input>).trips[0]).toEqual({ id: "t1", lockedVehicleId: null });
    expect(fake.evaluate).toHaveBeenCalledWith(expect.objectContaining({ routes: snapshot.routes }));
    expect(fake.db.trip.updateMany).toHaveBeenCalledWith({ where: { id: "t1", lockedVehicleId: "vsl_gre" }, data: { lockedVehicleId: null } });
    expect(audited()).toEqual(["plan.restore", "trip.unlock"]);
    // Recorded with the plan: restoring the plan the restoration replaced locks the trip again.
    expect(fake.savePlan.mock.calls[0]![1]).toMatchObject({ kind: "restore", lockChange: { tripId: "t1", from: "vsl_gre", to: null } });
  });
});

describe("a plan waiting for confirmation", () => {
  const pendingRun = (overrides: { requestHash?: string; status?: string } = {}) => ({
    finishedAt: null,
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
        response: planResponse(),
        requestHash: overrides.requestHash ?? requestHash(build().request),
        basedOnVersion: "v1",
        lockChange: null,
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
    const order: string[] = [];
    fake.db.$executeRaw.mockImplementation(async () => {
      order.push("lock");
      return 1;
    });
    fake.db.optimizationRun.updateMany.mockImplementation(async () => {
      order.push("discard");
      return { count: 1 };
    });
    const trace = vi.fn(async () => {});
    expect(await discardPendingRun("run-p", trace)).toBe(true);
    expect(trace).toHaveBeenCalledWith(fake.db, DATE);
    // Under the planning lock of the date, as a confirmation (savePlan): never both.
    expect(order).toEqual(["lock", "discard"]);
    const dropped = fake.db.optimizationRun.updateMany.mock.calls.at(-1)![0] as { data: { details: object } };
    expect(dropped.data.details).not.toHaveProperty("pending");
  });
});
