import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

// The status route against a fake Prisma client: who may record, the time recorded (the gesture,
// bounded), idempotent replays, guarded writes with their audit event, and the answers the phone's
// queue reads (keep the status, or drop it with a reason).
const fake = vi.hoisted(() => {
  const tx = {
    routeStop: { updateMany: vi.fn() },
    trip: { updateMany: vi.fn() },
    auditEvent: { createMany: vi.fn() },
  };
  return {
    tx,
    db: {
      routeStop: { findUnique: vi.fn(), findMany: vi.fn() },
      appSettings: { findUnique: vi.fn() },
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    },
    currentDriver: vi.fn(),
    renewDriverSession: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "Test/1.0" }) }));
vi.mock("@/lib/db", () => ({ db: fake.db }));
vi.mock("@/lib/auth", () => ({ currentDriver: fake.currentDriver }));
vi.mock("@/lib/auth/session", () => ({ renewDriverSession: fake.renewDriverSession }));

const DRIVER = { id: "u1", name: "Julien Marchetti", role: "DRIVER", driverId: "d1", mustChangePassword: false };
// Monday 9 November 2026, 08:25 in Paris (winter time).
const NOW = new Date("2026-11-09T07:25:00.000Z");
const MIN = 60_000;
type Route = { id: string; serviceDate: Date; driverId: string | null; crewMateId: string | null };
const ROUTE: Route = { id: "r1", serviceDate: new Date("2026-11-09T00:00:00.000Z"), driverId: "d1", crewMateId: "d2" };

type StopRow = { id: string; sequence: number; kind: "PICKUP" | "DROPOFF"; tripId: string; completedAt: Date | null; trip: { status: string } };

function stops(rows: StopRow[], target: string, route: Route = ROUTE) {
  const stop = rows.find((row) => row.id === target);
  fake.db.routeStop.findUnique.mockResolvedValue(stop ? { ...stop, route } : null);
  fake.db.routeStop.findMany.mockResolvedValue(rows);
}

const pickup = (status = "ASSIGNED", completedAt: Date | null = null): StopRow => ({
  id: "s_pick",
  sequence: 1,
  kind: "PICKUP",
  tripId: "t1",
  completedAt,
  trip: { status },
});
const dropoff = (status = "PICKED_UP", completedAt: Date | null = null): StopRow => ({
  id: "s_drop",
  sequence: 2,
  kind: "DROPOFF",
  tripId: "t1",
  completedAt,
  trip: { status },
});

