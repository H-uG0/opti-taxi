import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, startOfIsoWeek, todayIso } from "@/lib/time";
import { cancelTrip, cancelTrips, completeDayTrips, generateWeekTrips, restoreTrip } from "./actions";
import { INITIAL_ACTION_RESULT } from "@/lib/forms";

// The trips screen actions against a fake Prisma client: which writes are
// guarded, what they write and which audit events are recorded, not the database.
const fake = vi.hoisted(() => {
  const models = {
    trip: { findUnique: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    routeStop: { findMany: vi.fn(), deleteMany: vi.fn(), update: vi.fn() },
    appSettings: { upsert: vi.fn(), findUnique: vi.fn() },
    auditEvent: { createMany: vi.fn() },
  };
  const client = { ...models, $queryRaw: vi.fn() };
  return {
    ...client,
    $transaction: vi.fn(async (fn: (tx: typeof client) => unknown) => fn(client)),
    completeTrips: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "u1", name: "Régulation", role: "REGULATOR", driverId: null })),
}));
vi.mock("@/lib/db", () => ({ db: fake }));
vi.mock("@/lib/optimizer/client", () => ({ evaluate: vi.fn() }));
vi.mock("@/lib/planning/refresh-routes", async (original) => {
  const actual = await original<typeof import("@/lib/planning/refresh-routes")>();
  return { ...actual, refreshRoutes: vi.fn(async () => actual.NOTHING_REFRESHED) };
});
vi.mock("@/lib/trips/completion", async (original) => ({
  ...(await original<typeof import("@/lib/trips/completion")>()),
  completeTrips: fake.completeTrips,
}));

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) fd.set(key, value);
  return fd;
}

/** A trip as cancelTrip reads it, on a far service day (never late). */
function tripRow(id: string, direction: "OUTBOUND" | "RETURN", overrides: Record<string, unknown> = {}) {
  return {
    id,
    status: "PLANNED",
    serviceDate: new Date("2099-01-05T00:00:00.000Z"),
    direction,
    patientId: "p1",
    recurrenceId: "rec1",
    facilityId: "f1",
    routeId: null,
    plannedPickupMinute: null,
    appointmentMinute: direction === "OUTBOUND" ? 450 : null,
    readyMinute: direction === "RETURN" ? 690 : null,
    route: null,
    ...overrides,
  };
}

const rows = new Map<string, ReturnType<typeof tripRow>>();

function recorded(): { action: string; entityId: string | null }[] {
  return fake.auditEvent.createMany.mock.calls.flatMap((call) =>
    (call[0] as { data: { action: string; entityId: string | null }[] }).data.map(({ action, entityId }) => ({ action, entityId })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  rows.clear();
  fake.trip.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null);
  fake.trip.updateMany.mockResolvedValue({ count: 1 });
  fake.routeStop.findMany.mockResolvedValue([]);
  fake.trip.findMany.mockResolvedValue([]);
  fake.appSettings.upsert.mockResolvedValue({ id: 1, lateCancellationHours: 2 });
  fake.auditEvent.createMany.mockResolvedValue({ count: 1 });
  fake.appSettings.findUnique.mockResolvedValue({ tripHorizonDays: 14 });
  fake.completeTrips.mockResolvedValue({ created: 0, revived: 0, createdByDay: new Map(), skipped: [] });
});

