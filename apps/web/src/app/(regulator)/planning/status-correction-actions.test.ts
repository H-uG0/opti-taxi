import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// « Corriger un statut » (FLD-02) against a fake Prisma client: the real time and a reason required, the stop and its
// trip written together (guarded), the correction traced, never on a day to come.
const fake = vi.hoisted(() => {
  const models = {
    routeStop: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    trip: { updateMany: vi.fn() },
    auditEvent: { createMany: vi.fn() },
  };
  return { db: { ...models, $transaction: vi.fn(async (fn: (tx: typeof models) => unknown) => fn(models)) } };
});

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/log", () => ({ logError: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "reg1", name: "Régulation", role: "REGULATOR", driverId: null })) }));
vi.mock("@/lib/db", () => ({ db: fake.db }));

const { correctStopStatus } = await import("./status-correction-actions");

// Monday 16 November 2026, 09:00 in Paris; the route of Sunday 15.
const NOW = new Date("2026-11-16T08:00:00.000Z");
const SUNDAY = new Date("2026-11-15T00:00:00.000Z");
const dropoff = (status = "PICKED_UP", completedAt: Date | null = null) => ({
  id: "s2",
  sequence: 1,
  kind: "DROPOFF",
  tripId: "t1",
  routeId: "r1",
  completedAt,
  route: { serviceDate: SUNDAY },
  trip: { status, noShowReason: null },
});
// The route: the trip's pickup recorded at 16:05, then another patient's pickup at 17:30.
const routeStops = (laterAt: Date | null = new Date("2026-11-15T16:30:00.000Z")) => [
  { id: "s1", sequence: 0, kind: "PICKUP", tripId: "t1", completedAt: new Date("2026-11-15T15:05:00.000Z"), trip: { status: "PICKED_UP" } },
  { id: "s2", sequence: 1, kind: "DROPOFF", tripId: "t1", completedAt: null, trip: { status: "PICKED_UP" } },
  { id: "s3", sequence: 2, kind: "PICKUP", tripId: "t2", completedAt: laterAt, trip: { status: "PICKED_UP" } },
];

const auditEvents = () => fake.db.auditEvent.createMany.mock.calls.flatMap((call) => call[0].data as Record<string, unknown>[]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fake.db.routeStop.findUnique.mockResolvedValue(dropoff());
  fake.db.routeStop.findMany.mockResolvedValue(routeStops());
  fake.db.routeStop.updateMany.mockResolvedValue({ count: 1 });
  fake.db.trip.updateMany.mockResolvedValue({ count: 1 });
  fake.db.auditEvent.createMany.mockResolvedValue({ count: 1 });
});
afterEach(() => vi.useRealTimers());

describe("correctStopStatus (FLD-02)", () => {
  it("records a forgotten drop-off at the real time, with its author, source and reason, and traces it", async () => {
    const result = await correctStopStatus({ stopId: "s2", target: "DROPOFF", time: "16:40", reason: "CREW_FORGOT" });
    expect(result).toEqual({ ok: true, message: "Statut corrigé : déposé à 16:40." });
    const at = new Date("2026-11-15T15:40:00.000Z");
    expect(fake.db.routeStop.updateMany).toHaveBeenCalledWith({
      where: { id: "s2", completedAt: null },
      data: { completedAt: at, completedById: "reg1", completedReceivedAt: NOW, completedSource: "CORRECTED", correctionReason: "CREW_FORGOT" },
    });
    expect(fake.db.trip.updateMany).toHaveBeenCalledWith({ where: { id: "t1", status: "PICKED_UP" }, data: { status: "DROPPED_OFF", noShowReason: null } });
    expect(auditEvents()).toEqual([
      expect.objectContaining({
        action: "stop.correct",
        entity: "Trip",
        entityId: "t1",
        details: { stopKind: "DROPOFF", status: { from: "NONE", to: "DROPOFF" }, minute: { from: null, to: 1000 }, reason: "CREW_FORGOT" },
      }),
    ]);
  });

  it("requires a reason, the real time, and the absence's reason for an absence", async () => {
    expect(await correctStopStatus({ stopId: "s2", target: "DROPOFF", time: "16:40", reason: "" })).toEqual({ ok: false, error: "Choisissez le motif de la correction." });
    expect(await correctStopStatus({ stopId: "s2", target: "DROPOFF", time: "", reason: "OTHER" })).toMatchObject({ ok: false, error: expect.stringContaining("heure réelle") });
    expect(await correctStopStatus({ stopId: "s2", target: "NO_SHOW", time: "16:40", reason: "OTHER" })).toEqual({ ok: false, error: "Choisissez le motif de l'absence." });
    expect(fake.db.$transaction).not.toHaveBeenCalled();
  });

  it("never corrects a day to come, and reports a status changed meanwhile", async () => {
    fake.db.routeStop.findUnique.mockResolvedValue({ ...dropoff(), route: { serviceDate: new Date("2026-11-17T00:00:00.000Z") } });
    expect(await correctStopStatus({ stopId: "s2", target: "DROPOFF", time: "16:40", reason: "OTHER" })).toMatchObject({ ok: false });
    fake.db.routeStop.findUnique.mockResolvedValue(dropoff());
    fake.db.routeStop.updateMany.mockResolvedValue({ count: 0 });
    expect(await correctStopStatus({ stopId: "s2", target: "DROPOFF", time: "16:40", reason: "OTHER" })).toMatchObject({ ok: false, stale: true });
  });

  it("refuses what the rules refuse: a drop-off before its pickup", async () => {
    expect(await correctStopStatus({ stopId: "s2", target: "DROPOFF", time: "15:30", reason: "OTHER" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("avant la prise en charge"),
    });
  });

  it("keeps the route's statuses in their order, as « Fin de tournée » does", async () => {
    // 17:40 is after the next stop's pickup, recorded at 17:30.
    const result = await correctStopStatus({ stopId: "s2", target: "DROPOFF", time: "17:40", reason: "OTHER" });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("après le statut d'un arrêt suivant de la tournée (17:30)") });
    expect(fake.db.$transaction).not.toHaveBeenCalled();
    expect(await correctStopStatus({ stopId: "s2", target: "DROPOFF", time: "17:20", reason: "OTHER" })).toMatchObject({ ok: true });
  });

  it("changes only the reason of an absence, traced without the reason itself", async () => {
    const pickup = { ...dropoff("NO_SHOW", new Date("2026-11-15T15:05:00.000Z")), id: "s1", sequence: 0, kind: "PICKUP", trip: { status: "NO_SHOW", noShowReason: "NO_ANSWER" } };
    fake.db.routeStop.findUnique.mockResolvedValue(pickup);
    fake.db.routeStop.findMany.mockResolvedValue([{ ...routeStops()[0]!, trip: { status: "NO_SHOW" } }]);
    const result = await correctStopStatus({ stopId: "s1", target: "NO_SHOW", time: "16:05", reason: "CREW_CALL", noShowReason: "HOSPITALIZED" });
    expect(result).toMatchObject({ ok: true });
    expect(fake.db.trip.updateMany).toHaveBeenCalledWith({ where: { id: "t1", status: "NO_SHOW" }, data: { status: "NO_SHOW", noShowReason: "HOSPITALIZED" } });
    const [event] = auditEvents();
    expect(event?.details).toMatchObject({ noShowReasonChanged: true });
    expect(JSON.stringify(event?.details)).not.toContain("HOSPITALIZED");
  });
});
