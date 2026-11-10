import { beforeEach, describe, expect, it, vi } from "vitest";
import { tripRef, type MoveTarget } from "./move";

// « Déplacer vers… » end to end against fakes: a refused move leaves its FAILED
// run with the trip named by its id (OptimizationRun.error is a technical
// column a patient's anonymisation would not reach), while the regulator reads
// the patient's name. Swapping the stored and the shown message fails here.
const fake = vi.hoisted(() => ({
  db: {
    route: { count: vi.fn(), findMany: vi.fn() },
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
  auditRead: vi.fn(),
  completeTrips: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: fake.db }));
vi.mock("@/lib/audit", () => ({ audit: fake.audit, auditRead: fake.auditRead }));
vi.mock("@/lib/log", () => ({ logError: vi.fn() }));
vi.mock("@/lib/domain/settings", () => ({ getSettings: vi.fn() }));
vi.mock("@/lib/optimizer/client", () => ({ optimize: fake.optimize, evaluate: fake.evaluate }));
vi.mock("@/lib/optimizer/build-request", () => ({
  loadOptimizeInput: fake.loadInput,
  buildOptimizeRequest: fake.build,
  isStaleRun: () => false,
}));
vi.mock("@/lib/trips/completion", () => ({ completeTrips: fake.completeTrips }));
vi.mock("@/lib/optimizer/persist", () => ({
  FIELD_TRIP_STATUSES: ["PICKED_UP", "DROPPED_OFF"],
  PlanBlockedError: class PlanBlockedError extends Error {},
  replanBlockReason: () => null,
  savePlan: fake.savePlan,
}));

const {
  confirmPendingRun,
  discardPendingRun,
  incompleteOnlyError,
  NO_ROUTES_TO_KEEP_ERROR,
  NOTHING_TO_PLACE_ERROR,
  previewPendingSelection,
  restorePreviousPlan,
  reviewedChanges,
  runOptimization,
  SELECTION_CHANGED_ERROR,
  withdrawLapsedProposals,
} = await import("./run-optimization");
const { planVersionToken, requestHash } = await import("./version");

const DATE = "2099-03-02";
const PATIENT = "MARTIN Jeanne";
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
  fake.db.route.findMany.mockResolvedValue([]);
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

describe("trips completed before the computation", () => {
  it("creates the missing recurring trips of the date before loading the request", async () => {
    const order: string[] = [];
    fake.completeTrips.mockImplementation(async (_tx: unknown, _user: unknown, range: unknown) => {
      order.push(`complete ${JSON.stringify(range)}`);
      return { created: 2, revived: 0, createdByDay: new Map(), skipped: [] };
    });
    fake.loadInput.mockImplementation(async () => {
      order.push("load");
      return input();
    });
    fake.savePlan.mockResolvedValue({ routes: 1, served: 1, unassigned: 1 });

    await runOptimization(DATE, REGULATOR);

    expect(order.slice(0, 2)).toEqual([`complete {"from":"${DATE}","to":"${DATE}"}`, "load"]);
    expect(fake.completeTrips.mock.calls[0]?.[1]).toBe(REGULATOR);
  });

  it("goes on with the trips in place when completing them fails", async () => {
    fake.completeTrips.mockRejectedValue(new Error("database time-out"));
    fake.savePlan.mockResolvedValue({ routes: 1, served: 1, unassigned: 1 });

    const outcome = await runOptimization(DATE, REGULATOR);

    expect(fake.loadInput).toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
  });

  it("never completes a past day", async () => {
    await runOptimization("2020-01-06", REGULATOR);
    expect(fake.completeTrips).not.toHaveBeenCalled();
  });
});

describe("the routes in place as the optimizer's start", () => {
  it("sends the routes in place, stops in order, on the vehicles and trips of the request", async () => {
    fake.db.route.findMany.mockResolvedValue([
      {
        vehicleId: "taxi_mrs",
        stops: [
          { tripId: "t2", kind: "DROPOFF", sequence: 2 },
          { tripId: "t2", kind: "PICKUP", sequence: 1 },
          { tripId: "gone", kind: "PICKUP", sequence: 3 },
          { tripId: "gone", kind: "DROPOFF", sequence: 4 },
        ],
      },
      {
        vehicleId: "vehicle_off_today",
        stops: [
          { tripId: "t1", kind: "PICKUP", sequence: 1 },
          { tripId: "t1", kind: "DROPOFF", sequence: 2 },
        ],
      },
    ]);
    fake.savePlan.mockResolvedValue({ routes: 1, served: 1, unassigned: 1 });

    await runOptimization(DATE, REGULATOR);

    const sent = fake.optimize.mock.calls[0]![0] as { initialRoutes?: unknown; trips: unknown[] };
    expect(sent.initialRoutes).toEqual([
      { vehicleId: "taxi_mrs", stops: [{ tripId: "t2", kind: "PICKUP" }, { tripId: "t2", kind: "DROPOFF" }] },
    ]);
    expect(sent.trips).toEqual(build().request.trips);
    // The plan is saved with the request the day's data builds, without the routes in place.
    const saved = fake.savePlan.mock.calls[0]![1] as { request: Record<string, unknown> };
    expect(saved.request).not.toHaveProperty("initialRoutes");
  });

  it("starts from scratch when the date has no routes, or when reading them fails", async () => {
    fake.savePlan.mockResolvedValue({ routes: 1, served: 1, unassigned: 1 });
    await runOptimization(DATE, REGULATOR);
    expect(fake.optimize.mock.calls[0]![0]).not.toHaveProperty("initialRoutes");

    fake.db.route.findMany.mockRejectedValue(new Error("database time-out"));
    const outcome = await runOptimization(DATE, REGULATOR);
    expect(fake.optimize.mock.calls[1]![0]).not.toHaveProperty("initialRoutes");
    expect(outcome.ok).toBe(true);
  });

  const stops = (tripId: string) => [
    { tripId, kind: "PICKUP", sequence: 1 },
    { tripId, kind: "DROPOFF", sequence: 2 },
  ];

  it("says so when the computation gave back the routes in place", async () => {
    // planIgnoringTheMove: taxi_mrs takes t1, as in place.
    fake.db.route.findMany.mockResolvedValue([{ vehicleId: "taxi_mrs", stops: stops("t1") }]);
    fake.savePlan.mockResolvedValue({ routes: 1, served: 1, unassigned: 1 });
    const outcome = await runOptimization(DATE, REGULATOR);
    expect(outcome).toMatchObject({
      ok: true,
      message: expect.stringMatching(/^Planning en place conservé, aucun meilleur trouvé\u00a0: 1\/2 courses servies · 1 tournée · calcul/),
    });
  });

  it("names how many routes changed, and those taken off", async () => {
    const route = (vehicleId: string, tripId: string) => ({
      vehicleId,
      stops: [
        { tripId, kind: "PICKUP" },
        { tripId, kind: "DROPOFF" },
      ],
    });
    fake.optimize.mockResolvedValue({ ok: true, data: { ...planIgnoringTheMove(), routes: [route("taxi_mrs", "t1"), route("vsl_gre", "t2")] } });
    fake.db.route.findMany.mockResolvedValue([{ vehicleId: "taxi_mrs", stops: stops("t1") }]);
    fake.savePlan.mockResolvedValue({ routes: 2, served: 2, unassigned: 0 });
    const changed = await runOptimization(DATE, REGULATOR);
    expect(changed).toMatchObject({ ok: true, message: expect.stringMatching(/^Planning optimisé\u00a0: 2\/2 courses servies · 2 tournées dont 1 modifiée · calcul/) });

    fake.optimize.mockResolvedValue({ ok: true, data: { ...planIgnoringTheMove(), routes: [route("taxi_mrs", "t1")] } });
    fake.db.route.findMany.mockResolvedValue([
      { vehicleId: "taxi_mrs", stops: stops("t1") },
      { vehicleId: "vsl_gre", stops: stops("t2") },
    ]);
    fake.savePlan.mockResolvedValue({ routes: 1, served: 1, unassigned: 1 });
    const removed = await runOptimization(DATE, REGULATOR);
    expect(removed).toMatchObject({
      ok: true,
      message: expect.stringMatching(/^Planning optimisé\u00a0: 1\/2 courses servies · 1 tournée inchangée · 1 tournée retirée · calcul/),
    });
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
      "Ce calcul sert 1 course contre 2 dans le planning actuel, avec 2 violations de contraintes (aucune actuellement)\u00a0: remplacer quand même\u202f?",
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

  it("holds a move that would leave other trips without a vehicle, naming them (by id only in the run)", async () => {
    const stop = (kind: "PICKUP" | "DROPOFF") => ({ tripId: "t1", kind });
    fake.optimize.mockResolvedValue({
      ok: true,
      data: { ...planIgnoringTheMove(), routes: [{ vehicleId: "vsl_gre", stops: [stop("PICKUP"), stop("DROPOFF")] }] },
    });
    savePlanComparing({ current: figures(2), next: figures(1), lostTripIds: ["t2"] });
    fake.db.trip.findMany.mockResolvedValue([{ id: "t2", direction: "RETURN", patient: { firstName: "Paul", lastName: "Durand" } }]);
    // The plan version, read around the undo of the move's lock while the plan waits.
    const version = { routes: 2, routesAt: new Date("2026-11-09T08:00:00Z"), stops: 8, trips: 4, tripsAt: new Date("2026-11-09T08:00:00Z") };
    fake.db.$queryRaw.mockResolvedValue([version]);
    const outcome = await runOptimization(DATE, REGULATOR, { move: { ...MOVE, previousLock: null } });

    // Not refused any more (a full re-solve often swaps a trip): the regulator decides, knowing which patients.
    expect(outcome).toMatchObject({ ok: false, needsConfirmation: true });
    expect((outcome as { error: string }).error).toMatch(
      /laisserait sans véhicule 1 autre course \(le retour de DURAND Paul\)\. Ce calcul sert 1 course contre 2/,
    );
    const stored = fake.db.optimizationRun.update.mock.calls.at(-1)![0] as { data: { status: string; details: unknown } };
    expect(stored.data.status).toBe("AWAITING_CONFIRMATION");
    const details = JSON.stringify(stored.data.details);
    expect(details).toContain(tripRef("t2"));
    expect(details).not.toContain(PATIENT);
    expect(details).not.toContain("Durand");
    // The move's lock is undone while the plan waits, and set again if the regulator confirms.
    expect(fake.db.trip.updateMany).toHaveBeenCalledWith({ where: { id: "t1", lockedVehicleId: "vsl_gre" }, data: { lockedVehicleId: null } });
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
      `Déplacement de la course de ${PATIENT} vers VSL Grenoble\u00a0: ce calcul sert 1 course contre 2 dans le planning actuel\u00a0: remplacer quand même\u202f?`,
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

describe("«\u202fRevenir au planning précédent\u202f» after a move", () => {
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

  it("is saved by «\u202fRemplacer quand même\u202f» when neither the data nor the plan changed", async () => {
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

describe("withdrawLapsedProposals (recours exceptionnel)", () => {
  it("clears and traces the proposals no longer locked on an ambulance, and keeps the ones in force", async () => {
    const at = new Date("2026-11-02T17:00:00Z");
    const seated = ["TAXI", "VSL"];
    fake.db.trip.findMany.mockResolvedValue([
      { id: "kept", exceptionalAmbulanceAt: at, lockedVehicleId: "amb", allowedVehicleTypes: seated, lockedVehicle: { type: "AMBULANCE" } },
      { id: "unlocked", exceptionalAmbulanceAt: at, lockedVehicleId: null, allowedVehicleTypes: seated, lockedVehicle: null },
      { id: "moved", exceptionalAmbulanceAt: at, lockedVehicleId: "vsl", allowedVehicleTypes: seated, lockedVehicle: { type: "VSL" } },
      { id: "lying", exceptionalAmbulanceAt: at, lockedVehicleId: "amb", allowedVehicleTypes: ["AMBULANCE"], lockedVehicle: { type: "AMBULANCE" } },
    ]);
    const tx = fake.db as unknown as Parameters<typeof withdrawLapsedProposals>[0];
    await withdrawLapsedProposals(tx, REGULATOR, DATE);
    expect(fake.db.trip.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["unlocked", "moved", "lying"] }, exceptionalAmbulanceAt: { not: null } },
      data: { exceptionalAmbulanceAt: null, exceptionalAmbulanceById: null },
    });
    const events = fake.audit.mock.calls[0]![2] as { action: string; entityId: string }[];
    expect(events.map((e) => [e.action, e.entityId])).toEqual([
      ["trip.exceptional_ambulance_withdrawn", "unlocked"],
      ["trip.exceptional_ambulance_withdrawn", "moved"],
      ["trip.exceptional_ambulance_withdrawn", "lying"],
    ]);
  });

  it("writes nothing when every proposal still holds", async () => {
    fake.db.trip.findMany.mockResolvedValue([]);
    await withdrawLapsedProposals(fake.db as unknown as Parameters<typeof withdrawLapsedProposals>[0], REGULATOR, DATE);
    expect(fake.db.trip.updateMany).not.toHaveBeenCalled();
    expect(fake.audit).not.toHaveBeenCalled();
  });
});

describe("«\u202fPlacer les non affectées\u202f» (runOptimization placeOnly)", () => {
  /** The request as the day's input builds it: its trips with their locks (pins included). */
  const buildFromInput = (day: { trips: Array<{ id: string; lockedVehicleId: string | null }> }) => ({
    ...build(),
    request: { ...build().request, trips: day.trips.map((t) => ({ id: t.id, lockedVehicleId: t.lockedVehicleId })) },
  });
  /** t2 is in the route of taxi_mrs, t1 has no vehicle. */
  const assigned = [{ id: "t2", route: { vehicleId: "taxi_mrs" } }];

  beforeEach(() => {
    fake.build.mockImplementation(buildFromInput);
    fake.db.trip.findMany.mockImplementation(async (args: { where: { routeId?: unknown } }) => (args.where.routeId ? assigned : []));
    fake.db.route.findMany.mockResolvedValue([
      {
        vehicleId: "taxi_mrs",
        stops: [
          { tripId: "t2", kind: "PICKUP", sequence: 1 },
          { tripId: "t2", kind: "DROPOFF", sequence: 2 },
        ],
      },
    ]);
  });

  it("sends the trips in a route locked on its vehicle for this computation only, and names what it placed", async () => {
    const route = (vehicleId: string, tripId: string) => ({ vehicleId, stops: [{ tripId, kind: "PICKUP" }, { tripId, kind: "DROPOFF" }] });
    fake.optimize.mockResolvedValue({
      ok: true,
      data: { ...planIgnoringTheMove(), routes: [route("taxi_mrs", "t2"), route("vsl_gre", "t1")], unassigned: [] },
    });
    savePlanComparing({ current: figures(1), next: figures(2), lostTripIds: [] });

    const outcome = await runOptimization(DATE, REGULATOR, { placeOnly: true });

    const sent = fake.optimize.mock.calls[0]![0] as { trips: Array<{ id: string; lockedVehicleId: string | null }> };
    expect(sent.trips).toEqual([
      { id: "t1", lockedVehicleId: null },
      { id: "t2", lockedVehicleId: "taxi_mrs" },
    ]);
    // Nothing written on the trips: the pin lives in the request only.
    expect(fake.db.trip.updateMany).not.toHaveBeenCalled();
    // The run counts the regulator's locks, not the pins.
    expect(fake.db.optimizationRun.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lockedCount: 0 }) }));
    // Saved with the regulator's locks only (the pins are not locks).
    expect(fake.savePlan.mock.calls[0]![1]).toMatchObject({ kind: "place", lockedCount: 0 });
    expect(fake.audit).toHaveBeenCalledWith(
      expect.anything(),
      REGULATOR,
      expect.objectContaining({ action: "plan.optimize", details: { mode: "place_unassigned" } }),
    );
    expect(outcome).toMatchObject({
      ok: true,
      message: expect.stringMatching(/^1 course placée sur 1 non affectée, les autres courses restent sur leur véhicule\u00a0: /),
    });
  });

  it("keeps a lock the regulator set, even on another vehicle", async () => {
    fake.loadInput.mockResolvedValue(input({ t2: "vsl_gre" }));
    savePlanComparing({ current: figures(1), next: figures(1), lostTripIds: [] });
    await runOptimization(DATE, REGULATOR, { placeOnly: true });
    const sent = fake.optimize.mock.calls[0]![0] as { trips: Array<{ id: string; lockedVehicleId: string | null }> };
    expect(sent.trips.find((t) => t.id === "t2")?.lockedVehicleId).toBe("vsl_gre");
    expect(fake.db.optimizationRun.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lockedCount: 1 }) }));
  });

  it("refuses without routes in place, or without a trip to place, before any run", async () => {
    fake.db.trip.findMany.mockResolvedValue([]);
    expect(await runOptimization(DATE, REGULATOR, { placeOnly: true })).toEqual({ ok: false, error: NO_ROUTES_TO_KEEP_ERROR });

    fake.db.trip.findMany.mockResolvedValue([...assigned, { id: "t1", route: { vehicleId: "vsl_gre" } }]);
    expect(await runOptimization(DATE, REGULATOR, { placeOnly: true })).toEqual({ ok: false, error: NOTHING_TO_PLACE_ERROR });

    // The only trip without a vehicle is incomplete (never sent to the optimizer): said as such.
    fake.db.trip.findMany.mockImplementation(async (args: { where: { routeId?: unknown } }) => (args.where.routeId ? assigned : []));
    fake.build.mockImplementation((day: { trips: Array<{ id: string; lockedVehicleId: string | null }> }) => ({
      ...buildFromInput({ trips: day.trips.filter((t) => t.id !== "t1") }),
      excludedTrips: [{ tripId: "t1", reason: "Aller sans heure de rendez-vous" }],
    }));
    const incomplete = await runOptimization(DATE, REGULATOR, { placeOnly: true });
    expect(incomplete).toEqual({ ok: false, error: incompleteOnlyError(1) });
    expect((incomplete as { error: string }).error).toMatch(/est incomplète \(voir «\u202fÀ traiter\u202f»\)/);
    expect(fake.db.optimizationRun.create).not.toHaveBeenCalled();
    expect(fake.optimize).not.toHaveBeenCalled();
  });

  it("never takes a trip served in place off its vehicle: the run fails, the planning stays, the trip is named", async () => {
    // t1 placed, but pinned t2 dropped: as many trips served as before, so no other rule would object.
    const route = (vehicleId: string, tripId: string) => ({ vehicleId, stops: [{ tripId, kind: "PICKUP" }, { tripId, kind: "DROPOFF" }] });
    fake.optimize.mockResolvedValue({
      ok: true,
      data: { ...planIgnoringTheMove(), routes: [route("vsl_gre", "t1")], unassigned: [{ tripId: "t2", reason: "Hors horaires." }] },
    });
    savePlanComparing({ current: figures(1), next: figures(1), lostTripIds: ["t2"] });
    fake.db.trip.findMany.mockImplementation(async (args: { where: { routeId?: unknown; id?: unknown } }) =>
      args.where.routeId ? assigned : [{ id: "t2", direction: "RETURN", patient: { firstName: "Paul", lastName: "Durand" } }],
    );

    const outcome = await runOptimization(DATE, REGULATOR, { placeOnly: true });

    expect(outcome).toEqual({
      ok: false,
      error:
        "Planning inchangé\u00a0: ce placement aurait retiré 1 course déjà placée de son véhicule (le retour de DURAND Paul). " +
        "Placez les courses non affectées une à une avec «\u202fOù placer cette course\u202f?\u202f», ou réoptimisez la journée.",
    });
    // Not offered for confirmation either: the run is closed as not kept, with the trip by id only.
    const stored = fake.db.optimizationRun.update.mock.calls.at(-1)![0] as { data: { status: string; error: string; details: { kind: string } } };
    expect(stored.data.status).toBe("FAILED");
    expect(stored.data.error).toMatch(/^Calcul non retenu\u00a0: ce placement aurait retiré 1 course déjà placée/);
    // Its kind is kept: the page says « Placement des non affectées … non retenu ».
    expect(stored.data.details.kind).toBe("place");
    expect(stored.data.error).toContain(tripRef("t2"));
    expect(stored.data.error).not.toContain("Durand");
    expect(fake.db.optimizationRun.update.mock.calls.some((call) => (call[0] as { data: { status: string } }).data.status === "AWAITING_CONFIRMATION")).toBe(
      false,
    );
  });

  it("says when a trip already placed changed vehicle, or a trip found no place, and flags it to look at", async () => {
    const route = (vehicleId: string, ...tripIds: string[]) => ({
      vehicleId,
      stops: tripIds.flatMap((tripId) => [
        { tripId, kind: "PICKUP" },
        { tripId, kind: "DROPOFF" },
      ]),
    });
    // t2's route vehicle could no longer take it (its pin dropped): it went to vsl_gre; t1 found no place.
    fake.optimize.mockResolvedValue({
      ok: true,
      data: { ...planIgnoringTheMove(), routes: [route("vsl_gre", "t2")], unassigned: [{ tripId: "t1", reason: "Hors horaires." }] },
    });
    savePlanComparing({ current: figures(1), next: figures(1), lostTripIds: [] });
    const outcome = await runOptimization(DATE, REGULATOR, { placeOnly: true });
    expect(outcome).toMatchObject({
      ok: true,
      warning: true,
      message: expect.stringMatching(
        /^La course non affectée n'a pas trouvé de place, 1 course déjà placée change de véhicule \(figée ailleurs ou véhicule indisponible\)\u00a0: /,
      ),
    });
  });

  it("waits for confirmation like any computation, and is confirmed with the same pins", async () => {
    fake.optimize.mockResolvedValue({ ok: true, data: { ...planIgnoringTheMove(), routes: [] } });
    // Nothing lost, but a much lower margin: the regulator decides, keeping the planning being the first choice.
    savePlanComparing({ current: figures(2), next: { ...figures(2), margin: 10 }, lostTripIds: [] });
    const outcome = await runOptimization(DATE, REGULATOR, { placeOnly: true });
    expect(outcome).toMatchObject({ ok: false, needsConfirmation: true });
    expect((outcome as { error: string }).error).toMatch(/^Ce placement dégage une marge de/);
    const stored = fake.db.optimizationRun.update.mock.calls.at(-1)![0] as {
      data: { details: Record<string, unknown> & { kind: string; pending: { placeOnly?: boolean; requestHash: string } } };
    };
    expect(stored.data.details.kind).toBe("place");
    expect(stored.data.details.pending.placeOnly).toBe(true);
    // Hashed with the pins: a confirmation that forgot them would find « the day's data changed ».
    expect(stored.data.details.pending.requestHash).toBe(
      requestHash(buildFromInput({ trips: [{ id: "t1", lockedVehicleId: null }, { id: "t2", lockedVehicleId: "taxi_mrs" }] }).request),
    );

    fake.db.optimizationRun.findUnique.mockImplementation(async (args: { select: { serviceDate?: boolean } }) =>
      args.select.serviceDate
        ? {
            id: "run-1",
            serviceDate: new Date(`${DATE}T00:00:00Z`),
            status: "AWAITING_CONFIRMATION",
            finishedAt: null,
            kpis: null,
            // As stored by a real computation (the fake plan above has no solver status nor warnings).
            details: {
              ...stored.data.details,
              solverStatus: "OK",
              warnings: [],
              pending: { ...stored.data.details.pending, response: planResponse() },
            },
          }
        : { status: "AWAITING_CONFIRMATION" },
    );
    savePlanComparing({ current: figures(2), next: { ...figures(2), margin: 10 }, lostTripIds: [] });
    const confirmed = await confirmPendingRun("run-1", REGULATOR);
    // Said as it is: the plan confirmed placed nothing.
    expect(confirmed).toMatchObject({
      ok: true,
      warning: true,
      message: expect.stringMatching(/^La course non affectée n'a pas trouvé de place, les autres courses restent sur leur véhicule\u00a0: /),
    });
    expect(fake.savePlan.mock.calls.at(-1)![1]).toMatchObject({ kind: "place", lockedCount: 0 });
    expect(fake.audit).toHaveBeenLastCalledWith(
      expect.anything(),
      REGULATOR,
      expect.objectContaining({ action: "plan.optimize", details: { confirmed: true, mode: "place_unassigned" } }),
    );

    // A placement held before the rule, that would take a trip off its vehicle, is dropped, never confirmed.
    fake.savePlan.mockClear();
    savePlanComparing({ current: figures(2), next: figures(1), lostTripIds: ["t2"] });
    const refused = await confirmPendingRun("run-1", REGULATOR);
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/^Calcul non retenu\u00a0: ce placement aurait retiré 1 course déjà placée/) });
    expect(fake.db.optimizationRun.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { id: "run-1", status: "AWAITING_CONFIRMATION" }, data: expect.objectContaining({ status: "FAILED" }) }),
    );
  });
});

