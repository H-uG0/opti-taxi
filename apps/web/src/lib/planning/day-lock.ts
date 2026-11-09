/**
 * Serializes the planning writes of one service date across server
 * instances: a PostgreSQL transaction-level advisory lock, released at the
 * end of the transaction. Taken around « is a computation of this date
 * already running? » and the creation of its run, so two clicks (two
 * regulators, two tabs) never start two computations of the same date; and
 * around a validation, so it cannot slip between that check and a new run.
 * Pure key plus a helper taking the transaction client: no server-only import.
 */
import type { Prisma } from "@prisma/client";
import { fromIsoDate } from "@/lib/time";

/** First key of every planning lock: "OPTX" (other advisory locks of the database use other namespaces). */
export const PLANNING_LOCK_NAMESPACE = 0x4f505458;

/** The two int4 keys of the lock of isoDate: namespace, days since 1970-01-01. */
export function planningLockKey(isoDate: string): [number, number] {
  return [PLANNING_LOCK_NAMESPACE, Math.round(fromIsoDate(isoDate).getTime() / 86_400_000)];
}

/** Waits for, then holds until the transaction ends, the planning lock of isoDate. */
export async function lockPlanningDay(tx: Pick<Prisma.TransactionClient, "$executeRaw">, isoDate: string): Promise<void> {
  const [namespace, day] = planningLockKey(isoDate);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${namespace}::int, ${day}::int)`;
}