describe("cancelTrip", () => {
  it("refuses a cancellation without a reason, writing nothing", async () => {
    rows.set("t1", tripRow("t1", "OUTBOUND"));

    const result = await cancelTrip(INITIAL_ACTION_RESULT, form({ tripId: "t1" }));

    expect(result).toEqual({ ok: false, message: "Choisissez le motif de l'annulation." });
    expect(fake.trip.updateMany).not.toHaveBeenCalled();
  });

  it("records the reason, the note, the author and the instant, as a person's cancellation", async () => {
    rows.set("t1", tripRow("t1", "OUTBOUND"));

    const result = await cancelTrip(INITIAL_ACTION_RESULT, form({ tripId: "t1", reason: "HOSPITALIZATION", note: "prévenu par sa fille" }));

    expect(fake.trip.updateMany).toHaveBeenCalledTimes(1);
    const { where, data } = fake.trip.updateMany.mock.calls[0]![0];
    expect(where).toEqual({ id: "t1", status: "PLANNED" });
    expect(data).toMatchObject({
      status: "CANCELLED",
      routeId: null,
      lockedVehicleId: null,
      cancellationReason: "HOSPITALIZATION",
      cancellationOrigin: "USER",
      cancellationNote: "prévenu par sa fille",
      cancelledById: "u1",
      lateCancellation: false,
    });
    expect(data.cancelledAt).toBeInstanceOf(Date);
    expect(recorded()).toEqual([{ action: "trip.cancel", entityId: "t1" }]);
    expect(result).toEqual({ ok: true, message: "Course annulée (hospitalisation)." });
  });

  it("cancels the return of the same care along when the box is ticked, one trace each", async () => {
    rows.set("t1", tripRow("t1", "OUTBOUND"));
    rows.set("t2", tripRow("t2", "RETURN"));

    const result = await cancelTrip(INITIAL_ACTION_RESULT, form({ tripId: "t1", reason: "FACILITY", returnTripId: "t2" }));

    expect(fake.trip.updateMany.mock.calls.map(([args]) => args.where)).toEqual([
      { id: "t1", status: "PLANNED" },
      { id: "t2", status: "PLANNED" },
    ]);
    expect(recorded()).toEqual([
      { action: "trip.cancel", entityId: "t1" },
      { action: "trip.cancel", entityId: "t2" },
    ]);
    expect(result.message).toBe("Aller et retour annulés (séance annulée ou déplacée par l'établissement).");
  });

  it("refuses a return that is not the same care (another patient), cancelling nothing", async () => {
    rows.set("t1", tripRow("t1", "OUTBOUND"));
    rows.set("t9", tripRow("t9", "RETURN", { patientId: "p2" }));

    const result = await cancelTrip(INITIAL_ACTION_RESULT, form({ tripId: "t1", reason: "PATIENT", returnTripId: "t9" }));

    expect(result.ok).toBe(false);
    expect(fake.trip.updateMany).not.toHaveBeenCalled();
  });

  it("marks a cancellation within the setting's hours of the pickup as late", async () => {
    const soon = new Date(Date.now() + 30 * 60_000);
    const paris = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .format(soon)
      .split(":")
      .map(Number) as [number, number];
    const isoDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(soon);
    rows.set(
      "t1",
      tripRow("t1", "OUTBOUND", { serviceDate: new Date(`${isoDate}T00:00:00.000Z`), plannedPickupMinute: paris[0] * 60 + paris[1] }),
    );

    const result = await cancelTrip(INITIAL_ACTION_RESULT, form({ tripId: "t1", reason: "PATIENT" }));

    expect(fake.trip.updateMany.mock.calls[0]![0].data.lateCancellation).toBe(true);
    expect(result.message).toMatch(/Annulation tardive\./);
  });

  it("cancels nothing when the trip changed meanwhile", async () => {
    rows.set("t1", tripRow("t1", "OUTBOUND"));
    fake.trip.updateMany.mockResolvedValue({ count: 0 });

    const result = await cancelTrip(INITIAL_ACTION_RESULT, form({ tripId: "t1", reason: "PATIENT" }));

    expect(result).toEqual({ ok: false, message: "La course a changé entre-temps\u00a0: rechargez la page." });
    expect(recorded()).toEqual([]);
  });
});

