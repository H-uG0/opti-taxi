/**
 * Pure part of the audit trail (lib/audit.ts): the event types and the row
 * written for an event. No Next.js or database import, so it is unit-tested
 * and shared with the scripts.
 */
import type { Prisma, UserRole } from "@prisma/client";
import type { RequestOrigin } from "@/lib/auth/request-origin";
import { fromIsoDate } from "@/lib/time";

export type AuditEntity =
  | "Patient"
  | "Prescription"
  | "Recurrence"
  | "Trip"
  | "Route"
  | "OptimizationRun"
  | "User"
  | "Driver"
  | "Facility"
  | "DayCrew"
  | "StaffAbsence"
  | "CrewIncompatibility"
  | "Vehicle"
  | "VehicleUnavailability"
  | "MaintenanceDeadline"
  | "FuelLog"
  | "Depot"
  | "TariffGrid"
  | "AppSettings";

type DetailValue = string | number | boolean | null;

/**
 * Non-medical context of an event: a value, or a change `{ from, to }`. Never
 * a patient's name, address or note, nor any free text typed by a user.
 */
export type AuditDetails = Record<string, DetailValue | { from: DetailValue; to: DetailValue }>;

export type AuditEntry = {
  action: `${string}.${string}`;
  entity: AuditEntity;
  entityId?: string | null;
  /** Planned day the action is about, "YYYY-MM-DD". */
  serviceDate?: string | null;
  details?: AuditDetails;
};

/** The session user (requireUser); `name` is frozen into the event as its author's label. */
export type AuditActor = { id: string; role: UserRole; name?: string };

/**
 * The row of one event. The optional columns are only written when known (the
 * database leaves them null, and fills actorLabel from the account itself
 * when the actor carries no name).
 */
export function auditEventData(
  user: AuditActor | null,
  entry: AuditEntry,
  origin: RequestOrigin = { ip: null, userAgentHash: null },
): Prisma.AuditEventCreateManyInput {
  return {
    userId: user?.id ?? null,
    ...(user?.name ? { actorLabel: user.name } : {}),
    role: user?.role ?? null,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    serviceDate: entry.serviceDate ? fromIsoDate(entry.serviceDate) : null,
    ...(origin.ip ? { ip: origin.ip } : {}),
    ...(origin.userAgentHash ? { userAgentHash: origin.userAgentHash } : {}),
    ...(entry.details ? { details: entry.details as Prisma.InputJsonObject } : {}),
  };
}

/**
 * The fields of `next` whose value differs from `previous`, as audit details
 * `{ field: { from, to } }`. Only for non-medical values (settings, tariffs).
 */
export function changedFields(
  previous: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
  fields: readonly string[] = Object.keys(next),
): AuditDetails {
  const details: AuditDetails = {};
  for (const field of fields) {
    const from = detailValue(previous[field]);
    const to = detailValue(next[field]);
    if (from !== to) details[field] = { from, to };
  }
  return details;
}

/** A plain JSON value for the details: dates as "YYYY-MM-DD…" strings, arrays joined. */
function detailValue(value: unknown): DetailValue {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.map(String).join(",");
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}
