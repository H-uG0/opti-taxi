/**
 * Adds a caller's writes (its audit event) to a transaction opened by a
 * function it does not own, such as savePlan: they commit or roll back
 * together. Pure (no server-only import) so vitest can cover it.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

type InteractiveWork = (tx: Prisma.TransactionClient) => Promise<unknown>;
type TransactionOptions = { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel };

export const BATCH_TRANSACTION_ERROR = "withBeforeCommit: a batch transaction cannot carry the added writes";

/**
 * `prisma`, except that each interactive transaction opened through it runs
 * `beforeCommit(tx)` once its own work has returned, in that transaction: if
 * either throws, neither is saved. A batch `$transaction([...])` is refused,
 * since no write can be added to it. Every other member is the client's own.
 */
export function withBeforeCommit(
  prisma: PrismaClient,
  beforeCommit: (tx: Prisma.TransactionClient) => Promise<void>,
): PrismaClient {
  const $transaction = (work: unknown, options?: TransactionOptions): Promise<unknown> => {
    if (typeof work !== "function") return Promise.reject(new Error(BATCH_TRANSACTION_ERROR));
    return prisma.$transaction(async (tx) => {
      const result = await (work as InteractiveWork)(tx);
      await beforeCommit(tx);
      return result;
    }, options);
  };
  return new Proxy(prisma, {
    get(target, property) {
      if (property === "$transaction") return $transaction;
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
