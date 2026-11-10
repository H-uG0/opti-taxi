import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { insertResponseSchema, type InsertResponse } from "@/lib/optimizer/contract";

// The drag-and-drop draft end to end against fakes: each drop replayed on the plan in place (/insert for
// that vehicle alone, or the trip taken out), both plans evaluated, and « Enregistrer » writing only the
// routes the draft changes, the moved trips locked, one audit event per trip.
const fake = vi.hoisted(() => {
  const tx = {
    route: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
    routeStop: { deleteMany: vi.fn(), createMany: vi.fn(), update: vi.fn() },
    trip: { findMany: vi.fn(), update: vi.fn() },
    vehicle: { findMany: vi.fn() },
    optimizationRun: { findFirst: vi.fn(), update: vi.fn() },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  };
  return {
    tx,
    db: {
      route: { findMany: vi.fn() },
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    },
    loadInput: vi.fn(),
    build: vi.fn(),
    insert: vi.fn(),
    evaluate: vi.fn(),
    audit: vi.fn(),
    version: vi.fn(),
    running: vi.fn(),
    withdraw: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: fake.db }));
vi.mock("@/lib/audit", () => ({ audit: fake.audit }));
vi.mock("@/lib/optimizer/client", () => ({ insert: fake.insert, evaluate: fake.evaluate }));
vi.mock("@/lib/optimizer/build-request", () => ({
  loadOptimizeInput: fake.loadInput,
  buildOptimizeRequest: fake.build,
  personName: (p: { firstName: string; lastName: string }) => `${p.lastName.toUpperCase()} ${p.firstName}`,
}));
vi.mock("./version", () => ({ loadPlanVersion: fake.version }));
vi.mock("./run-optimization", () => ({
  optimizationInProgress: fake.running,
  OPTIMIZATION_IN_PROGRESS_ERROR: "Une optimisation de cette date est en cours.",
  PLANNING_TX_OPTIONS: {},
  withdrawLapsedProposals: fake.withdraw,
}));

const { checkDraftPlan, saveDraftPlan, DRAFT_EMPTY_ERROR, DRAFT_STALE_ERROR, DRAFT_UNASSIGNED_REASON } = await import("./draft-plan");

const DATE = "2099-03-02";
const REGULATOR = { id: "u-reg", role: "REGULATOR" as const };
const fixtures = path.resolve(__dirname, "../../../../../contract/fixtures");
const load = (name: string): unknown => JSON.parse(readFileSync(path.join(fixtures, name), "utf8"));

/** The contract's example: trip_1 without a vehicle goes beside trip_3 on the taxi. */
function answer(): InsertResponse {
  return insertResponseSchema.parse(load("insert-response.json"));
}

function stop(tripId: string, kind: "PICKUP" | "DROPOFF", sequence: number, completedAt: Date | null = null) {
  return { id: `${tripId}-${kind}`, tripId, kind, sequence, completedAt };
}

const taxiRoute = (status = "PROPOSED") => ({
  id: "route-taxi",
  vehicleId: "veh_taxi_1",
  status,
  driverId: "drv-taxi",
  crewMateId: null,
  stops: [
    stop("trip_3", "PICKUP", 0),
    stop("trip_3", "DROPOFF", 1),
    stop("trip_2", "PICKUP", 2),
    stop("trip_4", "PICKUP", 3),
    stop("trip_4", "DROPOFF", 4),
    stop("trip_2", "DROPOFF", 5),
  ],
});
const ambulanceRoute = (completedAt: Date | null = null) => ({
  id: "route-amb",
  vehicleId: "veh_amb_1",
  status: "PROPOSED",
  driverId: "drv-amb",
  crewMateId: "mate-amb",
  stops: [stop("trip_5", "PICKUP", 0, completedAt), stop("trip_5", "DROPOFF", 1)],
});

type Sequence = { vehicleId: string; stops: { tripId: string; kind: "PICKUP" | "DROPOFF" }[] };

/**
 * /evaluate as the fakes give it: the routes timed every 20 min from 06:40, each trip's result, and
 * a LOCK violation for a trip served off the vehicle it is locked on (as the optimizer's validator).
 */