describe("what a re-optimization changes, shown before it is saved (INS-02)", () => {
  const vehicleChange = (tripId: string, from = "taxi_mrs", to = "vsl_gre") => ({ tripId, kind: "vehicle" as const, from, to, fromPickupMinute: 480, toPickupMinute: 485 });
  const routeChange = (vehicleId: string) => ({ vehicleId, before: { trips: 2, km: 30, margin: 20 }, after: { trips: 1, km: 20, margin: 25 } });

  /** savePlan as the guard sees it, with what the new plan changes in the routes in place. */
  function savePlanChanging(changes: unknown, comparison: unknown = { current: figures(2), next: figures(2), lostTripIds: [] }) {
    fake.savePlan.mockImplementation(async (client: Client, args: { check?: (c: unknown) => unknown }) =>
      client.$transaction(async (tx) => {
        await args.check?.({ tx, comparison, version: "v1", changes });
        return { routes: 2, served: 2, unassigned: 0, comparison };
      }),
    );
  }

  it("holds a re-optimization that changes trips, with its changes kept for the « Changements » list", async () => {
    const changes = { trips: [vehicleChange("t2")], routes: [routeChange("taxi_mrs"), routeChange("vsl_gre")] };
    savePlanChanging(changes);
    const outcome = await runOptimization(DATE, REGULATOR);
    expect(outcome).toEqual({
      ok: false,
      needsConfirmation: true,
      error:
        "Ce calcul change 1 course du planning en place\u00a0: 1 course change de véhicule. Vérifiez la liste «\u202fChangements\u202f», puis enregistrez tout ou véhicule par véhicule.",
    });
    const stored = fake.db.optimizationRun.update.mock.calls.at(-1)![0] as { data: { status: string; details: Record<string, unknown> } };
    expect(stored.data.status).toBe("AWAITING_CONFIRMATION");
    expect(stored.data.details).toMatchObject({ review: true, changes, kind: "optimize" });
    expect(stored.data.details.pending).toMatchObject({ basedOnVersion: "v1", lockChange: null });
  });

  it("saves at once when no trip changes vehicle, moves by 10 min or more, nor loses its vehicle", async () => {
    savePlanChanging({ trips: [], routes: [routeChange("taxi_mrs")] });
    expect(await runOptimization(DATE, REGULATOR)).toMatchObject({ ok: true });
    // First computation of the day: nothing in place to compare with.
    savePlanChanging(null);
    expect(await runOptimization(DATE, REGULATOR)).toMatchObject({ ok: true });
  });

  it("keeps the regulator's question when the plan is worse, with its changes", async () => {
    const changes = { trips: [{ ...vehicleChange("t2"), kind: "unassigned" as const, to: null, toPickupMinute: null }], routes: [routeChange("taxi_mrs")] };
    savePlanChanging(changes, { current: figures(2), next: figures(1), lostTripIds: ["t2"] });
    const outcome = await runOptimization(DATE, REGULATOR);
    expect((outcome as { error: string }).error).toMatch(/^Ce calcul sert 1 course contre 2/);
    const stored = fake.db.optimizationRun.update.mock.calls.at(-1)![0] as { data: { details: Record<string, unknown> } };
    expect(stored.data.details.changes).toEqual(changes);
    expect(stored.data.details).not.toHaveProperty("review");
  });

  it("reviews a move for the other trips only, a placement for the trips already placed, never a restoration", () => {
    const changes = {
      trips: [vehicleChange("t1"), vehicleChange("t2"), { ...vehicleChange("t9"), kind: "assigned" as const, from: null, fromPickupMinute: null }],
      routes: [],
    };
    expect(reviewedChanges("optimize", changes)?.trips.map((c) => c.tripId)).toEqual(["t1", "t2", "t9"]);
    expect(reviewedChanges("move", changes, { movedTripId: "t1" })?.trips.map((c) => c.tripId)).toEqual(["t2", "t9"]);
    expect(reviewedChanges("place", changes, { toPlace: new Set(["t9"]) })?.trips.map((c) => c.tripId)).toEqual(["t1", "t2"]);
    expect(reviewedChanges("restore", changes)).toBeNull();
  });

  it("holds a move whose computation changes other trips, naming them as « Changements »", async () => {
    const stop = (kind: "PICKUP" | "DROPOFF") => ({ tripId: "t1", kind });
    fake.optimize.mockResolvedValue({
      ok: true,
      data: { ...planIgnoringTheMove(), routes: [{ vehicleId: "vsl_gre", stops: [stop("PICKUP"), stop("DROPOFF")] }] },
    });
    savePlanChanging({ trips: [vehicleChange("t1")], routes: [routeChange("vsl_gre")] });
    expect(await runOptimization(DATE, REGULATOR, { move: MOVE })).toMatchObject({ ok: true });
    savePlanChanging({ trips: [vehicleChange("t1"), vehicleChange("t2")], routes: [routeChange("vsl_gre")] });
    const outcome = await runOptimization(DATE, REGULATOR, { move: MOVE });
    expect(outcome).toMatchObject({ ok: false, needsConfirmation: true });
    expect((outcome as { error: string }).error).toBe(
      `Déplacement de la course de ${PATIENT} vers VSL Grenoble\u00a0: le nouveau calcul change aussi 1 autre course du planning en place (1 course change de véhicule). Vérifiez la liste «\u202fChangements\u202f» avant de l'enregistrer.`,
    );
  });
});

