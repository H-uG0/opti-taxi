/**
 * Audit trail (AuditEvent): who read or changed which record, when and from
 * where. Never a patient's name, address or note: ids, plus non-medical
 * details where a change needs them (old and new value of a setting). The
 * table is append-only in the database (migration audit_trail_append_only).
 *
 * Each event also keeps, at write time: the author's name (actorLabel, so it
 * stays readable whatever happens to the account), the client address when a
 * proxy is trusted (TRUSTED_PROXY_HOPS) and a hash of the User-Agent
 * (lib/auth/request-origin.ts).
 *
 * Action names are `<entity>.<verb>` in snake_case. In use:
 * - reads (day shown in serviceDate): patient_list.view (/patients, and the
 *   patient choice of /courses/nouvelle), patient.view (record, edit form,
 *   new prescription and new recurrence forms), prescription.view and
 *   recurrence.view (edit forms, on the Patient: a prescription can be
 *   deleted), facility.view (patients treated there), trip_list.view
 *   (/courses), plan.view (/planning), roadmap.view (driver, today or
 *   tomorrow), shared_arrivals.view (Facility when a facility's sheet is
 *   opened), driver.view (/chauffeurs/[id]: absences), day_crew.view
 *   (/equipages: everyone's absences of the day);
 * - referentials: patient.*, prescription.*, recurrence.* (create, update,
 *   delete, deactivate, reactivate, attach_renewal), facility.*;
 * - trips: trip.generate (a trip created from a recurrence, one event per
 *   trip; lib/trips/completion.ts — older events: one per service day,
 *   entityId null, details.created), trip.revive (a trip the
 *   referential sync had cancelled, brought back once the cause is gone),
 *   trip.generate_week (before the rolling horizon), trip.create,
 *   trip.cancel (the reason stays on the trip), trip.detach (taken off its
 *   route by a referential change, not cancelled), trip.restore,
 *   trip.reschedule, trip.sharing_accept, trip.sharing_refuse, trip.move,
 *   trip.lock, trip.unlock;
 * - planning: plan.optimize (details.confirmed when the regulator replaced the
 *   routes in place with a plan that waited for confirmation), plan.restore
 *   (« Revenir au planning précédent »), plan.discard (a waiting plan not
 *   kept), plan.validate, plan.reopen;
 * - field, on the Trip (stops are deleted by re-optimizations): stop.pickup,
 *   stop.dropoff, stop.no_show, stop.undo_pickup, stop.undo_dropoff;
 * - staff and crews: day_crew.save, day_crew.reset (serviceDate),
 *   staff_absence.create/delete, crew_incompatibility.create/delete;
 * - fleet: vehicle.create/update/deactivate/reactivate,
 *   vehicle_unavailability.create/delete, maintenance_deadline.create/
 *   complete/delete, fuel_log.create/delete, depot.create/update/deactivate/
 *   reactivate;
 * - settings: settings.update, traffic.update, traffic.apply_observed (details:
 *   changed fields, old and new value), tariff.create/update/delete (details:
 *   changed fields; the deleted grid);
 * - accounts: driver.*, account.* (create, update, password_reset,
 *   password_change, password_change_failed: a wrong current password,
 *   deactivate, reactivate), session.login, session.logout,
 *   session.login_failed and session.throttled (no author; the account as
 *   entityId, or for an e-mail that is no account its details.emailTag, never
 *   the e-mail: see signInSubject).
 * Changes are written in the transaction of the change (audit); reads,
 * sign-ins and wrong current passwords with auditRead, sign-in failures with
 * auditAnonymous (best effort, never blocks the page).
 */
import "server-only";
import { headers } from "next/headers";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { trustedProxyHops } from "@/lib/auth/rate-limit";
import { requestOrigin, UNKNOWN_ORIGIN, type RequestOrigin } from "@/lib/auth/request-origin";
import { logError } from "@/lib/log";
import { auditEventData, type AuditActor, type AuditEntry } from "./audit-events";

export { changedFields, type AuditActor, type AuditDetails, type AuditEntity, type AuditEntry } from "./audit-events";

type AuditClient = Pick<Prisma.TransactionClient, "auditEvent">;

/** Origin of the request being served; unknown outside a request (scripts, tests). */
async function currentOrigin(): Promise<RequestOrigin> {
  try {
    const list = await headers();
    return requestOrigin(
      { forwardedFor: list.get("x-forwarded-for"), userAgent: list.get("user-agent") },
      trustedProxyHops(process.env.TRUSTED_PROXY_HOPS),
    );
  } catch {
    return UNKNOWN_ORIGIN;
  }
}

/**
 * Records changes. Pass the transaction client of the change so the events
 * commit or roll back with it: a change is never saved without its trace.
 */
export async function audit(client: AuditClient, user: AuditActor, entries: AuditEntry | AuditEntry[]): Promise<void> {
  const list = Array.isArray(entries) ? entries : [entries];
  if (list.length === 0) return;
  const origin = await currentOrigin();
  await client.auditEvent.createMany({ data: list.map((entry) => auditEventData(user, entry, origin)) });
}

/**
 * Records a read (a patient record or a roadmap shown), or another event that
 * goes with no change (a sign-in, a wrong current password). A failure is
 * logged and never breaks the page.
 */
export async function auditRead(user: AuditActor, entry: AuditEntry): Promise<void> {
  try {
    await audit(db, user, entry);
  } catch (error) {
    logError("[audit] recording a read failed", error, { action: entry.action, entityId: entry.entityId });
  }
}

/**
 * Records an event without an authenticated author: a failed or throttled
 * sign-in. Best effort, like a read: the answer to the visitor never depends
 * on it.
 */
export async function auditAnonymous(entry: AuditEntry): Promise<void> {
  try {
    const origin = await currentOrigin();
    await db.auditEvent.createMany({ data: [auditEventData(null, entry, origin)] });
  } catch (error) {
    logError("[audit] recording an anonymous event failed", error, { action: entry.action });
  }
}
