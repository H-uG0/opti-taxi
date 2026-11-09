/**
 * Audit trail of the simulated actions (pure, unit-tested): the AuditEvent
 * rows the app writes with each change (lib/audit.ts), for the actions the
 * simulation replays: « Optimiser demain » (plan.optimize, written with the
 * saved plan as runOptimization does), the patients' sharing answers
 * (trip.sharing_accept / trip.sharing_refuse, only for an answer actually
 * saved), « Valider le planning » (plan.validate), the cancellations and
 * hand-overs to a partner company (trip.cancel, as « Annuler »), the trips the
 * regulator freezes on their vehicle (trip.lock, as « Figer ») and the crews'
 * statuses (stop.pickup, stop.dropoff, stop.no_show, written on the trip as
 * the roadmap does). day.ts writes each event in the transaction of its
 * change. Each event carries the instant the change was saved and a "hist-"
 * id, so a re-run deletes it with its day (ownership.ts). Ids only, like the
 * app: never a name, an address or a note. Not traced (kept proportionate):
 * the trip generation.
 */
import type { Prisma, StopKind, UserRole } from "@prisma/client";
import type { SharingDecision } from "@/app/(regulator)/courses/trip-rules";
// Type only, erased at run time: nothing server-only is loaded.
import type { AuditEntity } from "@/lib/audit";
import { fromIsoDate } from "@/lib/time";
import { historyAuditEventId } from "./ids";

/** The simulated actions and the entity each one is about (same names as the app). */
export const SIMULATED_ACTIONS = {
  "plan.optimize": "OptimizationRun",
  "plan.validate": "Route",
  "trip.sharing_accept": "Trip",
  "trip.sharing_refuse": "Trip",
  "trip.cancel": "Trip",
  "trip.lock": "Trip",
  "stop.pickup": "Trip",
  "stop.dropoff": "Trip",
  "stop.no_show": "Trip",
} as const satisfies Record<`${string}.${string}`, AuditEntity>;

export type SimulatedAction = keyof typeof SIMULATED_ACTIONS;

/** Who acted: the account (null when there is none) and its role. */
export type AuditActor = { id: string | null; role: UserRole };

/** Events of one simulated day, numbered in the order they are written. */
export class DayAuditTrail {
  private readonly isoDate: string;
  private written = 0;

  constructor(isoDate: string) {
    this.isoDate = isoDate;
  }

  /** Row of `action` on `entityId` by `actor` at `at` (entityId null for a whole day, as plan.validate). */
  event(actor: AuditActor, action: SimulatedAction, entityId: string | null, at: Date): Prisma.AuditEventCreateManyInput {
    this.written++;
    return {
      id: historyAuditEventId(this.isoDate, this.written),
      at,
      userId: actor.id,
      role: actor.role,
      action,
      entity: SIMULATED_ACTIONS[action],
      entityId,
      serviceDate: fromIsoDate(this.isoDate),
    };
  }
}

/** The action of a recorded sharing answer, as « Courses » traces it. */
export function sharingAuditAction(decision: SharingDecision): SimulatedAction {
  return decision === "REFUSED" ? "trip.sharing_refuse" : "trip.sharing_accept";
}

/** The action of a status tapped on the roadmap: « Patient absent » is tapped on the pickup stop. */
export function stopAuditAction(kind: StopKind, absent: boolean): SimulatedAction {
  if (kind === "DROPOFF") return "stop.dropoff";
  return absent ? "stop.no_show" : "stop.pickup";
}
