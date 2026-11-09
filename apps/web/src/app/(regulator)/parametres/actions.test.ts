import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveSettings } from "./actions";
import { IDLE_STATE } from "@/lib/forms";

// saveSettings against a fake Prisma client: checks the audit event of a
// settings change (old and new value), not the database.
const fake = vi.hoisted(() => {
  const models = {
    appSettings: { upsert: vi.fn(), update: vi.fn() },
    auditEvent: { createMany: vi.fn() },
  };
  return { ...models, $transaction: vi.fn(async (fn: (tx: typeof models) => unknown) => fn(models)) };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "u1", name: "Régulation", role: "REGULATOR", driverId: null })),
}));
vi.mock("@/lib/db", () => ({ db: fake }));

const STORED = {
  id: 1,
  waitBeforeAppointmentMin: 30,
  waitAfterSessionMin: 15,
  maxTotalWaitMin: 45,
  maxDetourKmPerExtraPatient: 10,
  maxDetourKmTotal: 30,
  pickupServiceMin: 5,
  dropoffServiceMin: 5,
  unassignedPenalty: 10000,
  solverTimeLimitSec: 10,
  regulatorPhone: "04 65 71 00 00",
};

function form(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  const values = { ...STORED, regulatorPhone: "04 65 71 00 00", ...overrides };
  for (const [key, value] of Object.entries(values)) if (key !== "id") fd.set(key, String(value));
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.appSettings.upsert.mockResolvedValue(STORED);
  fake.auditEvent.createMany.mockResolvedValue({ count: 1 });
});

describe("saveSettings", () => {
  it("traces a new regulation number with its old and new value, by the session user", async () => {
    const result = await saveSettings(IDLE_STATE, form({ regulatorPhone: "0465710099", solverTimeLimitSec: "20" }));
    expect(result.status).toBe("success");
    expect(fake.auditEvent.createMany).toHaveBeenCalledTimes(1);
    const [row] = fake.auditEvent.createMany.mock.calls[0]![0].data;
    expect(row).toMatchObject({
      userId: "u1",
      actorLabel: "Régulation",
      action: "settings.update",
      entity: "AppSettings",
      details: {
        regulatorPhone: { from: "04 65 71 00 00", to: "04 65 71 00 99" },
        solverTimeLimitSec: { from: 10, to: 20 },
      },
    });
    expect(Object.keys(row.details)).toHaveLength(2);
  });

  it("writes no event when nothing changed", async () => {
    await saveSettings(IDLE_STATE, form());
    expect(fake.appSettings.update).toHaveBeenCalledTimes(1);
    expect(fake.auditEvent.createMany).not.toHaveBeenCalled();
  });
});
