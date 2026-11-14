import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireUser } from "@/lib/auth";
import { saveKpiTargets, saveSettings } from "./actions";
import { IDLE_STATE } from "@/lib/forms";

// saveSettings and saveKpiTargets against a fake Prisma client: checks the
// audit event of a change (old and new value), not the database. The
// transaction's client is its own object (`fake.tx`): a write through it is a
// write inside the transaction.
const fake = vi.hoisted(() => {
  const models = {
    appSettings: { upsert: vi.fn(), update: vi.fn() },
    auditEvent: { createMany: vi.fn() },
  };
  const tx = {
    ...models,
    kpiTarget: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    $executeRaw: vi.fn(),
  };
  return {
    ...models,
    tx,
    depot: { findUnique: vi.fn() },
    kpiTarget: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
  };
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
  maxRideExtraMin: 30,
  pickupServiceMin: 5,
  dropoffServiceMin: 5,
  ambulancePickupServiceMin: null,
  ambulanceDropoffServiceMin: null,
  wheelchairExtraServiceMin: 0,
  lyingExtraServiceMin: 0,
  unassignedPenalty: 10000,
  solverTimeLimitSec: 10,
  replanMaxServedLoss: 0,
  replanMaxMarginLoss: 0.1,
  lateCancellationHours: 2,
  tripHorizonDays: 14,
  crewMaxReplacementKm: 60,
  crewMinPairOverlapMin: 240,
  crewReservePerDepot: 0,
  regulatorPhone: "04 65 71 00 00",
};

function form(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  // The margin loss tolerance is typed in % in the form, stored as a fraction.
  const values = { ...STORED, replanMaxMarginLoss: STORED.replanMaxMarginLoss * 100, regulatorPhone: "04 65 71 00 00", ...overrides };
  // A blank input is a null setting (ambulance stop durations: as taxi and VSL).
  for (const [key, value] of Object.entries(values)) if (key !== "id") fd.set(key, value === null ? "" : String(value));
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

describe("saveKpiTargets", () => {
  /** The objectives form: every field blank but those given. */
  function targetsForm(values: Record<string, string> = {}): FormData {
    const fd = new FormData();
    for (const [key, value] of Object.entries(values)) fd.set(key, value);
    return fd;
  }
  const COMPANY_ROW = { indicator: "sharedRate", depotId: null, reference: null, objective: 0.3 };

  beforeEach(() => {
    fake.depot.findUnique.mockResolvedValue({ id: "gap" });
    fake.tx.kpiTarget.findMany.mockResolvedValue([COMPANY_ROW]);
    fake.tx.$executeRaw.mockResolvedValue(1);
  });

  it("is a regulator's action", async () => {
    await saveKpiTargets(null, IDLE_STATE, targetsForm({ "sharedRate-objective": "30" }));
    expect(requireUser).toHaveBeenCalledWith("REGULATOR");
  });

  it("refuses a depot that does not exist and writes nothing", async () => {
    fake.depot.findUnique.mockResolvedValue(null);
    const result = await saveKpiTargets("nope", IDLE_STATE, targetsForm({ "sharedRate-objective": "35" }));
    expect(result).toMatchObject({ status: "error", message: expect.stringContaining("Dépôt introuvable") });
    expect(fake.$transaction).not.toHaveBeenCalled();
    expect(fake.auditEvent.createMany).not.toHaveBeenCalled();
  });

  it("writes nothing, not even an event, when nothing changed", async () => {
    const result = await saveKpiTargets(null, IDLE_STATE, targetsForm({ "sharedRate-objective": "30" }));
    expect(result).toMatchObject({ status: "success", message: "Objectifs inchangés." });
    expect(fake.tx.kpiTarget.deleteMany).not.toHaveBeenCalled();
    expect(fake.tx.kpiTarget.createMany).not.toHaveBeenCalled();
    expect(fake.auditEvent.createMany).not.toHaveBeenCalled();
  });

  it("replaces the scope's rows and traces the change as typed, all in one locked transaction", async () => {
    const result = await saveKpiTargets(null, IDLE_STATE, targetsForm({ "sharedRate-objective": "35", "marginPerTrip-objective": "12" }));
    expect(result.status).toBe("success");
    // The lock first, then the rows it protects are read: a concurrent save waits, and the trail's « from » is the value replaced.
    expect(fake.tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(fake.tx.kpiTarget.findMany.mock.invocationCallOrder[0]!);
    expect(fake.kpiTarget.findMany).not.toHaveBeenCalled();
    expect(fake.tx.kpiTarget.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { depotId: null } }));
    expect(fake.tx.kpiTarget.deleteMany).toHaveBeenCalledWith({ where: { depotId: null } });
    expect(fake.tx.kpiTarget.createMany).toHaveBeenCalledWith({
      data: [
        { indicator: "sharedRate", depotId: null, reference: null, objective: 0.35, updatedById: "u1" },
        { indicator: "marginPerTrip", depotId: null, reference: null, objective: 12, updatedById: "u1" },
      ],
    });
    expect(fake.auditEvent.createMany).toHaveBeenCalledTimes(1);
    const [row] = fake.auditEvent.createMany.mock.calls[0]![0].data;
    expect(row).toMatchObject({
      action: "kpi_target.update",
      entity: "KpiTarget",
      entityId: null,
      details: { "sharedRate.objective": { from: "30", to: "35" }, "marginPerTrip.objective": { from: "", to: "12" } },
    });
  });

  it("asks to reload when a concurrent save got there first", async () => {
    const conflict = Object.assign(new Error("Unique constraint failed"), { code: "P2002", meta: { target: ["indicator", "depotId"] } });
    fake.tx.kpiTarget.createMany.mockRejectedValueOnce(conflict);
    const result = await saveKpiTargets("gap", IDLE_STATE, targetsForm({ "sharedRate-objective": "40" }));
    expect(result).toMatchObject({ status: "error", message: expect.stringContaining("rechargez la page") });
  });
});
