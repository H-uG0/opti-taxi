import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

// « Ajouter un plein ou une recharge » from the phone (FLD-03): the regulator's checks, the crew's own route, traced.
const fake = vi.hoisted(() => {
  const tx = { fuelLog: { create: vi.fn() }, auditEvent: { createMany: vi.fn() } };
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
const NOW = new Date("2026-11-16T15:10:00.000Z");
const DAY = new Date("2026-11-16T00:00:00.000Z");

function post(body: unknown) {
  const request = new NextRequest("http://localhost:3100/api/chauffeur/routes/r1/fuel", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3100", host: "localhost:3100" },
    body: JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ id: "r1" }) });
}

async function answer(response: Response) {
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fake.currentDriver.mockResolvedValue({ ok: true, driver: DRIVER });
  fake.renewDriverSession.mockResolvedValue(null);
  fake.db.route.findUnique.mockResolvedValue({ vehicleId: "v1", serviceDate: DAY, driverId: "d1", crewMateId: "d2", vehicle: { energy: "ELECTRIC" } });
  fake.db.fuelLog.findMany.mockResolvedValue([]);
  fake.db.odometerReading.findMany.mockResolvedValue([{ serviceDate: DAY, km: 30_200, moment: "START" }]);
  fake.tx.fuelLog.create.mockResolvedValue({ id: "f1" });
  fake.tx.auditEvent.createMany.mockResolvedValue({ count: 1 });
});
afterEach(() => vi.useRealTimers());

describe("POST /api/chauffeur/routes/:id/fuel (FLD-03)", () => {
  it("records a charge of the day's vehicle on the route's day, with its author, traced", async () => {
    const { status, body } = await answer(await post({ odometerKm: "30 350", quantity: "42,5", cost: "12,80", fullTank: true, ownerId: "u1" }));
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, message: expect.stringContaining("Recharge enregistrée") });
    expect(fake.tx.fuelLog.create).toHaveBeenCalledWith({
      data: { vehicleId: "v1", date: DAY, odometerKm: 30_350, quantity: 42.5, cost: 12.8, fullTank: true, note: null, recordedById: "u1" },
      select: { id: true },
    });
    const events = fake.tx.auditEvent.createMany.mock.calls.flatMap((call) => call[0].data as Record<string, unknown>[]);
    expect(events).toEqual([expect.objectContaining({ action: "fuel_log.create", entity: "FuelLog", entityId: "f1", details: { vehicleId: "v1", source: "driver" } })]);
  });

  it("answers the form's errors, an odometer below the day's reading included", async () => {
    const empty = await answer(await post({ odometerKm: "", quantity: "0", cost: "12", fullTank: false }));
    expect(empty).toMatchObject({ status: 400, body: { code: "invalid", fieldErrors: { odometerKm: expect.any(String), quantity: expect.any(String) } } });
    const below = await answer(await post({ odometerKm: "30 100", quantity: "10", cost: "5", fullTank: true }));
    expect(below.body).toMatchObject({ code: "invalid", fieldErrors: { odometerKm: expect.stringContaining("Compteur inférieur") } });
    expect(fake.db.$transaction).not.toHaveBeenCalled();
  });

  it("refuses another crew's route", async () => {
    fake.db.route.findUnique.mockResolvedValue({ vehicleId: "v1", serviceDate: DAY, driverId: "d9", crewMateId: null, vehicle: { energy: null } });
    expect((await answer(await post({ odometerKm: "30 350", quantity: "10", cost: "5", fullTank: true }))).body).toMatchObject({ code: "not-yours" });
  });
});
