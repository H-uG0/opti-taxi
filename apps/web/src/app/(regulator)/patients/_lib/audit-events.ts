/**
 * Audit entries of the referential screens (lib/audit.ts writes them): which
 * patient, prescription, recurrence, facility or trip a regulator changed.
 * Ids and service days only, never a name, an address or a note. A
 * (de)activation is traced only by the write that switches the state.
 *
 * Pure module (type-only imports): used by the server actions, the trip sync
 * and the unit tests.
 */
import type { AuditEntry } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth";

/** Who acts: the session user returned by requireUser(). */
export type AuditActor = Pick<SessionUser, "id" | "role">;

const ACTIVATED_ENTITIES = { patient: "Patient", recurrence: "Recurrence", facility: "Facility" } as const;

type ActivatedKind = keyof typeof ACTIVATED_ENTITIES;

/** "patient.deactivate", "recurrence.reactivate"… for the record `id`. */
export function activationEvent(kind: ActivatedKind, id: string, active: boolean): AuditEntry {
  return { action: `${kind}.${active ? "reactivate" : "deactivate"}` as const, entity: ACTIVATED_ENTITIES[kind], entityId: id };
}

/**
 * A patient form save: the update, plus the (de)activation when this save
 * actually switched « actif » (`switched`: the write guarded on the opposite
 * state applied). A stale form that repeats a state set meanwhile by someone
 * else traces the update only.
 */
export function patientUpdateEvents(patientId: string, active: { value: boolean; switched: boolean }): AuditEntry[] {
  const events: AuditEntry[] = [{ action: "patient.update", entity: "Patient", entityId: patientId }];
  if (active.switched) events.push(activationEvent("patient", patientId, active.value));
  return events;
}

/**
 * Message of a (de)activation that changed nothing because the record was
 * already in the requested state (stale page, double click, two regulators):
 * nothing is written and nothing is traced.
 */
export function alreadyInStateMessage(kind: ActivatedKind, active: boolean): string {
  const subject = { patient: "Ce patient", recurrence: "Cette récurrence", facility: "Cet établissement" }[kind];
  const feminine = kind === "recurrence";
  const state = active ? `déjà acti${feminine ? "ve" : "f"}` : `déjà désactivé${feminine ? "e" : ""}`;
  return `${subject} était ${state} : rien n'a été modifié.`;
}

/** One recurrence.attach_renewal per recurrence moved to the renewed prescription. */
export function renewalEvents(recurrenceIds: readonly string[]): AuditEntry[] {
  return recurrenceIds.map((id) => ({ action: "recurrence.attach_renewal", entity: "Recurrence", entityId: id }));
}

type TripRef = { id: string; serviceDate: string };

function tripEvents(action: "trip.cancel" | "trip.detach", trips: readonly TripRef[]): AuditEntry[] {
  return trips.map((trip) => ({ action, entity: "Trip", entityId: trip.id, serviceDate: trip.serviceDate }));
}

/** One trip.cancel per trip a referential change cancelled, on the trip's service day. */
export function tripCancelEvents(trips: readonly TripRef[]): AuditEntry[] {
  return tripEvents("trip.cancel", trips);
}

/**
 * One trip.detach per trip a referential change took off its route without
 * cancelling it (new address, mode or facility: it waits for the next optimisation).
 */
export function tripDetachEvents(trips: readonly TripRef[]): AuditEntry[] {
  return tripEvents("trip.detach", trips);
}