describe("cancelTrips («\u202fAnnuler la sélection\u202f»)", () => {
  function bulk(ids: string[], entries: Record<string, string>): FormData {
    const fd = form(entries);
    for (const id of ids) fd.append("tripId", id);
    return fd;
  }

  it("refuses without a reason or without a trip, writing nothing", async () => {
    expect(await cancelTrips(INITIAL_ACTION_RESULT, bulk(["t1"], {}))).toEqual({ ok: false, message: "Choisissez le motif de l'annulation." });
    expect(await cancelTrips(INITIAL_ACTION_RESULT, bulk([], { reason: "FACILITY" }))).toEqual({ ok: false, message: "Cochez au moins une course." });
    expect(await cancelTrips(INITIAL_ACTION_RESULT, bulk(["t1"], { reason: "OTHER" }))).toEqual({ ok: false, message: "Précisez le motif de l'annulation." });
    expect(fake.trip.updateMany).not.toHaveBeenCalled();
  });

  it("cancels each open trip with the reason, one trace per trip, and leaves a started or changed one", async () => {
    fake.trip.findMany.mockResolvedValueOnce([
      tripRow("t1", "OUTBOUND"),
      tripRow("t2", "RETURN", { status: "ASSIGNED", routeId: "r1", route: { status: "PROPOSED" } }),
      tripRow("t3", "OUTBOUND", { status: "PICKED_UP" }),
      tripRow("t4", "OUTBOUND", { patientId: "p2" }),
    ]);
    // t4 changed between the read and the write.
    fake.trip.updateMany.mockImplementation(async ({ where }: { where: { id: string } }) => ({ count: where.id === "t4" ? 0 : 1 }));

    const result = await cancelTrips(INITIAL_ACTION_RESULT, bulk(["t1", "t2", "t3", "t4", "t1"], { reason: "FACILITY", note: "centre fermé" }));

    expect(fake.trip.findMany.mock.calls[0]![0].where).toEqual({ id: { in: ["t1", "t2", "t3", "t4"] } });
    expect(fake.trip.updateMany.mock.calls.map(([args]) => args.where)).toEqual([
      { id: "t1", status: "PLANNED" },
      { id: "t2", status: "ASSIGNED" },
      { id: "t4", status: "PLANNED" },
    ]);
    expect(fake.trip.updateMany.mock.calls[0]![0].data).toMatchObject({
      status: "CANCELLED",
      routeId: null,
      cancellationReason: "FACILITY",
      cancellationOrigin: "USER",
      cancellationNote: "centre fermé",
      cancelledById: "u1",
    });
    expect(recorded()).toEqual([
      { action: "trip.cancel", entityId: "t1" },
      { action: "trip.cancel", entityId: "t2" },
    ]);
    const details = fake.auditEvent.createMany.mock.calls.map((call) => (call[0] as { data: { details?: unknown }[] }).data[0]?.details);
    expect(details).toEqual([{ bulk: true }, { bulk: true }]);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(
      /^2 courses annulées \(séance annulée ou déplacée par l'établissement\), dont 1 retirée de sa tournée\. 2 courses non annulées\u00a0: déjà commencées, terminées ou modifiées entre-temps\./,
    );
  });

  it("locks the routes of the batch first, and does not call a co-passenger cancelled in the batch alone", async () => {
    // t1 and t2 share route r1; both are ticked.
    let stops = [
      { id: "s0", routeId: "r1", tripId: "t1", kind: "PICKUP", sequence: 0, loadAfter: 1 },
      { id: "s1", routeId: "r1", tripId: "t2", kind: "PICKUP", sequence: 1, loadAfter: 2 },
      { id: "s2", routeId: "r1", tripId: "t1", kind: "DROPOFF", sequence: 2, loadAfter: 1 },
      { id: "s3", routeId: "r1", tripId: "t2", kind: "DROPOFF", sequence: 3, loadAfter: 0 },
    ];
    const steps: string[] = [];
    fake.routeStop.findMany.mockImplementation(async ({ where }: { where: { tripId?: string | { in: string[] }; routeId?: { in: string[] } } }) => {
      const { tripId } = where;
      if (typeof tripId === "object") return stops.filter((s) => tripId.in.includes(s.tripId));
      return stops.filter((s) => (tripId !== undefined ? s.tripId === tripId : where.routeId?.in.includes(s.routeId)));
    });
    fake.routeStop.deleteMany.mockImplementation(async ({ where }: { where: { tripId: string } }) => {
      stops = stops.filter((s) => s.tripId !== where.tripId);
      return { count: 2 };
    });
    fake.routeStop.update.mockResolvedValue({});
    fake.$queryRaw.mockImplementation(async () => {
      steps.push("lock");
      return [{ id: "r1" }];
    });
    fake.trip.updateMany.mockImplementation(async ({ where }: { where: { id: string | { in: string[] } } }) => {
      steps.push(typeof where.id === "string" ? `cancel ${where.id}` : `unshare ${where.id.in.join(",")}`);
      return { count: 1 };
    });
    const routed = { routeId: "r1", route: { status: "PROPOSED" }, status: "ASSIGNED" };
    fake.trip.findMany.mockResolvedValueOnce([tripRow("t1", "OUTBOUND", routed), tripRow("t2", "OUTBOUND", { ...routed, patientId: "p2" })]);

    const result = await cancelTrips(INITIAL_ACTION_RESULT, bulk(["t1", "t2"], { reason: "FACILITY" }));

    // The batch's routes are locked before the first trip is written.
    expect(steps[0]).toBe("lock");
    expect(steps.indexOf("cancel t1")).toBeGreaterThan(0);
    // t2 was left alone by t1's removal, then cancelled too: not « travelling alone ».
    expect(steps).toContain("unshare t2");
    expect(result.ok).toBe(true);
    expect(result.message).not.toMatch(/seul/);
  });

  it("says so when nothing could be cancelled", async () => {
    fake.trip.findMany.mockResolvedValueOnce([tripRow("t3", "OUTBOUND", { status: "DROPPED_OFF" })]);
    const result = await cancelTrips(INITIAL_ACTION_RESULT, bulk(["t3"], { reason: "PATIENT" }));
    expect(result).toEqual({ ok: false, message: "Aucune course annulée. 1 course non annulée\u00a0: déjà commencée, terminée ou modifiée entre-temps." });
    expect(recorded()).toEqual([]);
  });
});

describe("generation of the recurring trips", () => {
  const today = todayIso();
  const tomorrow = addDays(today, 1);
  afterEach(() => {
    vi.useRealTimers();
  });

  it("generates the week from tomorrow at the earliest, and names the recurrences without a valid prescription", async () => {
    // A Wednesday: the current week still has days from tomorrow on (on a Sunday it would be over).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-11T09:00:00.000Z"));
    const weekStart = startOfIsoWeek(todayIso());
    fake.completeTrips.mockResolvedValue({
      created: 3,
      revived: 0,
      createdByDay: new Map(),
      skipped: [{ recurrenceId: "r1", patientId: "p1", patientName: "MARTIN Jean", label: "Dialyse", dates: [tomorrow] }],
    });
    const fd = new FormData();
    fd.set("weekStart", weekStart);

    const result = await generateWeekTrips({ ok: false, message: null, skipped: [] }, fd);

    const range = fake.completeTrips.mock.calls[0]![2];
    expect(weekStart).toBe("2026-11-09");
    expect(range).toEqual({ from: "2026-11-12", to: "2026-11-15" });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/3 courses créées\.$/);
    expect(result.skipped.map((r) => r.patientName)).toEqual(["MARTIN Jean"]);
  });

  it("refuses a week already over, writing nothing", async () => {
    const fd = new FormData();
    fd.set("weekStart", "2020-01-06");

    const result = await generateWeekTrips({ ok: false, message: null, skipped: [] }, fd);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/déjà passée/);
    expect(fake.completeTrips).not.toHaveBeenCalled();
  });

  it("completes a date of the horizon once its page is shown, and nothing outside it", async () => {
    fake.completeTrips.mockResolvedValue({ created: 2, revived: 1, createdByDay: new Map(), skipped: [] });
    expect(await completeDayTrips(tomorrow)).toEqual({ changed: true });
    fake.completeTrips.mockRejectedValueOnce(new Error("database down"));
    expect(await completeDayTrips(tomorrow)).toEqual({ changed: false, failed: true });
    expect(fake.completeTrips.mock.calls[0]![2]).toEqual({ from: tomorrow, to: tomorrow });

    fake.completeTrips.mockClear();
    expect(await completeDayTrips(today)).toEqual({ changed: false });
    expect(await completeDayTrips(addDays(today, 15))).toEqual({ changed: false });
    expect(await completeDayTrips("demain")).toEqual({ changed: false });
    expect(fake.completeTrips).not.toHaveBeenCalled();
  });
});