function evaluated(request: { routes: Sequence[]; trips: { id: string; lockedVehicleId?: string | null }[] }) {
  const routes = request.routes.map((route) => ({
    vehicleId: route.vehicleId,
    startMin: 400,
    endMin: 400 + route.stops.length * 20,
    distanceKm: 10 * route.stops.length,
    emptyKm: 2,
    loadedKm: 10 * route.stops.length - 2,
    durationMin: route.stops.length * 20,
    revenue: 15 * route.stops.length,
    cost: 5 * route.stops.length,
    margin: 10 * route.stops.length,
    break: null,
    stops: route.stops.map((s, i) => ({
      tripId: s.tripId,
      kind: s.kind,
      location: { lat: 43.3, lng: 5.4 },
      arrivalMin: 400 + i * 20,
      startMin: 400 + i * 20,
      departureMin: 405 + i * 20,
      loadAfter: s.kind === "PICKUP" ? 1 : 0,
    })),
  }));
  const served = new Map<string, { vehicleId: string; pickupMin: number }>();
  for (const route of routes) for (const s of route.stops) if (s.kind === "PICKUP") served.set(s.tripId, { vehicleId: route.vehicleId, pickupMin: s.startMin });
  const violations = request.trips.flatMap((t) => {
    const at = served.get(t.id);
    return t.lockedVehicleId && at && at.vehicleId !== t.lockedVehicleId
      ? [{ code: "LOCK", message: `Course ${t.id} figée sur ${t.lockedVehicleId} mais placée sur ${at.vehicleId}`, tripId: t.id, vehicleId: at.vehicleId }]
      : [];
  });
  return {
    status: "OK",
    routes,
    trips: request.trips.map((t) => {
      const at = served.get(t.id);
      return {
        tripId: t.id,
        vehicleId: at?.vehicleId ?? null,
        pickupMin: at?.pickupMin ?? null,
        dropoffMin: at ? at.pickupMin + 10 : null,
        shared: false,
        coPassengerTripIds: [],
        directKm: 5,
        rideKm: at ? 5 : 0,
        detourKm: 0,
        revenue: at ? 30 : 0,
        waitAtFacilityMin: at ? 5 : null,
      };
    }),
    unassigned: request.trips.filter((t) => !served.has(t.id)).map((t) => ({ tripId: t.id, reason: "Non affectée" })),
    kpis: {},
    validation: { valid: violations.length === 0, violations },
    meta: { matrixSource: "haversine", trafficSource: "none", solverStatus: "EVALUATE", objective: null, wallTimeMs: 3, warnings: [] },
  };
}

function setUp(routes: unknown[] = [taxiRoute(), ambulanceRoute()]) {
  const request = load("insert-request.json") as Record<string, unknown>;
  fake.db.route.findMany.mockResolvedValue(routes);
  fake.loadInput.mockResolvedValue({
    trips: ["trip_1", "trip_2", "trip_3", "trip_4", "trip_5", "trip_6", "trip_7"].map((id) => ({
      id,
      status: id === "trip_1" ? "PLANNED" : "ASSIGNED",
      lockedVehicleId: id === "trip_3" ? "veh_taxi_1" : null,
    })),
    vehicles: [],
  });
  fake.build.mockReturnValue({
    request: { date: DATE, settings: request.settings, vehicles: request.vehicles, trips: request.trips, tariffs: request.tariffs },
    crews: new Map([
      ["veh_taxi_1", { driverId: "drv-taxi", crewMateId: null }],
      ["veh_vsl_1", { driverId: "drv-vsl", crewMateId: null }],
      ["veh_amb_1", { driverId: "drv-amb", crewMateId: "mate-amb" }],
    ]),
    excludedTrips: [],
    droppedLocks: [],
    skippedVehicles: [],
  });
  fake.insert.mockResolvedValue({ ok: true, data: answer() });
  fake.evaluate.mockImplementation(async (req: { routes: Sequence[]; trips: { id: string }[] }) => ({ ok: true, data: evaluated(req) }));
  fake.version.mockResolvedValue("v-1");
  fake.running.mockResolvedValue(false);
  fake.tx.route.findMany.mockImplementation(async (args: { where: { id?: unknown; serviceDate?: unknown } }) =>
    args.where.serviceDate ? [{ status: "PROPOSED" }, { status: "PROPOSED" }] : [taxiRoute()],
  );
  fake.tx.trip.findMany.mockResolvedValue(
    ["trip_1", "trip_2", "trip_3", "trip_4"].map((id) => ({
      id,
      status: id === "trip_1" ? "PLANNED" : "ASSIGNED",
      sharingStatus: "NOT_PROPOSED",
      pickupAddress: `départ ${id}`,
      dropoffAddress: `arrivée ${id}`,
    })),
  );
  fake.tx.vehicle.findMany.mockResolvedValue([{ id: "veh_taxi_1", type: "TAXI" }]);
  fake.tx.route.create.mockResolvedValue({ id: "route-new" });
  fake.tx.route.findFirst.mockResolvedValue(null);
  fake.tx.optimizationRun.findFirst.mockResolvedValue({
    id: "run-1",
    details: { solverStatus: "OK", violations: [], warnings: [], unassigned: [{ tripId: "trip_1", reason: "Non affectée" }] },
  });
}

