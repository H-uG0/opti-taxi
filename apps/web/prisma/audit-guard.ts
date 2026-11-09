/**
 * The audit trail is append-only in the database: the trigger
 * "AuditEvent_append_only" (migration audit_trail_append_only) refuses any
 * UPDATE or DELETE of "AuditEvent". The development scripts that erase it,
 * the seed (wipes everything) and the history simulation (replaces the past
 * days it created), lift it explicitly, inside the transaction of their
 * deletion: ALTER TABLE is transactional in PostgreSQL, so the trigger is back
 * when the transaction ends, committed or rolled back, and no other session
 * ever sees it disabled. It takes the table owner: the production runtime
 * role cannot (README, « Journal d'audit »). Both scripts run the
 * development-database guard (safety.ts) first.
 */
import type { PrismaClient } from "@prisma/client";

export const AUDIT_GUARD_TRIGGER = "AuditEvent_append_only";

/** First statement of a batch transaction that deletes audit events. */
export function liftAuditGuard(prisma: PrismaClient) {
  return prisma.$executeRawUnsafe(`ALTER TABLE "AuditEvent" DISABLE TRIGGER "${AUDIT_GUARD_TRIGGER}"`);
}

/** Last statement of that transaction (the rollback of a failed one restores it too). */
export function restoreAuditGuard(prisma: PrismaClient) {
  return prisma.$executeRawUnsafe(`ALTER TABLE "AuditEvent" ENABLE TRIGGER "${AUDIT_GUARD_TRIGGER}"`);
}
