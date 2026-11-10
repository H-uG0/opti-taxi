import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { insertResponseSchema, type InsertResponse } from "@/lib/optimizer/contract";

// « Où placer cette course ? » end to end against fakes: what goes to /insert, what « Appliquer »
// writes (the two routes only, the trip locked on its vehicle, one audit event), and when it refuses.
const fake = vi.hoisted(() => {
  const tx = {
    route: { findMany: vi.fn(), update: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
    routeStop: { deleteMany: vi.fn(), createMany: vi.fn() },
    trip: { findMany: vi.fn(), update: vi.fn() },
    vehicle: { findMany: vi.fn() },
    optimizationRun: { findFirst: vi.fn(), update: vi.fn() },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  };
  return {
    tx,
    db: {
      trip: { findUnique: vi.fn() },
      route: { findMany: vi.fn() },
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    },
    loadInput: vi.fn(),
    build: vi.fn(),
    insert: vi.fn(),
    audit: vi.fn(),
    version: vi.fn(),
    running: vi.fn(),
    withdraw: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: fake.db }));
vi.mock("@/lib/audit", () => ({ audit: fake.audit }));
vi.mock("@/lib/optimizer/client", () => ({ insert: fake.insert }));
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

const { applyTripPlace, findTripPlaces, PLACES_STALE_ERROR } = await import("./place-trip");

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

const taxiRoute = (status = "PROPOSED", completedAt: Date | null = null) => ({
  id: "route-taxi",
  vehicleId: "veh_taxi_1",
  status,
  driverId: "drv-taxi",
  crewMateId: null,
  stops: [
    stop("trip_3", "PICKUP", 0, completedAt),
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

function setUp(routes: unknown[] = [taxiRoute(), ambulanceRoute()]) {
  const request = load("insert-request.json") as Record<string, unknown>;
  fake.db.trip.findUnique.mockResolvedValue({
    id: "trip_1",
    serviceDate: new Date(`${DATE}T00:00:00Z`),
    status: "PLANNED",
    lockedVehicleId: null,
    patient: { firstName: "Jeanne", lastName: "Martin" },
  });
  fake.db.route.findMany.mockResolvedValue(routes);
  fake.loadInput.mockResolvedValue({
    trips: ["trip_1", "trip_2", "trip_3", "trip_4", "trip_5", "trip_6", "trip_7"].map((id) => ({ id, status: id === "trip_1" ? "PLANNED" : "ASSIGNED" })),
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
  fake.tx.optimizationRun.findFirst.mockResolvedValue({
    id: "run-1",
    details: { solverStatus: "OK", violations: [], warnings: [], unassigned: [{ tripId: "trip_1", reason: "Non affectée" }] },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setUp();
});

describe("findTripPlaces", () => {
  it("asks /insert with the routes in place, and greys the vehicles whose route is under way", async () => {
    fake.db.route.findMany.mockResolvedValue([taxiRoute(), ambulanceRoute(new Date())]);
    const outcome = await findTripPlaces("trip_1");
    const sent = fake.insert.mock.calls[0]![0] as { tripId: string; vehicleIds: string[] | null; routes: { vehicleId: string }[] };
    expect(sent.tripId).toBe("trip_1");
    // Every route goes (the total wait of a patient is checked across them), the started one is not tried.
    expect(sent.routes.map((r) => r.vehicleId)).toEqual(["veh_taxi_1", "veh_amb_1"]);
    expect(sent.vehicleIds).toEqual(["veh_taxi_1", "veh_vsl_1"]);
    expect(outcome.ok && outcome.view.version).toBe("v-1");
    expect(outcome.ok && outcome.view.options.map((o) => o.vehicleId)).toEqual(["veh_taxi_1"]);
    // An ambulance is not of an allowed type for this seated trip: not listed.
    expect(outcome.ok && outcome.view.rejected.map((r) => r.vehicleId)).toEqual(["veh_vsl_1"]);
  });

  it("refuses a trip whose own route is under way, and says the optimizer's error", async () => {
    fake.db.route.findMany.mockResolvedValue([{ ...taxiRoute("PROPOSED", new Date()), stops: [...taxiRoute("PROPOSED", new Date()).stops, stop("trip_1", "PICKUP", 6), stop("trip_1", "DROPOFF", 7)] }]);
    expect(await findTripPlaces("trip_1")).toEqual({
      ok: false,
      error: "Cette course ne peut pas quitter sa tournée\u00a0: Taxi 1 (Marseille) a une tournée commencée, qui ne change plus en cours de journée.",
    });
    expect(fake.insert).not.toHaveBeenCalled();
    setUp();
    fake.insert.mockResolvedValue({ ok: false, error: "Le service d'optimisation ne répond pas." });
    expect(await findTripPlaces("trip_1")).toEqual({ ok: false, error: "Le service d'optimisation ne répond pas." });
  });

  it("never places a cancelled trip, nor one on a past date", async () => {
    fake.db.trip.findUnique.mockResolvedValue({ id: "trip_1", serviceDate: new Date(`${DATE}T00:00:00Z`), status: "CANCELLED", lockedVehicleId: null, patient: { firstName: "J", lastName: "M" } });
    expect(await findTripPlaces("trip_1")).toMatchObject({ ok: false, error: expect.stringMatching(/^Cette course est annulée/) });
    fake.db.trip.findUnique.mockResolvedValue({ id: "trip_1", serviceDate: new Date("2020-01-02T00:00:00Z"), status: "PLANNED", lockedVehicleId: null, patient: { firstName: "J", lastName: "M" } });
    expect(await findTripPlaces("trip_1")).toMatchObject({ ok: false, error: expect.stringMatching(/est passé/) });
    expect(fake.insert).not.toHaveBeenCalled();
  });
});

describe("applyTripPlace", () => {
  it("rewrites only the target route, locks the trip there and traces it, on the version shown", async () => {
    const outcome = await applyTripPlace("trip_1", "veh_taxi_1", "v-1", null, REGULATOR);
    expect(outcome).toEqual({
      ok: true,
      message:
        "Course de MARTIN Jeanne placée sur Taxi 1 (Marseille) et figée\u00a0: prise en charge 06:08, 0\u00a0km, marge\u00a0+34\u00a0€. Seule la tournée de Taxi 1 (Marseille) a changé.",
    });
    // Computed again for that vehicle only, on the data of the moment.
    expect((fake.insert.mock.calls[0]![0] as { vehicleIds: string[] }).vehicleIds).toEqual(["veh_taxi_1"]);
    expect(fake.tx.$executeRaw).toHaveBeenCalled(); // planning lock of the date
    expect(fake.tx.routeStop.deleteMany).toHaveBeenCalledWith({ where: { routeId: "route-taxi" } });
    expect(fake.tx.route.update).toHaveBeenCalledWith({
      where: { id: "route-taxi" },
      data: expect.objectContaining({ startMinute: 362, endMinute: 803, revenue: 160.4, margin: -38.36, breakStartMinute: 758, matrixSource: "haversine" }),
    });
    const created = fake.tx.routeStop.createMany.mock.calls[0]![0] as { data: { routeId: string; tripId: string; sequence: number }[] };
    expect(created.data.map((s) => `${s.sequence}:${s.tripId}`)).toEqual(["0:trip_1", "1:trip_3", "2:trip_1", "3:trip_3", "4:trip_2", "5:trip_4", "6:trip_4", "7:trip_2"]);
    expect(created.data.every((s) => s.routeId === "route-taxi")).toBe(true);
    expect(fake.tx.route.create).not.toHaveBeenCalled();
    expect(fake.tx.route.deleteMany).not.toHaveBeenCalled();
    const placed = fake.tx.trip.update.mock.calls.find((c) => (c[0] as { where: { id: string } }).where.id === "trip_1")![0] as { data: Record<string, unknown> };
    expect(placed.data).toMatchObject({ routeId: "route-taxi", lockedVehicleId: "veh_taxi_1", status: "ASSIGNED", plannedPickupMinute: 368 });
    const other = fake.tx.trip.update.mock.calls.find((c) => (c[0] as { where: { id: string } }).where.id === "trip_3")![0] as { data: Record<string, unknown> };
    expect(other.data.lockedVehicleId).toBeUndefined();
    expect(fake.audit).toHaveBeenCalledWith(fake.tx, REGULATOR, {
      action: "trip.move",
      entity: "Trip",
      entityId: "trip_1",
      serviceDate: DATE,
      details: { mode: "insert", vehicleId: { from: null, to: "veh_taxi_1" }, lockedVehicleId: { from: null, to: "veh_taxi_1" } },
    });
    // The plan's stored violations and unassigned trips follow.
    expect(fake.tx.optimizationRun.update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: { valid: true, details: expect.objectContaining({ violations: [], unassigned: [] }) },
    });
    expect(fake.withdraw).toHaveBeenCalledWith(fake.tx, REGULATOR, DATE);
  });

  it("refuses places computed on another version of the plan, or when it changed meanwhile", async () => {
    expect(await applyTripPlace("trip_1", "veh_taxi_1", "v-0", null, REGULATOR)).toEqual({ ok: false, error: PLACES_STALE_ERROR, stale: true });
    expect(fake.insert).not.toHaveBeenCalled();
    fake.version.mockResolvedValueOnce("v-1").mockResolvedValueOnce("v-2");
    expect(await applyTripPlace("trip_1", "veh_taxi_1", "v-1", null, REGULATOR)).toEqual({ ok: false, error: PLACES_STALE_ERROR, stale: true });
    expect(fake.tx.route.update).not.toHaveBeenCalled();
    // A stop recorded by the crew between the read and the lock.
    fake.tx.route.findMany.mockImplementation(async (args: { where: { serviceDate?: unknown } }) =>
      args.where.serviceDate ? [] : [taxiRoute("PROPOSED", new Date())],
    );
    expect(await applyTripPlace("trip_1", "veh_taxi_1", "v-1", null, REGULATOR)).toEqual({ ok: false, error: PLACES_STALE_ERROR, stale: true });
    expect(fake.audit).not.toHaveBeenCalled();
  });

  it("asks first on a validated day, the question repeated to go on", async () => {
    fake.db.route.findMany.mockResolvedValue([taxiRoute("VALIDATED"), ambulanceRoute()]);
    const asked = await applyTripPlace("trip_1", "veh_taxi_1", "v-1", null, REGULATOR);
    expect(asked).toEqual({
      ok: false,
      needsConfirmation: true,
      error:
        "Planning validé\u00a0: la feuille de route de Taxi 1 (Marseille) change dès l'enregistrement, prévenez les chauffeurs. Appliquer quand même\u202f?",
    });
    expect(fake.insert).not.toHaveBeenCalled();
    const outcome = await applyTripPlace("trip_1", "veh_taxi_1", "v-1", asked.ok ? null : asked.error, REGULATOR);
    expect(outcome.ok).toBe(true);
    expect(fake.tx.route.update).toHaveBeenCalled();
  });

  it("never writes when the optimizer did not see the trip on the route it is on", async () => {
    // Stored on the VSL, but the optimizer answers as for a trip without a vehicle: the VSL route must not be deleted.
    const vslRoute = { id: "route-vsl", vehicleId: "veh_vsl_1", status: "PROPOSED", driverId: "drv-vsl", crewMateId: null, stops: [stop("trip_1", "PICKUP", 0), stop("trip_7", "PICKUP", 1), stop("trip_1", "DROPOFF", 2), stop("trip_7", "DROPOFF", 3)] };
    fake.db.route.findMany.mockResolvedValue([taxiRoute(), vslRoute]);
    expect(await applyTripPlace("trip_1", "veh_taxi_1", "v-1", null, REGULATOR)).toEqual({ ok: false, error: PLACES_STALE_ERROR, stale: true });
    expect(fake.tx.route.deleteMany).not.toHaveBeenCalled();
    expect(fake.tx.route.update).not.toHaveBeenCalled();
  });

  it("says why the vehicle no longer takes the trip, and never during a computation", async () => {
    fake.insert.mockResolvedValue({ ok: true, data: { ...answer(), options: [], rejected: [{ vehicleId: "veh_taxi_1", kind: "BREAK", reason: "est en pause de 12:00 à 12:45" }] } });
    expect(await applyTripPlace("trip_1", "veh_taxi_1", "v-1", null, REGULATOR)).toEqual({
      ok: false,
      error: "Place refusée\u00a0: Taxi 1 (Marseille) est en pause de 12:00 à 12:45. Le planning n'a pas changé.",
    });
    fake.running.mockResolvedValue(true);
    expect(await applyTripPlace("trip_1", "veh_taxi_1", "v-1", null, REGULATOR)).toEqual({ ok: false, error: "Une optimisation de cette date est en cours." });
    expect(fake.tx.route.update).not.toHaveBeenCalled();
  });

  it("moves a trip off its route: the route it leaves empty is deleted, the vehicle without a route gets one", async () => {
    const vslRoute = { id: "route-vsl", vehicleId: "veh_vsl_1", status: "PROPOSED", driverId: "drv-vsl", crewMateId: null, stops: [stop("trip_1", "PICKUP", 0), stop("trip_1", "DROPOFF", 1)] };
    fake.db.route.findMany.mockResolvedValue([vslRoute, ambulanceRoute()]);
    fake.tx.route.findMany.mockImplementation(async (args: { where: { serviceDate?: unknown } }) =>
      args.where.serviceDate ? [{ status: "PROPOSED" }, { status: "PROPOSED" }] : [vslRoute],
    );
    fake.tx.vehicle.findMany.mockResolvedValue([{ id: "veh_taxi_1", type: "TAXI" }, { id: "veh_vsl_1", type: "VSL" }]);
    fake.db.trip.findUnique.mockResolvedValue({
      id: "trip_1",
      serviceDate: new Date(`${DATE}T00:00:00Z`),
      status: "ASSIGNED",
      lockedVehicleId: "veh_vsl_1",
      patient: { firstName: "Jeanne", lastName: "Martin" },
    });
    // The taxi has no route in place here: the option's route is created, with the taxi's crew of the day.
    fake.insert.mockResolvedValue({ ok: true, data: { ...answer(), fromVehicleId: "veh_vsl_1" } });
    const outcome = await applyTripPlace("trip_1", "veh_taxi_1", "v-1", null, REGULATOR);
    expect(outcome).toMatchObject({ ok: true, message: expect.stringMatching(/Seules les tournées de Taxi 1 \(Marseille\) et VSL 1 \(Sisteron\) ont changé\.$/) });
    expect(fake.tx.route.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ vehicleId: "veh_taxi_1", driverId: "drv-taxi", crewMateId: null, status: "PROPOSED", optimizationRunId: "run-1" }),
      select: { id: true },
    });
    expect(fake.tx.route.update).not.toHaveBeenCalled();
    expect(fake.tx.route.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["route-vsl"] } } });
    expect(fake.audit).toHaveBeenCalledWith(
      fake.tx,
      REGULATOR,
      expect.objectContaining({
        details: { mode: "insert", vehicleId: { from: "veh_vsl_1", to: "veh_taxi_1" }, lockedVehicleId: { from: "veh_vsl_1", to: "veh_taxi_1" } },
      }),
    );
  });

  it("creates a validated route on a validated day, and refuses the trip's own vehicle", async () => {
    fake.db.route.findMany.mockResolvedValue([{ ...ambulanceRoute(), status: "VALIDATED" }]);
    fake.tx.route.findMany.mockImplementation(async (args: { where: { serviceDate?: unknown } }) =>
      args.where.serviceDate ? [{ status: "VALIDATED" }] : [],
    );
    const asked = await applyTripPlace("trip_1", "veh_taxi_1", "v-1", null, REGULATOR);
    expect(asked.ok).toBe(false);
    await applyTripPlace("trip_1", "veh_taxi_1", "v-1", asked.ok ? null : asked.error, REGULATOR);
    expect(fake.tx.route.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: "VALIDATED", validatedAt: expect.any(Date) }),
      select: { id: true },
    });
    setUp([{ ...taxiRoute(), stops: [...taxiRoute().stops, stop("trip_1", "PICKUP", 6), stop("trip_1", "DROPOFF", 7)] }]);
    expect(await applyTripPlace("trip_1", "veh_taxi_1", "v-1", null, REGULATOR)).toEqual({
      ok: false,
      error: "La course est déjà sur Taxi 1 (Marseille).",
      stale: true,
    });
  });
});
