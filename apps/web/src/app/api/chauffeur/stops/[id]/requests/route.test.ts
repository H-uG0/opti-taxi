import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

// The crew's signals and requests (DAY-05) against a fake Prisma client: who may send them, from which stop, the end
// of session written at once (guarded) with its trace, the requests that wait for the regulator, never twice.
const fake = vi.hoisted(() => {
  const tx = {
    trip: { findMany: vi.fn(), updateMany: vi.fn() },
    fieldRequest: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    auditEvent: { createMany: vi.fn() },
  };
  return {
    tx,
    db: {
      routeStop: { findUnique: vi.fn() },
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
// Monday 9 November 2026, 10:05 in Paris.
const NOW = new Date("2026-11-09T09:05:00.000Z");
const DAY = new Date("2026-11-09T00:00:00.000Z");
const ROUTE = { serviceDate: DAY, driverId: "d1", crewMateId: null };

const outbound = { id: "t_out", status: "DROPPED_OFF", direction: "OUTBOUND", serviceDate: DAY, appointmentMinute: 600, readyMinute: null, patientId: "p1", recurrenceId: "rec1", facilityId: "f1" };
const back = { id: "t_back", status: "ASSIGNED", direction: "RETURN", serviceDate: DAY, appointmentMinute: null, readyMinute: 705, patientId: "p1", recurrenceId: "rec1", facilityId: "f1" };

function stop(kind: "PICKUP" | "DROPOFF", trip: Record<string, unknown>, completedAt: Date | null = null, route = ROUTE) {
  fake.db.routeStop.findUnique.mockResolvedValue({ id: "s1", kind, completedAt, route, trip });
}

function post(body: unknown) {
  const request = new NextRequest("http://localhost:3100/api/chauffeur/stops/s1/requests", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3100", host: "localhost:3100" },
    body: JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ id: "s1" }) });
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
  fake.renewDriverSession.mockResolvedValue(null);
  fake.tx.trip.findMany.mockResolvedValue([back]);
  fake.tx.trip.updateMany.mockResolvedValue({ count: 1 });
  fake.tx.fieldRequest.findFirst.mockResolvedValue(null);
  fake.tx.fieldRequest.create.mockResolvedValue({ id: "req1" });
  fake.tx.fieldRequest.updateMany.mockResolvedValue({ count: 0 });
  fake.tx.auditEvent.createMany.mockResolvedValue({ count: 1 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/chauffeur/stops/:id/requests", () => {
  it("writes the end of session on the return at once, guarded, with its request and both audit events", async () => {
    stop("DROPOFF", outbound, new Date("2026-11-09T08:58:00.000Z"));
    const { status, body } = await answer(await post({ kind: "READY_TIME", readyMinute: 680, ownerId: "u1" }));
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, message: "Fin de séance transmise\u00a0: retour prêt à 11:20." });
    expect(fake.tx.trip.updateMany).toHaveBeenCalledWith({
      where: { id: "t_back", readyMinute: 705, status: { in: ["PLANNED", "ASSIGNED"] } },
      data: { readyMinute: 680 },
    });
    expect(fake.tx.fieldRequest.create).toHaveBeenCalledWith({
      data: { serviceDate: DAY, kind: "READY_TIME", tripId: "t_back", readyMinute: 680, previousReadyMinute: 705, createdById: "u1", createdAt: NOW },
      select: { id: true },
    });
    expect(auditEvents()).toEqual([
      expect.objectContaining({ action: "trip.ready_time", entityId: "t_back", details: { from: 705, to: 680, source: "field" } }),
      expect.objectContaining({ action: "field_request.create", entityId: "t_back", details: { kind: "READY_TIME", requestId: "req1" } }),
    ]);
  });

  it("refuses an end of session before the appointment, and answers a conflict when the return changed meanwhile", async () => {
    stop("DROPOFF", outbound);
    expect((await answer(await post({ kind: "READY_TIME", readyMinute: 590 }))).body).toMatchObject({ ok: false, code: "invalid" });
    fake.tx.trip.updateMany.mockResolvedValue({ count: 0 });
    expect(await answer(await post({ kind: "READY_TIME", readyMinute: 690 }))).toMatchObject({ status: 409, body: { ok: false, code: "conflict" } });
  });

  it("asks for a return only when none is planned, and only once", async () => {
    stop("DROPOFF", outbound);
    expect((await answer(await post({ kind: "RETURN", readyMinute: 700 }))).body).toMatchObject({ ok: false, code: "refused" });
    fake.tx.trip.findMany.mockResolvedValue([]);
    expect((await answer(await post({ kind: "RETURN", readyMinute: 700 }))).body).toMatchObject({ ok: true, message: "Demande de retour envoyée à la régulation." });
    expect(fake.tx.fieldRequest.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ kind: "RETURN", tripId: "t_out", readyMinute: 700 }) }));
    fake.tx.fieldRequest.findFirst.mockResolvedValue({ id: "req1" });
    expect((await answer(await post({ kind: "RETURN", readyMinute: 700 }))).body).toMatchObject({ ok: true, message: "Demande de retour déjà envoyée, en attente de la régulation." });
  });

  it("asks for the cancellation of a pickup still to do with a reason, never in the audit trail", async () => {
    stop("PICKUP", { ...back, id: "t_pick" });
    expect((await answer(await post({ kind: "CANCEL" }))).body).toMatchObject({ ok: false, code: "invalid" });
    expect((await answer(await post({ kind: "CANCEL", reason: "HOSPITALIZATION" }))).body).toMatchObject({ ok: true });
    expect(fake.tx.fieldRequest.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ kind: "CANCEL", tripId: "t_pick", cancellationReason: "HOSPITALIZATION" }) }));
    expect(JSON.stringify(auditEvents())).not.toContain("HOSPITALIZATION");
    stop("PICKUP", { ...back, id: "t_pick" }, new Date("2026-11-09T08:58:00.000Z"));
    expect((await answer(await post({ kind: "CANCEL", reason: "PATIENT" }))).body).toMatchObject({ ok: false, code: "refused" });
  });

  it("passes the next session on, after the day of service", async () => {
    stop("DROPOFF", outbound);
    expect((await answer(await post({ kind: "NEXT_SESSION", nextSessionDate: "2026-11-09" }))).body).toMatchObject({ ok: false, code: "invalid" });
    expect((await answer(await post({ kind: "NEXT_SESSION", nextSessionDate: "2026-11-11" }))).body).toMatchObject({ ok: true });
    expect(fake.tx.fieldRequest.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ kind: "NEXT_SESSION", nextSessionDate: new Date("2026-11-11T00:00:00.000Z") }) }));
  });

  it("refuses someone else's stop, another day, another account's page and a request from another site", async () => {
    stop("DROPOFF", outbound, null, { ...ROUTE, driverId: "d9" });
    expect(await answer(await post({ kind: "NEXT_SESSION", nextSessionDate: "2026-11-11" }))).toMatchObject({ status: 403, body: { code: "not-yours" } });
    stop("DROPOFF", outbound, null, { ...ROUTE, serviceDate: new Date("2026-11-10T00:00:00.000Z") });
    expect(await answer(await post({ kind: "NEXT_SESSION", nextSessionDate: "2026-11-11" }))).toMatchObject({ status: 403, body: { code: "wrong-day" } });
    stop("DROPOFF", outbound);
    expect(await answer(await post({ kind: "NEXT_SESSION", nextSessionDate: "2026-11-11", ownerId: "u2" }))).toMatchObject({ status: 401 });
    const foreign = new NextRequest("http://localhost:3100/api/chauffeur/stops/s1/requests", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example", host: "localhost:3100" },
      body: JSON.stringify({ kind: "NEXT_SESSION", nextSessionDate: "2026-11-11" }),
    });
    expect((await POST(foreign, { params: Promise.resolve({ id: "s1" }) })).status).toBe(403);
    expect(fake.tx.fieldRequest.create).not.toHaveBeenCalled();
  });
});
