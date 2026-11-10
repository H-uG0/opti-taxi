import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertResponseSchema, type InsertResponse } from "@/lib/optimizer/contract";

// « Où placer cette course ? » end to end against fakes: what goes to /insert, what « Appliquer »
// writes (the two routes only, the trip locked on its vehicle, one audit event), and when it refuses.
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

beforeEach(() => {
  vi.clearAllMocks();
  setUp();
});
afterEach(() => {
  vi.useRealTimers();
});

/** The SQL text of a tagged $executeRaw call. */
const sqlOf = (call: unknown[]) => (call[0] as TemplateStringsArray).join("?");

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

  it("never places a trip on a day without routes: the day is planned by « Optimiser »", async () => {
    fake.db.route.findMany.mockResolvedValue([]);
    expect(await findTripPlaces("trip_1")).toEqual({
      ok: false,
      error: "Optimisez d'abord la journée\u00a0: l'assistant place une course dans les tournées en place.",
    });
    expect(await applyTripPlace("trip_1", "veh_taxi_1", "v-1", null, REGULATOR)).toMatchObject({ ok: false });
    expect(fake.insert).not.toHaveBeenCalled();
  });

  it("leaves a trip in an exceptional ambulance to « Défiger »", async () => {
    fake.loadInput.mockResolvedValue({
      trips: [{ id: "trip_1", status: "ASSIGNED", exceptionalAmbulanceAt: new Date(), lockedVehicleId: "veh_amb_1", allowedVehicleTypes: ["TAXI", "VSL"] }],
      vehicles: [{ id: "veh_amb_1", type: "AMBULANCE" }],
    });
    expect(await findTripPlaces("trip_1")).toMatchObject({ ok: false, error: expect.stringMatching(/^Recours exceptionnel à une ambulance\u00a0: «\u202fDéfiger\u202f»/) });
    expect(fake.insert).not.toHaveBeenCalled();
  });

  it("says that the trip's vehicle is off the road, not that its crew changed", async () => {
    const downRoute = { ...taxiRoute(), id: "route-down", vehicleId: "veh_down", stops: [stop("trip_1", "PICKUP", 0), stop("trip_1", "DROPOFF", 1)] };
    fake.db.route.findMany.mockResolvedValue([taxiRoute(), downRoute]);
    // Made unavailable that day (VehicleUnavailability): not sent, reported as skipped.
    const built = fake.build() as object;
    fake.build.mockReturnValue({ ...built, skippedVehicles: [{ vehicleId: "veh_down", label: "Taxi 9 (Gap)", type: "TAXI", reason: "Panne moteur" }] });
    expect(await findTripPlaces("trip_1")).toEqual({
      ok: false,
      error:
        "Cette course ne peut pas quitter sa tournée\u00a0: Taxi 9 (Gap) est indisponible ce jour\u00a0: panne moteur. " +
        "L'assistant ne refait pas la tournée d'un véhicule indisponible\u00a0: seule une réoptimisation de la journée la reprend.",
    });
    expect(fake.insert).not.toHaveBeenCalled();
  });

  it("never offers a free vehicle whose crew of the day is still on another route of the date", async () => {
    // Crews saved after the plan: the VSL's driver of the day still drives the ambulance's stored route.
    fake.db.route.findMany.mockResolvedValue([taxiRoute(), { ...ambulanceRoute(), driverId: "drv-vsl" }]);
    const outcome = await findTripPlaces("trip_1");
    expect((fake.insert.mock.calls[0]![0] as { vehicleIds: string[] | null }).vehicleIds).toEqual(["veh_taxi_1"]);
    expect(outcome.ok && outcome.view.rejected).toEqual([
      { vehicleId: "veh_vsl_1", kind: "RULES", reason: "a son équipage du jour encore sur la tournée de Ambulance 1 (Gap) (voir «\u202fÀ traiter\u202f»)" },
    ]);
    expect(await applyTripPlace("trip_1", "veh_vsl_1", "v-1", null, REGULATOR)).toEqual({
      ok: false,
      error: "Place refusée\u00a0: VSL 1 (Sisteron) a son équipage du jour encore sur la tournée de Ambulance 1 (Gap) (voir «\u202fÀ traiter\u202f»).",
    });
  });

  it("on today's date, greys a place whose pickup is already past", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${DATE}T13:00:00Z`)); // 14:00 in Paris
    const outcome = await findTripPlaces("trip_1");
    expect(outcome.ok && outcome.view.options).toEqual([]);
    expect(outcome.ok && outcome.view.rejected).toContainEqual({ vehicleId: "veh_taxi_1", kind: "PAST", reason: "la prendrait en charge à 06:08, heure déjà passée" });
    expect(await applyTripPlace("trip_1", "veh_taxi_1", "v-1", null, REGULATOR)).toEqual({
      ok: false,
      error: "Place refusée\u00a0: Taxi 1 (Marseille) la prendrait en charge à 06:08, heure déjà passée. Le planning n'a pas changé.",
    });
    expect(fake.tx.route.update).not.toHaveBeenCalled();
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
    expect(fake.tx.route.update).toHaveBeenCalledWith({
      where: { id: "route-taxi" },
      data: expect.objectContaining({ startMinute: 362, endMinute: 803, revenue: 160.4, margin: -38.36, breakStartMinute: 758, matrixSource: "haversine" }),
    });
    // The stops that stay keep their ids (a driver's phone sends statuses by stop id), moved out of the way first.
    expect(fake.tx.routeStop.deleteMany).not.toHaveBeenCalled();
    expect(fake.tx.$executeRaw.mock.calls.map(sqlOf)).toContain('UPDATE "RouteStop" SET "sequence" = -"sequence" - 1 WHERE "routeId" = ?');
    const updated = fake.tx.routeStop.update.mock.calls.map((c) => c[0] as { where: { id: string }; data: { sequence: number; startMinute: number } });
    expect(updated.map((u) => `${u.data.sequence}:${u.where.id}`)).toEqual([
      "1:trip_3-PICKUP",
      "3:trip_3-DROPOFF",
      "4:trip_2-PICKUP",
      "5:trip_4-PICKUP",
      "6:trip_4-DROPOFF",
      "7:trip_2-DROPOFF",
    ]);
    expect(updated[0]!.data.startMinute).toBe(381);
    // Only the placed trip's two stops are new.
    const created = fake.tx.routeStop.createMany.mock.calls[0]![0] as { data: { routeId: string; tripId: string; sequence: number }[] };
    expect(created.data.map((s) => `${s.sequence}:${s.tripId}`)).toEqual(["0:trip_1", "2:trip_1"]);
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

  it("moves a trip off a route that keeps other trips: only its two stops leave, the others keep their ids", async () => {
    const vslRoute = {
      id: "route-vsl",
      vehicleId: "veh_vsl_1",
      status: "PROPOSED",
      driverId: "drv-vsl",
      crewMateId: null,
      stops: [stop("trip_1", "PICKUP", 0), stop("trip_7", "PICKUP", 1), stop("trip_1", "DROPOFF", 2), stop("trip_7", "DROPOFF", 3)],
    };
    fake.db.route.findMany.mockResolvedValue([taxiRoute(), vslRoute]);
    fake.tx.route.findMany.mockImplementation(async (args: { where: { serviceDate?: unknown } }) =>
      args.where.serviceDate ? [{ status: "PROPOSED" }, { status: "PROPOSED" }] : [taxiRoute(), vslRoute],
    );
    fake.tx.vehicle.findMany.mockResolvedValue([{ id: "veh_taxi_1", type: "TAXI" }, { id: "veh_vsl_1", type: "VSL" }]);
    fake.tx.trip.findMany.mockResolvedValue(
      ["trip_1", "trip_2", "trip_3", "trip_4", "trip_7"].map((id) => ({
        id,
        status: id === "trip_1" ? "PLANNED" : "ASSIGNED",
        sharingStatus: "NOT_PROPOSED",
        pickupAddress: `départ ${id}`,
        dropoffAddress: `arrivée ${id}`,
      })),
    );
    const data = answer();
    const [option] = data.options;
    const taxi = option!.routes[0]!;
    const vsl = {
      ...taxi,
      vehicleId: "veh_vsl_1",
      break: null,
      stops: [
        { ...taxi.stops[0]!, tripId: "trip_7", kind: "PICKUP" as const, arrivalMin: 500, startMin: 500, departureMin: 505, loadAfter: 1 },
        { ...taxi.stops[2]!, tripId: "trip_7", kind: "DROPOFF" as const, arrivalMin: 540, startMin: 540, departureMin: 545, loadAfter: 0 },
      ],
    };
    const trip7 = { ...option!.trips[0]!, tripId: "trip_7", vehicleId: "veh_vsl_1", pickupMin: 500, dropoffMin: 540, shared: false, coPassengerTripIds: [] };
    fake.insert.mockResolvedValue({
      ok: true,
      data: { ...data, fromVehicleId: "veh_vsl_1", options: [{ ...option!, routes: [taxi, vsl], trips: [...option!.trips, trip7] }] },
    });
    expect((await applyTripPlace("trip_1", "veh_taxi_1", "v-1", null, REGULATOR)).ok).toBe(true);
    expect(fake.tx.routeStop.deleteMany).toHaveBeenCalledTimes(1);
    expect(fake.tx.routeStop.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["trip_1-PICKUP", "trip_1-DROPOFF"] } } });
    const updated = fake.tx.routeStop.update.mock.calls.map((c) => c[0] as { where: { id: string }; data: { sequence: number } });
    expect(updated.filter((u) => u.where.id.startsWith("trip_7")).map((u) => `${u.data.sequence}:${u.where.id}`)).toEqual([
      "0:trip_7-PICKUP",
      "1:trip_7-DROPOFF",
    ]);
    // New stops on the target only, nothing created on the source.
    const created = fake.tx.routeStop.createMany.mock.calls.map((c) => c[0] as { data: { routeId: string }[] });
    expect(created.flatMap((c) => c.data.map((s) => s.routeId))).toEqual(["route-taxi", "route-taxi"]);
    expect(fake.tx.route.deleteMany).not.toHaveBeenCalled();
  });

  it("refuses a new route whose crew got onto another route meanwhile, and writes nothing", async () => {
    fake.db.route.findMany.mockResolvedValue([ambulanceRoute()]);
    fake.tx.route.findMany.mockImplementation(async (args: { where: { serviceDate?: unknown } }) =>
      args.where.serviceDate ? [{ status: "PROPOSED" }] : [],
    );
    fake.tx.route.findFirst.mockResolvedValue({ vehicleId: "veh_amb_1" });
    expect(await applyTripPlace("trip_1", "veh_taxi_1", "v-1", null, REGULATOR)).toEqual({
      ok: false,
      error: "Place refusée\u00a0: Taxi 1 (Marseille) a son équipage du jour encore sur la tournée de Ambulance 1 (Gap) (voir «\u202fÀ traiter\u202f»).",
      stale: true,
    });
    expect(fake.tx.route.findFirst).toHaveBeenCalledWith({
      where: { serviceDate: new Date(`${DATE}T00:00:00Z`), vehicleId: { not: "veh_taxi_1" }, OR: [{ driverId: { in: ["drv-taxi"] } }, { crewMateId: { in: ["drv-taxi"] } }] },
      select: { vehicleId: true },
    });
    expect(fake.tx.route.create).not.toHaveBeenCalled();
    expect(fake.audit).not.toHaveBeenCalled();
  });

  it("creates a validated route on a validated day, at the day's validation time, and refuses the trip's own vehicle", async () => {
    const validatedAt = new Date("2099-03-01T17:40:00Z");
    fake.db.route.findMany.mockResolvedValue([{ ...ambulanceRoute(), status: "VALIDATED" }]);
    fake.tx.route.findMany.mockImplementation(async (args: { where: { serviceDate?: unknown } }) =>
      args.where.serviceDate ? [{ status: "VALIDATED", validatedAt }] : [],
    );
    const asked = await applyTripPlace("trip_1", "veh_taxi_1", "v-1", null, REGULATOR);
    expect(asked.ok).toBe(false);
    await applyTripPlace("trip_1", "veh_taxi_1", "v-1", asked.ok ? null : asked.error, REGULATOR);
    // Not now: the dashboard reads the latest validation time as the end of planning.
    expect(fake.tx.route.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: "VALIDATED", validatedAt }),
      select: { id: true },
    });
    // The question answered is traced with the state of the day.
    expect(fake.audit).toHaveBeenCalledWith(
      fake.tx,
      REGULATOR,
      expect.objectContaining({ details: expect.objectContaining({ mode: "insert", confirmed: true, validated: true, started: false }) }),
    );
    setUp([{ ...taxiRoute(), stops: [...taxiRoute().stops, stop("trip_1", "PICKUP", 6), stop("trip_1", "DROPOFF", 7)] }]);
    expect(await applyTripPlace("trip_1", "veh_taxi_1", "v-1", null, REGULATOR)).toEqual({
      ok: false,
      error: "La course est déjà sur Taxi 1 (Marseille).",
      stale: true,
    });
  });
});