/** The day's request with these trips locked (trip → vehicle), as « Déplacer vers… », « Figer » or a saved draft leave them. */
function lockTrips(locks: Record<string, string>) {
  const built = fake.build();
  const request = built.request as { trips: { id: string; lockedVehicleId?: string | null }[] };
  fake.build.mockReturnValue({
    ...built,
    request: { ...request, trips: request.trips.map((t) => (t.id in locks ? { ...t, lockedVehicleId: locks[t.id] } : t)) },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setUp();
});

describe("checkDraftPlan", () => {
  it("places a dropped trip with /insert for that vehicle alone, and evaluates the plan in place and the draft", async () => {
    const outcome = await checkDraftPlan(DATE, [{ tripId: "trip_1", toVehicleId: "veh_taxi_1" }]);
    const sent = fake.insert.mock.calls[0]![0] as { tripId: string; vehicleIds: string[]; routes: Sequence[] };
    expect(sent.tripId).toBe("trip_1");
    expect(sent.vehicleIds).toEqual(["veh_taxi_1"]);
    expect(sent.routes.map((r) => r.vehicleId)).toEqual(["veh_taxi_1", "veh_amb_1"]);
    expect(sent).not.toHaveProperty("initialRoutes");
    const [before, after] = fake.evaluate.mock.calls.map((c) => c[0] as { routes: Sequence[] });
    expect(before!.routes).toEqual(sent.routes);
    expect(after!.routes.find((r) => r.vehicleId === "veh_taxi_1")!.stops.map((s) => `${s.tripId}/${s.kind}`).slice(0, 3)).toEqual([
      "trip_1/PICKUP",
      "trip_3/PICKUP",
      "trip_1/DROPOFF",
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const { view } = outcome;
    expect(view.version).toBe("v-1");
    expect(view.moves).toEqual([
      { tripId: "trip_1", toVehicleId: "veh_taxi_1", fromVehicleId: null, ok: true, pickupMinute: 368, dropoffMinute: 420, deltaKm: 0.03, deltaMargin: 33.93 },
    ]);
    // Only the taxi's route changes; the trips of that route and the trip placed get their draft results.
    expect(view.routes.map((r) => r.vehicleId)).toEqual(["veh_taxi_1"]);
    expect(view.trips.find((t) => t.tripId === "trip_1")).toMatchObject({ vehicleId: "veh_taxi_1", pickupMinute: 400 });
    expect(view.trips.some((t) => t.tripId === "trip_5")).toBe(false);
    expect(view.before.served).toBe(4);
    expect(view.after.served).toBe(5);
    expect(view.newViolations).toEqual([]);
    expect(view.question).toBeNull();
  });

  it("refuses a drop the vehicle cannot take, with why, and leaves the plan as it was", async () => {
    fake.insert.mockResolvedValue({
      ok: true,
      data: { ...answer(), options: [], rejected: [{ vehicleId: "veh_vsl_1", kind: "BREAK", reason: "est en pause de 12:00 à 12:45" }] },
    });
    const outcome = await checkDraftPlan(DATE, [{ tripId: "trip_1", toVehicleId: "veh_vsl_1" }]);
    expect(outcome.ok && outcome.view.moves).toEqual([
      { tripId: "trip_1", toVehicleId: "veh_vsl_1", fromVehicleId: null, ok: false, reason: "VSL 1 (Sisteron) est en pause de 12:00 à 12:45." },
    ]);
    expect(outcome.ok && outcome.view.routes).toEqual([]);
  });

  it("takes a trip dropped on « À placer » out of its route, without /insert", async () => {
    const outcome = await checkDraftPlan(DATE, [{ tripId: "trip_3", toVehicleId: null }]);
    expect(fake.insert).not.toHaveBeenCalled();
    const after = fake.evaluate.mock.calls[1]![0] as { routes: Sequence[] };
    expect(after.routes.find((r) => r.vehicleId === "veh_taxi_1")!.stops.some((s) => s.tripId === "trip_3")).toBe(false);
    expect(outcome.ok && outcome.view.moves[0]).toMatchObject({ tripId: "trip_3", toVehicleId: null, fromVehicleId: "veh_taxi_1", ok: true });
    expect(outcome.ok && outcome.view.trips.find((t) => t.tripId === "trip_3")).toMatchObject({ vehicleId: null });
  });

  it("never moves a trip out of a route under way, nor onto one", async () => {
    setUp([taxiRoute(), ambulanceRoute(new Date())]);
    const outcome = await checkDraftPlan(DATE, [
      { tripId: "trip_5", toVehicleId: null },
      { tripId: "trip_1", toVehicleId: "veh_amb_1" },
    ]);
    expect(outcome.ok && outcome.view.moves.map((m) => (m.ok ? "ok" : m.reason))).toEqual([
      "Cette course ne peut pas quitter sa tournée\u00a0: Ambulance 1 (Gap) a une tournée commencée, qui ne change plus en cours de journée.",
      "Ambulance 1 (Gap) a une tournée commencée, qui ne change plus en cours de journée.",
    ]);
    expect(fake.insert).not.toHaveBeenCalled();
  });

  it("moves a trip locked elsewhere with its lock: no LOCK violation in the draft, the later moves see the new locks", async () => {
    lockTrips({ trip_1: "veh_vsl_1", trip_3: "veh_taxi_1" });
    const outcome = await checkDraftPlan(DATE, [
      { tripId: "trip_3", toVehicleId: null },
      { tripId: "trip_1", toVehicleId: "veh_taxi_1" },
    ]);
    const sent = fake.insert.mock.calls[0]![0] as { trips: { id: string; lockedVehicleId: string | null }[] };
    // trip_3, put in « À placer » first, is unlocked for the next move (/insert lifts the lock of the trip it places itself).
    expect(sent.trips.find((t) => t.id === "trip_3")!.lockedVehicleId).toBeNull();
    const [before, after] = fake.evaluate.mock.calls.map((c) => c[0] as { trips: { id: string; lockedVehicleId: string | null }[] });
    expect(before!.trips.find((t) => t.id === "trip_1")!.lockedVehicleId).toBe("veh_vsl_1");
    expect(after!.trips.find((t) => t.id === "trip_1")!.lockedVehicleId).toBe("veh_taxi_1");
    expect(outcome.ok && outcome.view.moves.every((m) => m.ok)).toBe(true);
    expect(outcome.ok && outcome.view.newViolations).toEqual([]);
  });

  it("says the optimizer's error, and refuses a past date", async () => {
    fake.evaluate.mockResolvedValue({ ok: false, error: "Le service d'optimisation ne répond pas." });
    expect(await checkDraftPlan(DATE, [{ tripId: "trip_3", toVehicleId: null }])).toEqual({ ok: false, error: "Le service d'optimisation ne répond pas." });
    expect(await checkDraftPlan("2020-01-02", [{ tripId: "trip_3", toVehicleId: null }])).toMatchObject({ ok: false, error: expect.stringMatching(/est passé/) });
  });
});

describe("saveDraftPlan", () => {
  it("writes only the routes the draft changes, locks the moved trip, traces it, on the version shown", async () => {
    const outcome = await saveDraftPlan(DATE, "v-1", [{ tripId: "trip_1", toVehicleId: "veh_taxi_1" }], null, REGULATOR);
    expect(outcome).toMatchObject({ ok: true, message: expect.stringMatching(/^Modification enregistrée, course figée sur son nouveau véhicule\u00a0: 1 tournée réécrite, les autres inchangées/) });
    // Row locks on the taxi's route only.
    const locked = fake.tx.$queryRaw.mock.calls.map((c) => c.slice(1));
    expect(locked).toEqual([[["route-taxi"]], [["route-taxi"]]]);
    expect(fake.tx.route.update).toHaveBeenCalledTimes(1);
    expect(fake.tx.route.update.mock.calls[0]![0]).toMatchObject({ where: { id: "route-taxi" }, data: { startMinute: 400, matrixSource: "haversine" } });
    // The stops that stay keep their ids; only trip_1's two stops are created.
    expect(fake.tx.routeStop.deleteMany).not.toHaveBeenCalled();
    const created = fake.tx.routeStop.createMany.mock.calls[0]![0] as { data: { tripId: string }[] };
    expect(created.data.map((s) => s.tripId)).toEqual(["trip_1", "trip_1"]);
    const placed = fake.tx.trip.update.mock.calls.find((c) => (c[0] as { where: { id: string } }).where.id === "trip_1")![0] as { data: Record<string, unknown> };
    expect(placed.data).toMatchObject({ routeId: "route-taxi", lockedVehicleId: "veh_taxi_1", status: "ASSIGNED" });
    const other = fake.tx.trip.update.mock.calls.find((c) => (c[0] as { where: { id: string } }).where.id === "trip_3")![0] as { data: Record<string, unknown> };
    expect(other.data.lockedVehicleId).toBeUndefined();
    expect(fake.audit).toHaveBeenCalledWith(fake.tx, REGULATOR, [
      {
        action: "trip.move",
        entity: "Trip",
        entityId: "trip_1",
        serviceDate: DATE,
        details: { mode: "draft", vehicleId: { from: null, to: "veh_taxi_1" }, lockedVehicleId: { from: null, to: "veh_taxi_1" } },
      },
    ]);
    expect(fake.tx.optimizationRun.update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: { valid: true, details: expect.objectContaining({ violations: [], unassigned: [] }) },
    });
    expect(fake.withdraw).toHaveBeenCalledWith(fake.tx, REGULATOR, DATE);
  });

  it("saves a trip locked elsewhere, moved again, without a false LOCK violation in the plan run", async () => {
    lockTrips({ trip_1: "veh_vsl_1" });
    const outcome = await saveDraftPlan(DATE, "v-1", [{ tripId: "trip_1", toVehicleId: "veh_taxi_1" }], null, REGULATOR);
    expect(outcome).toMatchObject({ ok: true });
    expect(outcome.ok && outcome.warning).toBeFalsy();
    expect(fake.tx.optimizationRun.update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: { valid: true, details: expect.objectContaining({ violations: [] }) },
    });
    const placed = fake.tx.trip.update.mock.calls.find((c) => (c[0] as { where: { id: string } }).where.id === "trip_1")![0] as { data: Record<string, unknown> };
    expect(placed.data.lockedVehicleId).toBe("veh_taxi_1");
  });

  it("refuses an empty draft and asks the browser to check it again (a move that no longer changes anything)", async () => {
    // trip_3 is already on the taxi: the move does nothing, the browser drops it once checked.
    expect(await saveDraftPlan(DATE, "v-1", [{ tripId: "trip_3", toVehicleId: "veh_taxi_1" }], null, REGULATOR)).toEqual({
      ok: false,
      error: DRAFT_EMPTY_ERROR,
      recheck: true,
    });
    const checked = await checkDraftPlan(DATE, [{ tripId: "trip_3", toVehicleId: "veh_taxi_1" }]);
    expect(checked.ok && checked.view.moves).toEqual([]);
    expect(fake.tx.route.update).not.toHaveBeenCalled();
  });

  it("puts a trip dropped on « À placer » without a vehicle, unlocked, in the plan's list", async () => {
    const outcome = await saveDraftPlan(DATE, "v-1", [{ tripId: "trip_3", toVehicleId: null }], null, REGULATOR);
    expect(outcome.ok).toBe(true);
    const out = fake.tx.trip.update.mock.calls.find((c) => (c[0] as { where: { id: string } }).where.id === "trip_3")![0] as { data: Record<string, unknown> };
    expect(out.data).toMatchObject({ routeId: null, lockedVehicleId: null, status: "PLANNED", plannedPickupMinute: null });
    // Its stops are deleted from the taxi's route, the others updated in place.
    expect(fake.tx.routeStop.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["trip_3-PICKUP", "trip_3-DROPOFF"] } } });
    const details = (fake.tx.optimizationRun.update.mock.calls[0]![0] as { data: { details: { unassigned: unknown[] } } }).data.details;
    expect(details.unassigned).toEqual([
      { tripId: "trip_1", reason: "Non affectée" },
      { tripId: "trip_3", reason: DRAFT_UNASSIGNED_REASON },
    ]);
  });

  it("refuses a draft shown on another version, or whose moves no longer hold, writing nothing", async () => {
    expect(await saveDraftPlan(DATE, "v-0", [{ tripId: "trip_1", toVehicleId: "veh_taxi_1" }], null, REGULATOR)).toEqual({
      ok: false,
      error: DRAFT_STALE_ERROR,
      stale: true,
    });
    fake.insert.mockResolvedValue({ ok: true, data: { ...answer(), options: [], rejected: [{ vehicleId: "veh_taxi_1", kind: "NO_ROOM", reason: "n'a plus de place" }] } });
    expect(await saveDraftPlan(DATE, "v-1", [{ tripId: "trip_1", toVehicleId: "veh_taxi_1" }], null, REGULATOR)).toEqual({
      ok: false,
      error: "Une modification ne tient plus\u00a0: Taxi 1 (Marseille) n'a plus de place. Rien n'a été enregistré.",
      recheck: true,
    });
    // The plan changed between the check and the write (another regulator).
    setUp();
    fake.version.mockResolvedValueOnce("v-1").mockResolvedValueOnce("v-2");
    expect(await saveDraftPlan(DATE, "v-1", [{ tripId: "trip_1", toVehicleId: "veh_taxi_1" }], null, REGULATOR)).toMatchObject({ ok: false, stale: true });
    expect(fake.tx.route.update).not.toHaveBeenCalled();
    expect(fake.audit).not.toHaveBeenCalled();
  });

  it("asks first on a validated day, the question repeated to go on", async () => {
    setUp([taxiRoute("VALIDATED"), ambulanceRoute()]);
    const asked = await saveDraftPlan(DATE, "v-1", [{ tripId: "trip_1", toVehicleId: "veh_taxi_1" }], null, REGULATOR);
    expect(asked).toEqual({
      ok: false,
      needsConfirmation: true,
      error:
        "Planning validé\u00a0: la feuille de route de Taxi 1 (Marseille) change dès l'enregistrement, prévenez les chauffeurs. Appliquer quand même\u202f?",
    });
    expect(fake.tx.route.update).not.toHaveBeenCalled();
    const outcome = await saveDraftPlan(DATE, "v-1", [{ tripId: "trip_1", toVehicleId: "veh_taxi_1" }], asked.ok ? null : asked.error, REGULATOR);
    expect(outcome.ok).toBe(true);
    expect((fake.audit.mock.calls[0]![2] as { details: Record<string, unknown> }[])[0]!.details).toMatchObject({ confirmed: true, validated: true });
  });
});