describe("restoreTrip", () => {
  const today = todayIso();
  /** A cancelled CPAM outbound trip of tomorrow, as restoreTrip reads it. */
  function cancelled(overrides: Record<string, unknown> = {}) {
    return {
      id: "t1",
      status: "CANCELLED",
      serviceDate: new Date(`${addDays(today, 1)}T00:00:00.000Z`),
      payer: "CPAM",
      patientId: "p1",
      recurrenceId: "rec1",
      facilityId: "f1",
      direction: "OUTBOUND",
      appointmentMinute: 450,
      readyMinute: null,
      patient: { active: true },
      recurrence: { active: true },
      prescription: { validFrom: new Date("2020-01-01T00:00:00.000Z"), validTo: new Date("2099-12-31T00:00:00.000Z") },
      ...overrides,
    };
  }

  it("refuses an inactive patient, a past date or a CPAM trip without a valid prescription, writing nothing", async () => {
    for (const overrides of [
      { patient: { active: false } },
      { recurrence: { active: false } },
      { serviceDate: new Date(`${addDays(today, -1)}T00:00:00.000Z`) },
      { prescription: null },
    ]) {
      fake.trip.findUnique.mockResolvedValueOnce(cancelled(overrides));
      const result = await restoreTrip(INITIAL_ACTION_RESULT, form({ tripId: "t1" }));
      expect(result.ok).toBe(false);
    }
    expect(fake.trip.updateMany).not.toHaveBeenCalled();
  });

  it("restores the trip, clears its cancellation and warns about another outbound trip of the patient that day", async () => {
    fake.trip.findUnique.mockResolvedValue(cancelled());
    fake.trip.findMany.mockResolvedValue([
      { id: "t1", patientId: "p1", recurrenceId: "rec1", facilityId: "f1", direction: "OUTBOUND", status: "CANCELLED", appointmentMinute: 450, readyMinute: null },
      { id: "t9", patientId: "p1", recurrenceId: null, facilityId: "f1", direction: "OUTBOUND", status: "PLANNED", appointmentMinute: 455, readyMinute: null },
    ]);

    const result = await restoreTrip(INITIAL_ACTION_RESULT, form({ tripId: "t1" }));

    expect(fake.trip.updateMany.mock.calls[0]![0].data).toMatchObject({
      status: "PLANNED",
      cancellationReason: null,
      cancellationOrigin: null,
      cancelledAt: null,
    });
    expect(recorded()).toEqual([{ action: "trip.restore", entityId: "t1" }]);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/Attention\u00a0: Le patient a déjà un aller ce jour \(RDV 07:35\)\. Vérifiez/);
  });
});
