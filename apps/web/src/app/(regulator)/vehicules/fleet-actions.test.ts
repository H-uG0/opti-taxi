import { beforeEach, describe, expect, it, vi } from "vitest";

// The fill-ups typed by the regulator and the correction of a crew's odometer reading (FLD-03), against a fake Prisma
// client: checked against every mileage known of the vehicle, ordered by moment on the same day, traced.
const fake = vi.hoisted(() => {
  const models = {
    vehicle: { findUnique: vi.fn() },
    fuelLog: { findMany: vi.fn(), create: vi.fn() },
    odometerReading: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    auditEvent: { createMany: vi.fn() },
  };
  return { db: { ...models, $transaction: vi.fn(async (fn: (tx: typeof models) => unknown) => fn(models)) } };
});

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "reg1", name: "Régulation", role: "REGULATOR", driverId: null })) }));
vi.mock("@/lib/db", () => ({ db: fake.db }));

const { addFuelLog, correctOdometerReading, deleteOdometerReading } = await import("./fleet-actions");

const DAY = new Date("2026-11-14T00:00:00.000Z");
const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};
const IDLE = { status: "idle", message: null, fieldErrors: {}, values: null, submissionId: 0 } as never;
const auditEvents = () => fake.db.auditEvent.createMany.mock.calls.flatMap((call) => call[0].data as Record<string, unknown>[]);
const plain = (text: unknown) => String(text).replace(/\s/g, " ");

beforeEach(() => {
  vi.clearAllMocks();
  fake.db.vehicle.findUnique.mockResolvedValue({ id: "v1" });
  fake.db.fuelLog.findMany.mockResolvedValue([]);
  fake.db.fuelLog.create.mockResolvedValue({ id: "f1" });
  // The crew read 50 000 km at the start of the 14th and 50 250 km at its end.
  fake.db.odometerReading.findMany.mockResolvedValue([
    { serviceDate: DAY, km: 50_000, moment: "START" },
    { serviceDate: DAY, km: 50_250, moment: "END" },
  ]);
  fake.db.odometerReading.findFirst.mockResolvedValue({ id: "o2", vehicleId: "v1", serviceDate: DAY, moment: "END", km: 50_250 });
  fake.db.odometerReading.updateMany.mockResolvedValue({ count: 1 });
  fake.db.odometerReading.deleteMany.mockResolvedValue({ count: 1 });
  fake.db.auditEvent.createMany.mockResolvedValue({ count: 1 });
});

describe("addFuelLog (FLD-03)", () => {
  it("takes the day's fill-up typed after the crew's end reading, between the start and the end", async () => {
    const result = await addFuelLog("v1", IDLE, form({ date: "2026-11-14", odometerKm: "50 120", quantity: "40", cost: "70", fullTank: "on" }));
    expect(result).toMatchObject({ status: "success", message: "Plein enregistré." });
    expect(fake.db.fuelLog.create).toHaveBeenCalled();
  });

  it("refuses a fill-up above the day's end, or below its start", async () => {
    const above = await addFuelLog("v1", IDLE, form({ date: "2026-11-14", odometerKm: "50 300", quantity: "40", cost: "70" }));
    expect(plain(above.fieldErrors.odometerKm)).toBe("Compteur supérieur au relevé de retour du 14/11/2026 (50 250 km).");
    const below = await addFuelLog("v1", IDLE, form({ date: "2026-11-14", odometerKm: "49 990", quantity: "40", cost: "70" }));
    expect(plain(below.fieldErrors.odometerKm)).toBe("Compteur inférieur au relevé de départ du 14/11/2026 (50 000 km).");
    expect(fake.db.fuelLog.create).not.toHaveBeenCalled();
  });
});

describe("correctOdometerReading and deleteOdometerReading (FLD-03)", () => {
  it("corrects a crew's reading once its day is closed, guarded and traced with the km from and to", async () => {
    const result = await correctOdometerReading("v1", "o2", IDLE, form({ km: "50 205" }));
    expect(result).toMatchObject({ status: "success" });
    expect(plain(result.message)).toBe("Relevé de retour du 14/11/2026 corrigé : 50 205 km.");
    expect(fake.db.odometerReading.updateMany).toHaveBeenCalledWith({
      where: { id: "o2", vehicleId: "v1", km: 50_250 },
      data: { km: 50_205, confirmed: false },
    });
    expect(auditEvents()).toEqual([
      expect.objectContaining({ action: "odometer.update", entity: "Vehicle", entityId: "v1", details: { moment: "END", km: { from: 50_250, to: 50_205 } } }),
    ]);
  });

  it("never takes a decrease, even from the regulator: an end below the day's start is refused", async () => {
    const result = await correctOdometerReading("v1", "o2", IDLE, form({ km: "49 000" }));
    expect(result.status).toBe("error");
    expect(result.fieldErrors.km).toContain("Inférieur au relevé de départ du jour");
    expect(fake.db.odometerReading.updateMany).not.toHaveBeenCalled();
  });

  it("deletes a reading, traced", async () => {
    expect(await deleteOdometerReading("v1", "o2")).toMatchObject({ status: "success", message: "Relevé supprimé." });
    expect(fake.db.odometerReading.deleteMany).toHaveBeenCalledWith({ where: { id: "o2", vehicleId: "v1" } });
    expect(auditEvents()).toEqual([expect.objectContaining({ action: "odometer.delete", details: { moment: "END", km: { from: 50_250, to: null } } })]);
    fake.db.odometerReading.findFirst.mockResolvedValue(null);
    expect(await deleteOdometerReading("v1", "o2")).toMatchObject({ message: "Ce relevé était déjà supprimé." });
  });
});