describe("« accepter véhicule par véhicule » (INS-02)", () => {
  const stop = (tripId: string, kind: "PICKUP" | "DROPOFF") => ({
    tripId,
    kind,
    location: { lat: 45.1, lng: 5.7 },
    arrivalMin: 480,
    startMin: 480,
    departureMin: 482,
    loadAfter: kind === "PICKUP" ? 1 : 0,
  });
  const route = (vehicleId: string, trips: string[]) => ({
    vehicleId,
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
    stops: trips.flatMap((t) => [stop(t, "PICKUP"), stop(t, "DROPOFF")]),
  });
  const versionParts = { routes: 2, routesAt: new Date("2026-11-09T08:00:00Z"), stops: 4, trips: 2, tripsAt: new Date("2026-11-09T08:00:00Z") };
  // In place: taxi_mrs t1, vsl_gre t2. The computation swaps them.
  const pending = () => ({
    finishedAt: null,
    id: "run-p",
    serviceDate: new Date(`${DATE}T00:00:00Z`),
    status: "AWAITING_CONFIRMATION",
    kpis: null,
    details: {
      solverStatus: "OK",
      violations: [],
      warnings: [],
      unassigned: [],
      kind: "optimize",
      review: true,
      comparison: { current: figures(2), next: figures(2), lostTripIds: [] },
      changes: {
        trips: [
          { tripId: "t1", kind: "vehicle", from: "taxi_mrs", to: "vsl_gre", fromPickupMinute: 480, toPickupMinute: 480 },
          { tripId: "t2", kind: "vehicle", from: "vsl_gre", to: "taxi_mrs", fromPickupMinute: 480, toPickupMinute: 480 },
        ],
        routes: [
          { vehicleId: "taxi_mrs", before: { trips: 1, km: 20, margin: 20 }, after: { trips: 1, km: 20, margin: 20 } },
          { vehicleId: "vsl_gre", before: { trips: 1, km: 20, margin: 20 }, after: { trips: 1, km: 20, margin: 20 } },
        ],
      },
      pending: {
        response: planResponse([route("taxi_mrs", ["t2"]), route("vsl_gre", ["t1"])]),
        requestHash: requestHash(build().request),
        basedOnVersion: planVersionToken(versionParts),
        lockChange: null,
      },
    },
  });
  const storedStops = (trips: string[]) => trips.flatMap((t, i) => [
    { tripId: t, kind: "PICKUP", sequence: 2 * i },
    { tripId: t, kind: "DROPOFF", sequence: 2 * i + 1 },
  ]);

  beforeEach(() => {
    // Values queued by earlier tests (the plan version around a move's undo) are not this test's.
    fake.db.$queryRaw.mockReset();
    fake.db.optimizationRun.findUnique.mockReset();
    fake.db.optimizationRun.findUnique.mockImplementation(async (args: { select: { serviceDate?: boolean } }) =>
      args.select.serviceDate ? pending() : { status: "AWAITING_CONFIRMATION" },
    );
    fake.db.route.findMany.mockResolvedValue([
      { vehicleId: "taxi_mrs", stops: storedStops(["t1"]) },
      { vehicleId: "vsl_gre", stops: storedStops(["t2"]) },
    ]);
    fake.db.$queryRaw.mockResolvedValue([versionParts]);
    fake.db.trip.findMany.mockResolvedValue([
      { id: "t1", direction: "OUTBOUND", appointmentMinute: 540, readyMinute: null, patient: { firstName: "Jeanne", lastName: "Martin" } },
      { id: "t2", direction: "RETURN", appointmentMinute: null, readyMinute: 660, patient: { firstName: "Paul", lastName: "Durand" } },
    ]);
    // /evaluate gives back the routes it is given, timed.
    fake.evaluate.mockImplementation(async (request: { routes: { vehicleId: string; stops: { tripId: string }[] }[] }) => ({
      ok: true,
      data: {
        ...planResponse(request.routes.map((r) => route(r.vehicleId, [...new Set(r.stops.map((s) => s.tripId))]))),
        trips: ["t1", "t2"].map((id) => ({ tripId: id, vehicleId: request.routes.find((r) => r.stops.some((s) => s.tripId === id))?.vehicleId ?? null })),
      },
    }));
  });

  it("checks the day a selection makes with /evaluate: the refused vehicle keeps its route, a trip on none is said", async () => {
    const outcome = await previewPendingSelection("run-p", ["vsl_gre"], REGULATOR);
    const sent = fake.evaluate.mock.calls[0]![0] as { routes: { vehicleId: string; stops: { tripId: string; kind: string }[] }[] };
    // VSL Grenoble keeps t2; t2 leaves the taxi's new route; t1, on the VSL in the new plan only, is left out.
    expect(sent.routes).toEqual([
      { vehicleId: "vsl_gre", stops: [{ tripId: "t2", kind: "PICKUP" }, { tripId: "t2", kind: "DROPOFF" }] },
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.preview).toMatchObject({
      refused: ["VSL Grenoble"],
      keptOnRefused: ["DURAND Paul (retour, fin 11:00) reste sur VSL Grenoble (au lieu de Taxi Marseille 1)"],
      leftOut: ["MARTIN Jeanne (aller, RDV 09:00) (sur Taxi Marseille 1 actuellement, sur VSL Grenoble dans le calcul)"],
      hint: "Pour qu'elle garde un véhicule, cochez aussi VSL Grenoble, ou décochez Taxi Marseille 1.",
    });
    expect(outcome.preview.selection.served).toBe(1);
    expect(outcome.preview.question).toMatch(/^Cette sélection sert 1 course contre 2/);
    // Its answer names patients of the run's date: traced as a read of that day's plan.
    expect(fake.auditRead).toHaveBeenCalledWith(REGULATOR, { action: "plan.view", entity: "Route", entityId: null, serviceDate: DATE });
  });

  it("saves the day checked, the refused vehicles noted, and refuses a selection changed since", async () => {
    const checked = await previewPendingSelection("run-p", ["vsl_gre"], REGULATOR);
    const key = checked.ok ? checked.preview.key : "";
    savePlanComparing({ current: figures(2), next: figures(1), lostTripIds: ["t1"] }, planVersionToken(versionParts));
    expect(await confirmPendingRun("run-p", REGULATOR, { refusedVehicleIds: ["vsl_gre"], key: "other" })).toEqual({
      ok: false,
      error: SELECTION_CHANGED_ERROR,
    });
    // Vehicles none of which can keep their route: refused, never the whole plan saved instead.
    expect(await confirmPendingRun("run-p", REGULATOR, { refusedVehicleIds: ["taxi_nowhere"], key })).toEqual({
      ok: false,
      error: SELECTION_CHANGED_ERROR,
    });
    expect(fake.savePlan).not.toHaveBeenCalled();
    const outcome = await confirmPendingRun("run-p", REGULATOR, { refusedVehicleIds: ["vsl_gre"], key });
    expect(outcome).toMatchObject({ ok: true, message: expect.stringMatching(/^Sélection enregistrée\u00a0: 1 véhicule garde sa tournée · /) });
    const saved = fake.savePlan.mock.calls[0]![1] as { response: { routes: { vehicleId: string }[] }; refusedVehicleIds: string[] };
    expect(saved.response.routes.map((r) => r.vehicleId)).toEqual(["vsl_gre"]);
    expect(saved.refusedVehicleIds).toEqual(["vsl_gre"]);
    expect(fake.audit.mock.calls[0]![2]).toMatchObject({ action: "plan.optimize", details: { confirmed: true, refusedVehicleIds: ["vsl_gre"] } });
  });

  it("is offered for a re-optimization only, and on the plan it was computed on", async () => {
    fake.db.optimizationRun.findUnique.mockResolvedValue({ ...pending(), details: { ...pending().details, kind: "move" } });
    expect(await previewPendingSelection("run-p", ["vsl_gre"], REGULATOR)).toMatchObject({ ok: false, error: expect.stringMatching(/s'enregistre en entier/) });
    fake.db.optimizationRun.findUnique.mockResolvedValue(pending());
    fake.db.$queryRaw.mockResolvedValue([{ ...versionParts, stops: 6 }]);
    expect(await previewPendingSelection("run-p", ["vsl_gre"], REGULATOR)).toMatchObject({ ok: false, stale: true });
    expect(fake.evaluate).not.toHaveBeenCalled();
  });
});
