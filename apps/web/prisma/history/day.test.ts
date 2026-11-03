import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanResponse } from "@/lib/optimizer/contract";
import { Rng } from "../seed/random";
import { DayAuditTrail } from "./audit";
import { answerProposals, optimizeOnce, type DayContext } from "./day";
import type { OptimizerClient } from "./optimizer";
import { isHabitualRefuser } from "./sharing";

/** What savePlan does to the run in its transaction, and whether it then fails (a blocked day, a database error). */
const savePlanState = vi.hoisted(() => ({ fails: false }));

vi.mock("@/lib/optimizer/build-request", () => ({
  loadOptimizeInput: vi.fn(async () => ({})),
  buildOptimizeRequest: vi.fn(() => ({
    request: { trips: [{ id: "t1", lockedVehicleId: null }], vehicles: [{ id: "v1" }], settings: { timeLimitSec: 5 } },
    excludedTrips: [],
  })),
}));

// savePlan's shape: one interactive transaction that marks the run SUCCESS with the real clock.
vi.mock("@/lib/optimizer/persist", () => ({
  savePlan: vi.fn(async (prisma: PrismaClient, args: { runId: string }) =>
    prisma.$transaction(async (tx) => {
      await tx.optimizationRun.update({ where: { id: args.runId }, data: { status: "SUCCESS", finishedAt: new Date() } });
      if (savePlanState.fails) throw new Error("database error");
      return { routes: 1, served: 1, unassigned: 0 };
    }),
  ),
}));

type Write = { model: string; op: string; args: Record<string, unknown>; tx: number | null };

/**
 * In-memory stand-in for the Prisma client: records the writes that commit.
 * The writes of an interactive transaction are kept only when its work
 * resolves (rollback otherwise); a batch transaction is not expected here.
 */
function fakePrisma(options: { proposed?: object[]; savedTrip?: (id: string) => boolean } = {}) {
  const committed: Write[] = [];
  let transactions = 0;
  const models = (sink: Write[], tx: number | null) => {
    const record = (model: string, op: string, result: (args: Record<string, unknown>) => unknown) => {
      return async (args: Record<string, unknown>) => {
        sink.push({ model, op, args, tx });
        return result(args);
      };
    };
    return {
      trip: {
        findMany: async () => options.proposed ?? [],
        updateMany: record("trip", "updateMany", (args) => {
          const id = String((args.where as { id: string }).id);
          return { count: (options.savedTrip?.(id) ?? true) ? 1 : 0 };
        }),
      },
      optimizationRun: {
        create: record("optimizationRun", "create", () => ({})),
        update: record("optimizationRun", "update", () => ({})),
      },
      auditEvent: {
        createMany: record("auditEvent", "createMany", (args) => ({ count: (args.data as unknown[]).length })),
      },
    };
  };
  const client = {
    ...models(committed, null),
    $transaction: async (work: unknown) => {
      if (typeof work !== "function") throw new Error("unexpected batch transaction");
      const id = ++transactions;
      const pending: Write[] = [];
      const result: unknown = await (work as (tx: unknown) => Promise<unknown>)(models(pending, id));
      committed.push(...pending);
      return result;
    },
  };
  return { prisma: client as unknown as PrismaClient, committed };
}

function context(prisma: PrismaClient, plan: Partial<PlanResponse> = {}): DayContext {
  const optimizer = {
    baseUrl: "http://optimizer.test",
    optimize: vi.fn(async () => ({ status: "SUCCESS", meta: { wallTimeMs: 12_000, matrixSource: "haversine" }, ...plan })),
  } as unknown as OptimizerClient;
  return { prisma, seed: 1, recurrences: [], optimizer, budgetSec: null, regulatorId: "regulator-1", driverAccounts: new Map() };
}

const eventsOf = (writes: Write[]) =>
  writes.filter((w) => w.model === "auditEvent").flatMap((w) => w.args.data as Array<Record<string, unknown>>);