function post(stopId: string, body: unknown, headers: Record<string, string> = {}) {
  const request = new NextRequest(`http://localhost:3100/api/chauffeur/stops/${stopId}/status`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3100", host: "localhost:3100", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ id: stopId }) });
}

async function answer(response: Response) {
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function auditEvents(): Record<string, unknown>[] {
  return fake.tx.auditEvent.createMany.mock.calls.flatMap((call) => call[0].data as Record<string, unknown>[]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fake.currentDriver.mockResolvedValue({ ok: true, driver: DRIVER });
  fake.renewDriverSession.mockResolvedValue(new Date("2026-11-09T19:25:00.000Z"));
  fake.tx.routeStop.updateMany.mockResolvedValue({ count: 1 });
  fake.tx.trip.updateMany.mockResolvedValue({ count: 1 });
  fake.tx.auditEvent.createMany.mockResolvedValue({ count: 1 });
  fake.db.appSettings.findUnique.mockResolvedValue({ noShowMinWaitMin: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/chauffeur/stops/:id/status", () => {
  it("records a status sent later from the queue at the time of the gesture, with its reception and author", async () => {
    stops([pickup(), dropoff("ASSIGNED")], "s_pick");
    const gesture = NOW.getTime() - 23 * MIN;
    const { status, body } = await answer(await post("s_pick", { action: "PICKUP", observedAt: gesture, sentAt: NOW.getTime() }));

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, outcome: "applied", message: "Prise en charge enregistrée.", sessionExpiresAt: "2026-11-09T19:25:00.000Z" });
    expect(fake.tx.routeStop.updateMany).toHaveBeenCalledWith({
      where: { id: "s_pick", completedAt: null },
      data: { completedAt: new Date(gesture), completedById: "u1", completedReceivedAt: NOW, completedSource: null, correctionReason: null },
    });
    expect(fake.tx.trip.updateMany).toHaveBeenCalledWith({ where: { id: "t1", status: "ASSIGNED" }, data: { status: "PICKED_UP" } });
    expect(auditEvents()).toEqual([
      expect.objectContaining({
        userId: "u1",
        action: "stop.pickup",
        entity: "Trip",
        entityId: "t1",
        details: { observedAt: new Date(gesture).toISOString() },
      }),
    ]);
    expect(fake.renewDriverSession).toHaveBeenCalledWith(DRIVER, NOW);
  });

  it("writes no observed time in the audit for a status sent live", async () => {
    stops([pickup()], "s_pick");
    await post("s_pick", { action: "PICKUP", observedAt: NOW.getTime() - 2000, sentAt: NOW.getTime() - 1000 });
    expect(auditEvents()[0]).not.toHaveProperty("details");
  });

  it("answers 401 without a current driver session (the phone keeps the status), before reading anything", async () => {
    fake.currentDriver.mockResolvedValue({ ok: false, reason: "session" });
    const { status, body } = await answer(await post("s_pick", { action: "PICKUP", observedAt: NOW.getTime() }));
    expect(status).toBe(401);
    expect(body).toMatchObject({ ok: false, code: "session" });
    expect(fake.db.routeStop.findUnique).not.toHaveBeenCalled();
    expect(fake.renewDriverSession).not.toHaveBeenCalled();
  });

  it("waits for the password change of a provisional password", async () => {
    fake.currentDriver.mockResolvedValue({ ok: false, reason: "password" });
    const { status, body } = await answer(await post("s_pick", { action: "PICKUP" }));
    expect(status).toBe(403);
    expect(body).toMatchObject({ code: "password" });
  });

  it("never records a status from another account's queue under this session: it waits for its owner", async () => {
    stops([pickup()], "s_pick");
    const { status, body } = await answer(await post("s_pick", { action: "PICKUP", observedAt: NOW.getTime(), ownerId: "u2" }));
    expect(status).toBe(401);
    expect(body).toMatchObject({ ok: false, code: "session" });
    expect(fake.db.routeStop.findUnique).not.toHaveBeenCalled();
    expect(fake.renewDriverSession).not.toHaveBeenCalled();

    const own = await post("s_pick", { action: "PICKUP", observedAt: NOW.getTime(), ownerId: "u1" });
    expect(own.status).toBe(200);
  });

  it("refuses a request from another site", async () => {
    const { status, body } = await answer(await post("s_pick", { action: "PICKUP" }, { origin: "https://evil.example" }));
    expect(status).toBe(403);
    expect(body).toMatchObject({ code: "origin" });
    expect(fake.currentDriver).not.toHaveBeenCalled();
  });

  it("refuses an unreadable body", async () => {
    for (const body of ["not json", { action: "DELETE" }, { action: "PICKUP", observedAt: "08:02" }]) {
      const { status, body: reply } = await answer(await post("s_pick", body));
      expect(status).toBe(400);
      expect(reply).toMatchObject({ code: "invalid" });
    }
    expect(fake.db.routeStop.findUnique).not.toHaveBeenCalled();
  });

  it("gives the same answer for a missing stop and another crew's stop", async () => {
    stops([pickup()], "s_pick", { ...ROUTE, driverId: "d7", crewMateId: null });
    const other = await answer(await post("s_pick", { action: "PICKUP", observedAt: NOW.getTime() }));
    stops([], "s_gone");
    const missing = await answer(await post("s_gone", { action: "PICKUP", observedAt: NOW.getTime() }));
    expect(other.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(other.body.error).toBe(missing.body.error);
    expect(fake.db.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a status tapped more than 3\u00a0h ago, and writes nothing", async () => {
    stops([pickup()], "s_pick");
    const { status, body } = await answer(
      await post("s_pick", { action: "PICKUP", observedAt: NOW.getTime() - 3 * 60 * MIN - MIN, sentAt: NOW.getTime() }),
    );
    expect(status).toBe(422);
    expect(body).toMatchObject({ ok: false, code: "too-old" });
    expect(fake.db.$transaction).not.toHaveBeenCalled();
  });

  it("never records a status before one already recorded on an earlier stop of the route", async () => {
    // The crew mate recorded stop 2 at 08:15; a pickup on stop 3 tapped offline at 08:00 arrives at 08:25.
    const earlierAt = new Date(NOW.getTime() - 10 * MIN);
    const later: StopRow = { id: "s_next", sequence: 3, kind: "PICKUP", tripId: "t2", completedAt: null, trip: { status: "ASSIGNED" } };
    stops([pickup("PICKED_UP", new Date(NOW.getTime() - 40 * MIN)), dropoff("DROPPED_OFF", earlierAt), later], "s_next");
    await post("s_next", { action: "PICKUP", observedAt: NOW.getTime() - 25 * MIN, sentAt: NOW.getTime() });
    expect(fake.tx.routeStop.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ completedAt: earlierAt }) }),
    );
  });

  it("never records a dropoff before its trip's pickup, nor a status in the future", async () => {
    const pickedAt = new Date(NOW.getTime() - 10 * MIN);
    stops([pickup("PICKED_UP", pickedAt), dropoff("PICKED_UP")], "s_drop");
    await post("s_drop", { action: "DROPOFF", observedAt: NOW.getTime() - 15 * MIN, sentAt: NOW.getTime() });
    expect(fake.tx.routeStop.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ completedAt: pickedAt }) }),
    );

    stops([pickup()], "s_pick");
    await post("s_pick", { action: "PICKUP", observedAt: NOW.getTime() + 30 * MIN });
    expect(fake.tx.routeStop.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ completedAt: NOW }) }));
  });

  it("counts a status tapped before midnight on its own day, and refuses another day's route", async () => {
    // Tapped at 23:55 on the 8th (Paris), received at 00:05 on the 9th.
    vi.setSystemTime(new Date("2026-11-08T23:05:00.000Z"));
    const yesterday = { ...ROUTE, serviceDate: new Date("2026-11-08T00:00:00.000Z") };
    stops([pickup()], "s_pick", yesterday);
    const late = await post("s_pick", { action: "PICKUP", observedAt: Date.parse("2026-11-08T22:55:00.000Z"), sentAt: Date.now() });
    expect(late.status).toBe(200);

    vi.setSystemTime(NOW);
    stops([pickup()], "s_pick", yesterday);
    const { status, body } = await answer(await post("s_pick", { action: "PICKUP", observedAt: NOW.getTime() }));
    expect(status).toBe(403);
    expect(body).toMatchObject({ code: "wrong-day" });
  });

  it("is idempotent: a replay after a lost answer succeeds without writing", async () => {
    stops([pickup("PICKED_UP", new Date(NOW.getTime() - 5 * MIN))], "s_pick");
    const { status, body } = await answer(await post("s_pick", { action: "PICKUP", observedAt: NOW.getTime() - 5 * MIN }));
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, outcome: "noop" });
    expect(fake.db.$transaction).not.toHaveBeenCalled();
  });

  it("acknowledges an old replay of a status already recorded instead of calling it too old", async () => {
    // Last dropoff of the evening (19:10, the 8th), saved but its answer lost; sent again at 08:25 the next morning.
    const droppedAt = new Date("2026-11-08T18:10:00.000Z");
    const yesterday = { ...ROUTE, serviceDate: new Date("2026-11-08T00:00:00.000Z") };
    const pickedAt = new Date(droppedAt.getTime() - 20 * MIN);
    stops([pickup("DROPPED_OFF", pickedAt), dropoff("DROPPED_OFF", droppedAt)], "s_drop", yesterday);
    const { status, body } = await answer(
      await post("s_drop", { action: "DROPOFF", observedAt: droppedAt.getTime(), sentAt: NOW.getTime() }),
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, outcome: "noop", message: "Dépose déjà enregistrée." });
    expect(fake.db.$transaction).not.toHaveBeenCalled();
  });

  it("refuses what the rules refuse, without writing", async () => {
    stops([pickup("CANCELLED")], "s_pick");
    const { status, body } = await answer(await post("s_pick", { action: "PICKUP", observedAt: NOW.getTime() }));
    expect(status).toBe(409);
    expect(body).toMatchObject({ ok: false, code: "refused", error: "Course annulée par la régulation\u00a0: statut non modifiable." });
    expect(fake.db.$transaction).not.toHaveBeenCalled();
  });

  it("undoes the latest status and clears its time, author and reception", async () => {
    stops([pickup("PICKED_UP", new Date(NOW.getTime() - 5 * MIN))], "s_pick");
    const { body } = await answer(await post("s_pick", { action: "UNDO", observedAt: NOW.getTime() }));
    expect(body).toMatchObject({ ok: true, outcome: "applied", message: "Statut annulé." });
    expect(fake.tx.routeStop.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { completedAt: null, completedById: null, completedReceivedAt: null, completedSource: null, correctionReason: null } }),
    );
    expect(auditEvents()).toEqual([expect.objectContaining({ action: "stop.undo_pickup" })]);
  });

  it("detects a change by the other crew member instead of overwriting it", async () => {
    stops([pickup()], "s_pick");
    fake.tx.routeStop.updateMany.mockResolvedValue({ count: 0 });
    const { status, body } = await answer(await post("s_pick", { action: "PICKUP", observedAt: NOW.getTime() }));
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: "conflict" });
  });

  it("asks the phone to keep the status on a database failure", async () => {
    stops([pickup()], "s_pick");
    fake.tx.routeStop.updateMany.mockRejectedValue(new Error("connection lost"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { status, body } = await answer(await post("s_pick", { action: "PICKUP", observedAt: NOW.getTime() }));
    expect(status).toBe(500);
    expect(body).toMatchObject({ ok: false, code: "server" });
  });

  it("is never stored by the browser", async () => {
    stops([pickup()], "s_pick");
    const response = await post("s_pick", { action: "PICKUP", observedAt: NOW.getTime() });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  describe("arrival and absence (FLD-01)", () => {
    // Planned start of the pickup: 08:10 (490), the clock is at 08:25.
    const atDoor = (status = "ASSIGNED", arrivedAt: Date | null = null, completedAt: Date | null = null) => ({
      ...pickup(status, completedAt),
      startMinute: 490,
      arrivedAt,
    });

    it("dates « Arrivé » at the gesture, guarded, without touching the status", async () => {
      stops([atDoor()], "s_pick");
      const gesture = NOW.getTime() - 4 * MIN;
      const { body } = await answer(await post("s_pick", { action: "ARRIVE", observedAt: gesture, sentAt: NOW.getTime() }));
      expect(body).toMatchObject({ ok: true, outcome: "applied", message: "Arrivée enregistrée." });
      expect(fake.tx.routeStop.updateMany).toHaveBeenCalledWith({
        where: { id: "s_pick", completedAt: null, arrivedAt: null },
        data: { arrivedAt: new Date(gesture) },
      });
      expect(fake.tx.trip.updateMany).not.toHaveBeenCalled();
      expect(auditEvents()).toEqual([expect.objectContaining({ action: "stop.arrive", entity: "Trip", entityId: "t1", details: { observedAt: new Date(gesture).toISOString() } })]);
    });

    it("undoes an arrival, and replays an arrival already there without writing", async () => {
      const arrived = new Date(NOW.getTime() - 10 * MIN);
      stops([atDoor("ASSIGNED", arrived)], "s_pick");
      expect((await answer(await post("s_pick", { action: "ARRIVE", observedAt: NOW.getTime() }))).body).toMatchObject({ outcome: "noop" });
      expect(fake.db.$transaction).not.toHaveBeenCalled();
      await post("s_pick", { action: "UNDO_ARRIVE", observedAt: NOW.getTime() });
      expect(fake.tx.routeStop.updateMany).toHaveBeenCalledWith({ where: { id: "s_pick", completedAt: null, arrivedAt: arrived }, data: { arrivedAt: null } });
      expect(auditEvents()).toEqual([expect.objectContaining({ action: "stop.undo_arrive" })]);
    });

    it("records the reason of an absence on the trip, never in the audit trail", async () => {
      stops([atDoor()], "s_pick");
      const { body } = await answer(await post("s_pick", { action: "NO_SHOW", observedAt: NOW.getTime(), reason: "HOSPITALIZED" }));
      expect(body).toMatchObject({ ok: true, outcome: "applied" });
      expect(fake.tx.trip.updateMany).toHaveBeenCalledWith({ where: { id: "t1", status: "ASSIGNED" }, data: { status: "NO_SHOW", noShowReason: "HOSPITALIZED" } });
      expect(JSON.stringify(auditEvents())).not.toContain("HOSPITALIZED");
    });

    it("refuses a reason that is not in the list", async () => {
      stops([atDoor()], "s_pick");
      const { status } = await answer(await post("s_pick", { action: "NO_SHOW", observedAt: NOW.getTime(), reason: "Chute dans l'escalier" }));
      expect(status).toBe(400);
    });

    it("clears the reason when the absence is undone", async () => {
      stops([atDoor("NO_SHOW", null, new Date(NOW.getTime() - 2 * MIN))], "s_pick");
      await post("s_pick", { action: "UNDO", observedAt: NOW.getTime() });
      expect(fake.tx.trip.updateMany).toHaveBeenCalledWith({ where: { id: "t1", status: "NO_SHOW" }, data: { status: "ASSIGNED", noShowReason: null } });
    });

    it("refuses an absence before the minimum wait set in Paramètres, counted from the arrival", async () => {
      fake.db.appSettings.findUnique.mockResolvedValue({ noShowMinWaitMin: 10 });
      // No arrival: « Arrivé » first.
      stops([atDoor()], "s_pick");
      let reply = await answer(await post("s_pick", { action: "NO_SHOW", observedAt: NOW.getTime(), reason: "NO_ANSWER" }));
      expect(reply).toMatchObject({ status: 409, body: { code: "wait" } });
      expect(String(reply.body.error)).toContain("touchez d'abord");
      // Arrived at 08:20 (after the planned 08:10): possible from 08:30, the clock says 08:25.
      stops([atDoor("ASSIGNED", new Date(NOW.getTime() - 5 * MIN))], "s_pick");
      reply = await answer(await post("s_pick", { action: "NO_SHOW", observedAt: NOW.getTime(), reason: "NO_ANSWER" }));
      expect(reply).toMatchObject({ status: 409, body: { code: "wait", error: "Attente minimale de 10\u00a0min avant une absence\u00a0: possible à partir de 08:30." } });
      expect(fake.db.$transaction).not.toHaveBeenCalled();
      // Arrived at 08:12: 13 min waited.
      stops([atDoor("ASSIGNED", new Date(NOW.getTime() - 13 * MIN))], "s_pick");
      reply = await answer(await post("s_pick", { action: "NO_SHOW", observedAt: NOW.getTime(), reason: "NO_ANSWER" }));
      expect(reply).toMatchObject({ status: 200, body: { ok: true } });
    });
  });
  describe("« Fin de tournée »: a forgotten status with its real time (FLD-02)", () => {
    // Monday 9 November, 01:30 in Paris: the Sunday 8's route is still open until 03:00.
    const NIGHT = new Date("2026-11-09T00:30:00.000Z");
    const SUNDAY: Route = { ...ROUTE, serviceDate: new Date("2026-11-08T00:00:00.000Z") };

    it("records it at the time typed on the day before until 03:00, says so on the stop and in the audit", async () => {
      vi.setSystemTime(NIGHT);
      stops([pickup("PICKED_UP", new Date("2026-11-08T16:05:00.000Z")), dropoff("PICKED_UP")], "s_drop", SUNDAY);
      // 17:40 on Sunday, Paris (16:40 UTC).
      const { status, body } = await answer(await post("s_drop", { action: "DROPOFF", observedAt: NIGHT.getTime(), declaredMinute: 17 * 60 + 40 }));
      expect(status).toBe(200);
      expect(body).toMatchObject({ ok: true, outcome: "applied" });
      const at = new Date("2026-11-08T16:40:00.000Z");
      expect(fake.tx.routeStop.updateMany).toHaveBeenCalledWith({
        where: { id: "s_drop", completedAt: null },
        data: { completedAt: at, completedById: "u1", completedReceivedAt: NIGHT, completedSource: "DECLARED", correctionReason: null },
      });
      expect(auditEvents()).toEqual([expect.objectContaining({ action: "stop.dropoff", details: { declaredAt: at.toISOString() } })]);
    });

    it("refuses the day before once 03:00 has passed, a time to come and a time out of the route's order", async () => {
      vi.setSystemTime(new Date("2026-11-09T02:10:00.000Z"));
      stops([pickup("PICKED_UP", new Date("2026-11-08T16:05:00.000Z")), dropoff("PICKED_UP")], "s_drop", SUNDAY);
      expect((await answer(await post("s_drop", { action: "DROPOFF", observedAt: 0, declaredMinute: 1060 }))).body).toMatchObject({ code: "wrong-day" });

      vi.setSystemTime(NOW);
      stops([pickup("PICKED_UP", new Date(NOW.getTime() - 30 * MIN)), dropoff("PICKED_UP")], "s_drop");
      // 09:00 is still to come (08:25 now).
      expect((await answer(await post("s_drop", { action: "DROPOFF", observedAt: 0, declaredMinute: 540 }))).body).toMatchObject({ code: "declared" });
      // 07:40, before the pickup recorded at 07:55.
      const early = await answer(await post("s_drop", { action: "DROPOFF", observedAt: 0, declaredMinute: 460 }));
      expect(early).toMatchObject({ status: 422, body: { code: "declared", error: "Heure avant le statut déjà saisi de l'arrêt précédent (07:55)\u00a0: vérifiez l'heure." } });
      expect(fake.db.$transaction).not.toHaveBeenCalled();
    });

    it("never takes an undo or an arrival with a time typed", async () => {
      stops([pickup()], "s_pick");
      expect((await answer(await post("s_pick", { action: "ARRIVE", observedAt: 0, declaredMinute: 480 }))).status).toBe(400);
    });
  });
});
