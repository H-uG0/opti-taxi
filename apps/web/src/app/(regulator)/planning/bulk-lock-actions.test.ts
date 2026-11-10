import { beforeEach, describe, expect, it, vi } from "vitest";
import { lockRoutes, placeUnassigned, unlockRoutes } from "./actions";

// « Figer » / « Défiger » a route, a depot or the day against a fake Prisma
// client: which trips are written (conditionally), one audit event per
// action, a stale page refused, a past date refused.
const fake = vi.hoisted(() => {
  const models = {
    route: { findFirst: vi.fn() },
    depot: { findUnique: vi.fn() },
    trip: { findMany: vi.fn(), updateMany: vi.fn() },
    auditEvent: { createMany: vi.fn() },
    $executeRaw: vi.fn(),
  };
  return { ...models, $transaction: vi.fn(async (fn: (tx: typeof models) => unknown) => fn(models)) };
});
const version = vi.hoisted(() => ({ current: "v1" }));
const run = vi.hoisted(() => ({ runOptimization: vi.fn() }));
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => cache);
vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "u1", name: "Régulation", role: "REGULATOR", driverId: null })),
}));
vi.mock("@/lib/db", () => ({ db: fake }));
vi.mock("@/lib/planning/run-optimization", () => ({
  replanBlocker: vi.fn(async () => null),
  optimizationInProgress: vi.fn(async () => false),
  runOptimization: run.runOptimization,
  PLANNING_TX_OPTIONS: {},
  OPTIMIZATION_IN_PROGRESS_ERROR: "Calcul en cours.",
  NOT_PENDING_ERROR: "",
}));
vi.mock("@/lib/planning/version", () => ({
  loadPlanVersion: vi.fn(async () => version.current),
  STALE_PLAN_ERROR: "Le planning a changé depuis l'affichage : rechargez la page.",
}));

const DATE = "2099-01-05";

const trip = (id: string, routeVehicle: string | null, locked: string | null = null, extra: Partial<{ status: string; exceptional: boolean }> = {}) => ({
  id,
  status: extra.status ?? "ASSIGNED",
  lockedVehicleId: locked,
  exceptionalAmbulanceAt: extra.exceptional ? new Date("2099-01-04T10:00:00Z") : null,
  route: routeVehicle ? { vehicleId: routeVehicle } : null,
});

/** Audit events written, as rows. */
const events = () =>
  fake.auditEvent.createMany.mock.calls.flatMap((call) => (call[0] as { data: Array<Record<string, unknown>> }).data);

beforeEach(() => {
  vi.clearAllMocks();
  version.current = "v1";
  fake.route.findFirst.mockResolvedValue({ id: "route_t1", vehicle: { label: "Taxi 1" } });
  fake.depot.findUnique.mockResolvedValue({ name: "Gap", vehicles: [{ id: "t1" }, { id: "v1" }] });
  fake.trip.updateMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => ({ count: where.id.in.length }));
  fake.auditEvent.createMany.mockResolvedValue({ count: 1 });
  fake.$executeRaw.mockResolvedValue(1);
});