describe("optimizeOnce", () => {
  const startedAt = new Date("2026-10-11T14:54:20.000Z");

  beforeEach(() => {
    savePlanState.fails = false;
  });

  it("writes plan.optimize in savePlan's transaction, at the save, with the run's simulated instants", async () => {
    const { prisma, committed } = fakePrisma();
    const outcome = await optimizeOnce(context(prisma), new DayAuditTrail("2026-10-12"), "2026-10-12", 1, startedAt, new Rng(7));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.finishedAt.getTime()).toBeGreaterThan(startedAt.getTime() + 12_000);

    // The RUNNING run alone, outside any transaction: no event before the plan exists.
    const created = committed.find((w) => w.op === "create");
    expect(created?.tx).toBeNull();
    const events = committed.filter((w) => w.model === "auditEvent");
    expect(events).toHaveLength(1);
    const saveTx = committed.find((w) => w.op === "update" && (w.args.data as { status?: string }).status === "SUCCESS")?.tx;
    expect(saveTx).not.toBeNull();
    expect(events[0]?.tx).toBe(saveTx);
    expect(eventsOf(committed)).toEqual([
      expect.objectContaining({
        action: "plan.optimize",
        entity: "OptimizationRun",
        entityId: "hist-20261012-run1",
        userId: "regulator-1",
        role: "REGULATOR",
        at: outcome.finishedAt,
      }),
    ]);
    // The real clock savePlan stamps is replaced, in the same transaction, by the instants of the day before.
    const instants = committed.find((w) => w.op === "update" && "startedAt" in (w.args.data as object));
    expect(instants).toMatchObject({ tx: saveTx, args: { data: { startedAt, finishedAt: outcome.finishedAt } } });
  });

  it("leaves no event when the plan cannot be saved", async () => {
    savePlanState.fails = true;
    const { prisma, committed } = fakePrisma();
    await expect(
      optimizeOnce(context(prisma), new DayAuditTrail("2026-10-12"), "2026-10-12", 1, startedAt, new Rng(7)),
    ).rejects.toThrow("database error");
    expect(eventsOf(committed)).toEqual([]);
    expect(committed.map((w) => w.op)).toEqual(["create"]);
  });

  it("leaves no event when the optimizer finds no solution", async () => {
    const { prisma, committed } = fakePrisma();
    const ctx = context(prisma, { status: "NO_SOLUTION" });
    const outcome = await optimizeOnce(ctx, new DayAuditTrail("2026-10-12"), "2026-10-12", 1, startedAt, new Rng(7));
    expect(outcome.ok).toBe(false);
    expect(eventsOf(committed)).toEqual([]);
    expect(committed.at(-1)?.args.data).toMatchObject({ status: "FAILED" });
  });
});

describe("answerProposals", () => {
  const proposedAt = new Date("2026-10-11T14:54:32.000Z");
  const firstPatient = (refuser: boolean) => {
    for (let i = 0; i < 10_000; i++) if (isHabitualRefuser(`p${i}`) === refuser) return `p${i}`;
    throw new Error("no such patient");
  };
  const trip = (id: string, patientId: string) => ({
    id,
    patientId,
    direction: "OUTBOUND" as const,
    sharingStatus: "PROPOSED" as const,
    sharingProposedAt: proposedAt,
    sharingRespondedAt: null,
    sharingNote: null,
  });

  it("traces only the answers actually saved, in their transaction, and counts only those refusals", async () => {
    const refuser = firstPatient(true);
    const accepter = firstPatient(false);
    const proposed = [trip("hist-a", refuser), trip("hist-b", refuser), trip("hist-c", accepter)];
    // hist-b was answered meanwhile in « Courses »: the guarded update changes nothing.
    const { prisma, committed } = fakePrisma({ proposed, savedTrip: (id) => id !== "hist-b" });
    const result = await answerProposals(context(prisma), new DayAuditTrail("2026-10-12"), new Date(), proposedAt, new Rng(3));

    expect(result.refused).toBe(1);
    expect(eventsOf(committed).map((e) => [e.entityId, e.action, e.userId])).toEqual([
      ["hist-a", "trip.sharing_refuse", "regulator-1"],
      ["hist-c", "trip.sharing_accept", "regulator-1"],
    ]);
    const updates = committed.filter((w) => w.op === "updateMany");
    expect(updates).toHaveLength(3);
    expect(new Set(committed.map((w) => w.tx))).toEqual(new Set([1]));
    // Each event carries the instant written on its trip.
    for (const event of eventsOf(committed)) {
      const update = updates.find((w) => (w.args.where as { id: string }).id === event.entityId);
      expect((update?.args.data as { sharingRespondedAt: Date }).sharingRespondedAt).toEqual(event.at);
      expect((update?.args.data as { sharingRespondedById: string }).sharingRespondedById).toBe("regulator-1");
    }
  });

  it("writes nothing when no trip is proposed", async () => {
    const { prisma, committed } = fakePrisma();
    const result = await answerProposals(context(prisma), new DayAuditTrail("2026-10-12"), new Date(), proposedAt, new Rng(3));
    expect(result).toEqual({ refused: 0, lastAt: null });
    expect(committed).toEqual([]);
  });
});
