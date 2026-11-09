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
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    },
    getCurrentUser: vi.fn(),
    renewDriverSession: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "Test/1.0" }) }));
vi.mock("@/lib/db", () => ({ db: fake.db }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: fake.getCurrentUser }));
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
  fake.getCurrentUser.mockResolvedValue(DRIVER);
  fake.renewDriverSession.mockResolvedValue(new Date("2026-11-09T19:25:00.000Z"));
  fake.tx.routeStop.updateMany.mockResolvedValue({ count: 1 });
  fake.tx.trip.updateMany.mockResolvedValue({ count: 1 });
  fake.tx.auditEvent.createMany.mockResolvedValue({ count: 1 });
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
      data: { completedAt: new Date(gesture), completedById: "u1", completedReceivedAt: NOW },
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

  it("answers 401 without a current session (the phone keeps the status), before reading anything", async () => {
    fake.getCurrentUser.mockResolvedValue(null);
    const { status, body } = await answer(await post("s_pick", { action: "PICKUP", observedAt: NOW.getTime() }));
    expect(status).toBe(401);
    expect(body).toMatchObject({ ok: false, code: "session" });
    expect(fake.db.routeStop.findUnique).not.toHaveBeenCalled();
    expect(fake.renewDriverSession).not.toHaveBeenCalled();

    fake.getCurrentUser.mockResolvedValue({ ...DRIVER, role: "REGULATOR", driverId: null });
    expect((await post("s_pick", { action: "PICKUP" })).status).toBe(401);
  });

  it("waits for the password change of a provisional password", async () => {
    fake.getCurrentUser.mockResolvedValue({ ...DRIVER, mustChangePassword: true });
    const { status, body } = await answer(await post("s_pick", { action: "PICKUP" }));
    expect(status).toBe(403);
    expect(body).toMatchObject({ code: "password" });
  });

  it("refuses a request from another site", async () => {
    const { status, body } = await answer(await post("s_pick", { action: "PICKUP" }, { origin: "https://evil.example" }));
    expect(status).toBe(403);
    expect(body).toMatchObject({ code: "origin" });
    expect(fake.getCurrentUser).not.toHaveBeenCalled();
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

  it("refuses a status tapped more than 3 h ago, and writes nothing", async () => {
    stops([pickup()], "s_pick");
    const { status, body } = await answer(
      await post("s_pick", { action: "PICKUP", observedAt: NOW.getTime() - 3 * 60 * MIN - MIN, sentAt: NOW.getTime() }),
    );
    expect(status).toBe(422);
    expect(body).toMatchObject({ ok: false, code: "too-old" });
    expect(fake.db.$transaction).not.toHaveBeenCalled();
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

  it("refuses what the rules refuse, without writing", async () => {
    stops([pickup("CANCELLED")], "s_pick");
    const { status, body } = await answer(await post("s_pick", { action: "PICKUP", observedAt: NOW.getTime() }));
    expect(status).toBe(409);
    expect(body).toMatchObject({ ok: false, code: "refused", error: "Course annulée par la régulation : statut non modifiable." });
    expect(fake.db.$transaction).not.toHaveBeenCalled();
  });

  it("undoes the latest status and clears its time, author and reception", async () => {
    stops([pickup("PICKED_UP", new Date(NOW.getTime() - 5 * MIN))], "s_pick");
    const { body } = await answer(await post("s_pick", { action: "UNDO", observedAt: NOW.getTime() }));
    expect(body).toMatchObject({ ok: true, outcome: "applied", message: "Statut annulé." });
    expect(fake.tx.routeStop.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { completedAt: null, completedById: null, completedReceivedAt: null } }),
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
});