describe("lockRoutes", () => {
  it("locks the active unlocked trips of a route on its vehicle, in one audit event on the route", async () => {
    fake.trip.findMany.mockResolvedValue([
      trip("a", "t1"),
      trip("b", "t1"),
      trip("c", "t1", "t1"),
      trip("d", "t1", "v9"),
      trip("e", "t1", null, { status: "CANCELLED" }),
    ]);
    const result = await lockRoutes(DATE, { kind: "route", vehicleId: "t1" }, "v1");

    expect(result).toEqual({
      ok: true,
      message:
        "La tournée de Taxi 1 : 2 courses figées, elles resteront sur leur véhicule à la prochaine optimisation. 1 course figée sur un autre véhicule garde ce verrou.",
    });
    // Conditional: still unlocked and still on that vehicle's route when written.
    expect(fake.trip.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["a", "b"] }, lockedVehicleId: null, route: { is: { vehicleId: "t1" } } },
      data: { lockedVehicleId: "t1" },
    });
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      action: "plan.lock",
      entity: "Route",
      entityId: "route_t1",
      details: { scope: "route", vehicleId: "t1", trips: 2 },
    });
    // The trips read are those of the vehicle's route or locked on it, on the date.
    expect(fake.trip.findMany.mock.calls[0]![0].where).toMatchObject({
      OR: [{ route: { is: { vehicleId: { in: ["t1"] } } } }, { lockedVehicleId: { in: ["t1"] } }],
    });
    expect(fake.$executeRaw).toHaveBeenCalled(); // planning lock of the date
    expect(cache.revalidatePath).toHaveBeenCalled();
  });

  it("locks a depot vehicle by vehicle, one event on the depot", async () => {
    fake.trip.findMany.mockResolvedValue([trip("a", "t1"), trip("b", "v1"), trip("c", "v1")]);
    const result = await lockRoutes(DATE, { kind: "depot", depotId: "dep_gap" }, "v1");
    expect(result).toMatchObject({ ok: true, message: expect.stringMatching(/^Les tournées du dépôt Gap : 3 courses figées/) });
    expect(fake.trip.updateMany).toHaveBeenCalledTimes(2);
    expect(events()).toEqual([
      expect.objectContaining({ action: "plan.lock", entity: "Depot", entityId: "dep_gap", details: { scope: "depot", trips: 3 } }),
    ]);
  });

  it("says when there is nothing to lock, and writes no event", async () => {
    fake.trip.findMany.mockResolvedValue([trip("c", "t1", "t1")]);
    const result = await lockRoutes(DATE, { kind: "day" }, "v1");
    expect(result).toEqual({ ok: true, message: "Rien à figer dans toutes les tournées du jour : ses courses sont déjà figées." });
    expect(fake.trip.updateMany).not.toHaveBeenCalled();
    expect(fake.auditEvent.createMany).not.toHaveBeenCalled();
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a stale page, a vehicle without route, a past date and a scope it does not know", async () => {
    version.current = "v2";
    expect(await lockRoutes(DATE, { kind: "day" }, "v1")).toMatchObject({ ok: false, stale: true });

    version.current = "v1";
    fake.route.findFirst.mockResolvedValue(null);
    expect(await lockRoutes(DATE, { kind: "route", vehicleId: "t1" }, "v1")).toMatchObject({ ok: false, stale: true });

    expect(await lockRoutes("2020-01-06", { kind: "day" }, "v1")).toMatchObject({ ok: false, error: expect.stringMatching(/est passé/) });
    expect(await lockRoutes(DATE, { kind: "everything" } as never, "v1")).toMatchObject({ ok: false });
    expect(fake.trip.updateMany).not.toHaveBeenCalled();
    expect(fake.auditEvent.createMany).not.toHaveBeenCalled();
  });
});

describe("unlockRoutes", () => {
  it("unlocks the day's locks but the exceptional ambulances, in one event for the day", async () => {
    fake.trip.findMany.mockResolvedValue([
      trip("a", "t1", "t1"),
      trip("b", null, "v1"),
      trip("c", "t1"),
      trip("amb", "a1", "a1", { exceptional: true }),
    ]);
    const result = await unlockRoutes(DATE, { kind: "day" }, "v1");
    expect(result).toEqual({
      ok: true,
      message:
        "Toutes les tournées du jour : 2 courses défigées, la prochaine optimisation pourra les changer de véhicule. 1 recours exceptionnel à une ambulance reste figé : défigez-le depuis la course.",
    });
    expect(fake.trip.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["a", "b"] }, lockedVehicleId: { not: null }, exceptionalAmbulanceAt: null },
      data: { lockedVehicleId: null },
    });
    expect(fake.trip.findMany.mock.calls[0]![0].where).toEqual({ serviceDate: new Date(`${DATE}T00:00:00.000Z`) });
    expect(events()).toEqual([
      expect.objectContaining({ action: "plan.unlock", entity: "Route", entityId: null, details: { scope: "day", trips: 2 } }),
    ]);
  });

  it("unlocks a route's trips and those locked on its vehicle elsewhere", async () => {
    fake.trip.findMany.mockResolvedValue([trip("a", "t1", "v9"), trip("b", null, "t1"), trip("c", "v9", "v9")]);
    await unlockRoutes(DATE, { kind: "route", vehicleId: "t1" }, "v1");
    expect(fake.trip.updateMany.mock.calls[0]![0].where.id).toEqual({ in: ["a", "b"] });
  });
});

describe("placeUnassigned", () => {
  it("runs a computation that places only the trips without a vehicle", async () => {
    run.runOptimization.mockResolvedValue({ ok: true, message: "1 course placée sur 1 non affectée.", runId: "r" });
    expect(await placeUnassigned(DATE)).toEqual({ ok: true, message: "1 course placée sur 1 non affectée." });
    expect(run.runOptimization).toHaveBeenCalledWith(DATE, expect.objectContaining({ id: "u1" }), { placeOnly: true });
    expect(await placeUnassigned("demain")).toMatchObject({ ok: false, error: "Date invalide." });
  });
});
