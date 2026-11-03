import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { BATCH_TRANSACTION_ERROR, withBeforeCommit } from "./before-commit";

/** A client whose transactions log what runs in them and roll the log back on error. */
function fakeClient() {
  const committed: string[] = [];
  const options: unknown[] = [];
  const client = {
    label: "client",
    whoAmI() {
      return this.label;
    },
    async $transaction(work: (tx: { write: (entry: string) => void }) => Promise<unknown>, opts?: unknown) {
      options.push(opts);
      const pending: string[] = [];
      const result = await work({ write: (entry) => pending.push(entry) });
      committed.push(...pending);
      return result;
    },
  };
  return { client, prisma: client as unknown as PrismaClient, committed, options };
}

type FakeTx = { write: (entry: string) => void };

describe("withBeforeCommit", () => {
  it("runs the hook in the same transaction, after the work, and returns the work's result", async () => {
    const { prisma, committed, options } = fakeClient();
    const hooked = withBeforeCommit(prisma, async (tx) => (tx as unknown as FakeTx).write("audit"));
    const result = await hooked.$transaction(
      async (tx) => {
        (tx as unknown as FakeTx).write("plan");
        return { routes: 2 };
      },
      { maxWait: 15_000, timeout: 60_000 },
    );
    expect(result).toEqual({ routes: 2 });
    expect(committed).toEqual(["plan", "audit"]);
    expect(options).toEqual([{ maxWait: 15_000, timeout: 60_000 }]);
  });

  it("saves nothing when the work throws, and nothing when the hook throws", async () => {
    const { prisma, committed } = fakeClient();
    let hookCalls = 0;
    const hooked = withBeforeCommit(prisma, async (tx) => {
      hookCalls += 1;
      (tx as unknown as FakeTx).write("audit");
    });
    await expect(
      hooked.$transaction(async (tx) => {
        (tx as unknown as FakeTx).write("plan");
        throw new Error("blocked");
      }),
    ).rejects.toThrow("blocked");
    expect(hookCalls).toBe(0);

    const failingHook = withBeforeCommit(prisma, async () => {
      throw new Error("audit failed");
    });
    await expect(failingHook.$transaction(async (tx) => (tx as unknown as FakeTx).write("plan"))).rejects.toThrow(
      "audit failed",
    );
    expect(committed).toEqual([]);
  });

  it("refuses a batch transaction, which cannot carry the hook", async () => {
    const { prisma, committed } = fakeClient();
    const hooked = withBeforeCommit(prisma, async (tx) => (tx as unknown as FakeTx).write("audit"));
    await expect(hooked.$transaction([])).rejects.toThrow(BATCH_TRANSACTION_ERROR);
    expect(committed).toEqual([]);
  });

  it("leaves every other member to the client, bound to it", () => {
    const { prisma } = fakeClient();
    const hooked = withBeforeCommit(prisma, async () => {}) as unknown as ReturnType<typeof fakeClient>["client"];
    expect(hooked.label).toBe("client");
    const { whoAmI } = hooked;
    expect(whoAmI()).toBe("client");
  });
});
