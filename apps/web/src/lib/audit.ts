import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { SessionUser } from "@/lib/auth";
import { logError } from "@/lib/log";
import { fromIsoDate } from "@/lib/time";

/**
 * Audit trail of health data (AuditEvent): who read or changed which record,
 * and when. Never names, addresses or notes: ids only.
 *
 * Action names are `<entity>.<verb>` in snake_case. In use:
 * - reads (day shown in serviceDate): patient_list.view, patient.view (record
 *   and edit form), prescription.view and recurrence.view (edit forms, on the
 *   Patient: a prescription can be deleted), facility.view (patients treated
 *   there), trip_list.view (/courses), plan.view (/planning),
 *   roadmap.view (driver, today or tomorrow), shared_arrivals.view (Facility
 *   when a facility's sheet is opened);
 * - referentials: patient.*, prescription.*, recurrence.* (create, update,
 *   delete, deactivate, reactivate, attach_renewal), facility.*;
 * - trips: trip.generate_week (only when trips were created), trip.create,
 *   trip.cancel, trip.detach (taken off its route by a referential change, not
 *   cancelled), trip.restore, trip.reschedule, trip.sharing_accept,
 *   trip.sharing_refuse, trip.move, trip.lock, trip.unlock;
 * - planning: plan.optimize, plan.validate, plan.reopen;
 * - field, on the Trip (stops are deleted by re-optimizations): stop.pickup,
 *   stop.dropoff, stop.no_show, stop.undo_pickup, stop.undo_dropoff;
 * - accounts: driver.*, account.* (create, update, password_reset,
 *   deactivate, reactivate), session.login, session.logout.
 * Changes are written in the transaction of the change (audit); reads and
 * sign-ins with auditRead (best effort, never blocks the page).
 */
export type AuditEntity =
  | "Patient"
  | "Prescription"
  | "Recurrence"
  | "Trip"
  | "Route"
  | "OptimizationRun"
  | "User"
  | "Driver"
  | "Facility";

export type AuditEntry = {
  action: `${string}.${string}`;
  entity: AuditEntity;
  entityId?: string | null;
  /** Planned day the action is about, "YYYY-MM-DD". */
  serviceDate?: string | null;
};

type AuditClient = Pick<Prisma.TransactionClient, "auditEvent">;
type Actor = Pick<SessionUser, "id" | "role">;

function eventData(user: Actor, entry: AuditEntry): Prisma.AuditEventUncheckedCreateInput {
  return {
    userId: user.id,
    role: user.role,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    serviceDate: entry.serviceDate ? fromIsoDate(entry.serviceDate) : null,
  };
}

/**
 * Records changes. Pass the transaction client of the change so the events
 * commit or roll back with it: a change is never saved without its trace.
 */
export async function audit(client: AuditClient, user: Actor, entries: AuditEntry | AuditEntry[]): Promise<void> {
  const list = Array.isArray(entries) ? entries : [entries];
  if (list.length === 0) return;
  await client.auditEvent.createMany({ data: list.map((entry) => eventData(user, entry)) });
}

/**
 * Records a read (a patient record or a roadmap shown). A failure is logged and
 * never breaks the page.
 */
export async function auditRead(user: Actor, entry: AuditEntry): Promise<void> {
  try {
    await audit(db, user, entry);
  } catch (error) {
    logError("[audit] recording a read failed", error, { action: entry.action, entityId: entry.entityId });
  }
}
