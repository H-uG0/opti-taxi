import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

// The crew's odometer readings (FLD-03) against a fake Prisma client: its own route on an open day, checked against
// every mileage known of the vehicle, an unusual jump only once confirmed, one reading per day and moment, audited.
const fake = vi.hoisted(() => {
  const tx = {
    odometerReading: { findUnique: vi.fn(), upsert: vi.fn() },
    auditEvent: { createMany: vi.fn() },
  };
  return {
    tx,
    db: {
      route: { findUnique: vi.fn() },
      fuelLog: { findMany: vi.fn() },
      odometerReading: { findMany: vi.fn() },
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
// Monday 16 November 2026, 06:10 in Paris.
const NOW = new Date("2026-11-16T05:10:00.000Z");
const DAY = new Date("2026-11-16T00:00:00.000Z");

function post(body: unknown) {
  const request = new NextRequest("http://localhost:3100/api/chauffeur/routes/r1/odometer", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3100", host: "localhost:3100" },
    body: JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ id: "r1" }) });
}

async function answer(response: Response) {
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const auditEvents = () => fake.tx.auditEvent.createMany.mock.calls.flatMap((call) => call[0].data as Record<string, unknown>[]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fake.currentDriver.mockResolvedValue({ ok: true, driver: DRIVER });
  fake.renewDriverSession.mockResolvedValue(null);
  fake.db.route.findUnique.mockResolvedValue({ vehicleId: "v1", serviceDate: DAY, driverId: "d1", crewMateId: null });
  fake.db.fuelLog.findMany.mockResolvedValue([{ date: new Date("2026-11-12T00:00:00.000Z"), odometerKm: 120_000 }]);
  fake.db.odometerReading.findMany.mockResolvedValue([{ serviceDate: new Date("2026-11-14T00:00:00.000Z"), km: 120_380, moment: "END" }]);
  fake.tx.odometerReading.findUnique.mockResolvedValue(null);
  fake.tx.odometerReading.upsert.mockResolvedValue({});
  fake.tx.auditEvent.createMany.mockResolvedValue({ count: 1 });
});
afterEach(() => vi.useRealTimers());

describe("POST /api/chauffeur/routes/:id/odometer (FLD-03)", () => {
  it("records the start of the day, with its author, and traces it on the vehicle", async () => {
    const { status, body } = await answer(await post({ moment: "START", km: 120_420, observedAt: NOW.getTime(), sentAt: NOW.getTime(), ownerId: "u1" }));
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, outcome: "applied", message: "Compteur au départ : 120 420 km enregistré." });
    expect(fake.tx.odometerReading.upsert).toHaveBeenCalledWith({
      where: { vehicleId_serviceDate_moment: { vehicleId: "v1", serviceDate: DAY, moment: "START" } },
      create: { vehicleId: "v1", serviceDate: DAY, moment: "START", km: 120_420, recordedAt: NOW, recordedById: "u1", confirmed: false },
      update: { km: 120_420, recordedAt: NOW, recordedById: "u1", confirmed: false },
    });
    expect(auditEvents()).toEqual([
      expect.objectContaining({ action: "odometer.record", entity: "Vehicle", entityId: "v1", details: { moment: "START", km: { from: null, to: 120_420 } } }),
    ]);
  });

  it("refuses a decrease for good, and an unusual jump until the crew confirms it", async () => {
    expect(await answer(await post({ moment: "START", km: 120_100 }))).toMatchObject({ status: 422, body: { code: "odometer" } });
    expect(await answer(await post({ moment: "START", km: 125_000 }))).toMatchObject({ status: 422, body: { code: "confirm" } });
    expect(fake.db.$transaction).not.toHaveBeenCalled();
    expect((await answer(await post({ moment: "START", km: 125_000, confirmed: true }))).body).toMatchObject({ ok: true });
    expect(fake.tx.odometerReading.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ confirmed: true }) }));
  });

  it("checks the end against the day's start, and replays a reading already there without writing", async () => {
    fake.db.odometerReading.findMany.mockResolvedValue([{ serviceDate: DAY, km: 120_420, moment: "START" }]);
    expect((await answer(await post({ moment: "END", km: 120_410 }))).body).toMatchObject({ code: "odometer", error: expect.stringContaining("relevé de départ") });
    expect((await answer(await post({ moment: "START", km: 120_420 }))).body).toMatchObject({ ok: true, outcome: "noop" });
    expect(fake.db.$transaction).not.toHaveBeenCalled();
  });

  it("refuses another crew's route, a closed day and another account's queue", async () => {
    fake.db.route.findUnique.mockResolvedValue({ vehicleId: "v1", serviceDate: DAY, driverId: "d9", crewMateId: null });
    expect((await answer(await post({ moment: "START", km: 120_420 }))).body).toMatchObject({ code: "not-yours" });
    fake.db.route.findUnique.mockResolvedValue({ vehicleId: "v1", serviceDate: new Date("2026-11-14T00:00:00.000Z"), driverId: "d1", crewMateId: null });
    expect((await answer(await post({ moment: "END", km: 120_420 }))).body).toMatchObject({ code: "wrong-day" });
    expect(await answer(await post({ moment: "START", km: 120_420, ownerId: "u2" }))).toMatchObject({ status: 401 });
  });
});
