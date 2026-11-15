/**
 * Status transitions the crew records from the roadmap. Pure rules shared by
 * the status route handler (api/chauffeur/stops/[id]/status, which re-checks
 * them against the database) and the page (which shows only the buttons that
 * would succeed). "Now" is the time of the gesture on the phone, bounded by
 * the server (observed-time.ts), not the time the server receives it.
 *
 * - "Pris en charge" (PICKUP) on a pickup stop: stop completed now, trip PICKED_UP.
 * - "Déposé" (DROPOFF) on a dropoff stop: stop completed now, trip DROPPED_OFF.
 *   Requires the pickup to be recorded first (trip PICKED_UP).
 * - "Patient absent" (NO_SHOW) on a pickup stop: the pickup stop is completed
 *   now (the time the crew noted the absence) and the trip becomes NO_SHOW.
 *   Its dropoff stop is left untouched (completedAt stays null) and is shown as
 *   skipped: the dropoff never happened, so no fake dropoff time is recorded.
 * - "Annuler" (UNDO) on the stop holding the latest status of the route: the
 *   stop's completedAt is cleared and the trip goes back one step
 *   (PICKED_UP or NO_SHOW -> ASSIGNED, DROPPED_OFF -> PICKED_UP).
 * - "Arrivé" (ARRIVE, FLD-01) on a pickup still to do: optional, the stop's
 *   arrivedAt is set now (the wait at the door starts, see
 *   lib/domain/field-wait.ts); nothing else changes. "Annuler l'arrivée"
 *   (UNDO_ARRIVE) clears it while the pickup is still to do. The minimum wait
 *   before an absence is checked by the route (it needs the settings).
 *
 * Every action is idempotent: replaying it once its effect is in place (a
 * retry after a lost response on a flaky mobile network) changes nothing and
 * succeeds. Undo targets one stop, so a replay never undoes a second status.
 */
import type { StopKind, TripStatus } from "@prisma/client";
import { stopState } from "./roadmap";

export type StopAction = "PICKUP" | "DROPOFF" | "NO_SHOW" | "UNDO" | "ARRIVE" | "UNDO_ARRIVE";

export const STOP_ACTION_LABELS: Record<StopAction, string> = {
  PICKUP: "Pris en charge",
  DROPOFF: "Déposé",
  NO_SHOW: "Patient absent",
  UNDO: "Annuler",
  ARRIVE: "Arrivé",
  UNDO_ARRIVE: "Annuler l'arrivée",
};

/** Actions that only date the arrival at a pickup (RouteStop.arrivedAt): the stop's status is not touched. */
export function isArrivalAction(action: string): action is "ARRIVE" | "UNDO_ARRIVE" {
  return action === "ARRIVE" || action === "UNDO_ARRIVE";
}

/**
 * AuditEvent action of each status action. Events are written on the trip
 * (entity Trip), never on the stop: stops are deleted when a trip leaves its
 * route or the day is re-optimized, the trip stays. An undo names the stop
 * kind it reverts, since the trip alone does not say which status was undone.
 */
export const STOP_AUDIT_ACTIONS = {
  PICKUP: "stop.pickup",
  DROPOFF: "stop.dropoff",
  NO_SHOW: "stop.no_show",
  ARRIVE: "stop.arrive",
  UNDO_ARRIVE: "stop.undo_arrive",
} as const satisfies Record<Exclude<StopAction, "UNDO">, `stop.${string}`>;

export function stopAuditAction(action: StopAction, kind: StopKind): `stop.${string}` {
  if (action !== "UNDO") return STOP_AUDIT_ACTIONS[action];
  return kind === "PICKUP" ? "stop.undo_pickup" : "stop.undo_dropoff";
}

export type StopSnapshot = {
  kind: StopKind;
  completedAt: Date | null;
  tripStatus: TripStatus;
  /** The stop holds the most recent status of its route (see latestCompletedStopId). */
  isLatestCompleted: boolean;
  /** « Arrivé » recorded on the pickup (absent: none). */
  arrivedAt?: Date | null;
};

export type StopDecision =
  /**
   * Write these values (guarded by the snapshot they were computed from). `arrivedAt` is set for an arrival action
   * only (ARRIVE, UNDO_ARRIVE), which writes nothing else.
   */
  | { type: "apply"; completedAt: Date | null; tripStatus: TripStatus; arrivedAt?: Date | null; message: string }
  /** Already in place: nothing to write, report success. */
  | { type: "noop"; message: string }
  /** Not allowed in the current state. */
  | { type: "refuse"; error: string; reason: RefusalReason };

export type RefusalReason =
  | "WRONG_KIND"
  | "CANCELLED"
  | "NO_SHOW"
  | "NOT_PICKED_UP"
  | "ALREADY_PICKED_UP"
  | "NOT_LATEST"
  | "UNDO_DROPOFF_FIRST"
  | "ALREADY_RECORDED";

const OPEN: readonly TripStatus[] = ["PLANNED", "ASSIGNED"];
const ON_BOARD_OR_LATER: readonly TripStatus[] = ["PICKED_UP", "DROPPED_OFF"];

function refuse(reason: RefusalReason, error: string): StopDecision {
  return { type: "refuse", reason, error };
}

const CANCELLED_ERROR = "Course annulée par la régulation\u00a0: statut non modifiable.";

export function decideStopAction(action: StopAction, stop: StopSnapshot, now: Date): StopDecision {
  const { kind, completedAt, tripStatus } = stop;

  switch (action) {
    case "PICKUP": {
      if (kind !== "PICKUP") return refuse("WRONG_KIND", "Cet arrêt n'est pas une prise en charge.");
      if (tripStatus === "CANCELLED") return refuse("CANCELLED", CANCELLED_ERROR);
      if (tripStatus === "NO_SHOW") return refuse("NO_SHOW", "Patient déclaré absent\u00a0: annulez l'absence d'abord.");
      if (ON_BOARD_OR_LATER.includes(tripStatus)) {
        if (completedAt) return { type: "noop", message: "Prise en charge déjà enregistrée." };
        // Trip already on board but the stop has no time yet: record the missing time only.
        return { type: "apply", completedAt: now, tripStatus, message: "Prise en charge enregistrée." };
      }
      return { type: "apply", completedAt: completedAt ?? now, tripStatus: "PICKED_UP", message: "Prise en charge enregistrée." };
    }

    case "DROPOFF": {
      if (kind !== "DROPOFF") return refuse("WRONG_KIND", "Cet arrêt n'est pas une dépose.");
      if (tripStatus === "CANCELLED") return refuse("CANCELLED", CANCELLED_ERROR);
      if (tripStatus === "NO_SHOW") return refuse("NO_SHOW", "Patient déclaré absent\u00a0: pas de dépose.");
      if (tripStatus === "DROPPED_OFF") {
        if (completedAt) return { type: "noop", message: "Dépose déjà enregistrée." };
        return { type: "apply", completedAt: now, tripStatus, message: "Dépose enregistrée." };
      }
      if (tripStatus !== "PICKED_UP") {
        return refuse("NOT_PICKED_UP", "Enregistrez d'abord la prise en charge de ce patient.");
      }
      return { type: "apply", completedAt: completedAt ?? now, tripStatus: "DROPPED_OFF", message: "Dépose enregistrée." };
    }

    case "NO_SHOW": {
      if (kind !== "PICKUP") return refuse("WRONG_KIND", "L'absence se déclare sur la prise en charge.");
      if (tripStatus === "CANCELLED") return refuse("CANCELLED", CANCELLED_ERROR);
      if (tripStatus === "NO_SHOW") {
        if (completedAt) return { type: "noop", message: "Absence déjà enregistrée." };
        return { type: "apply", completedAt: now, tripStatus, message: "Absence enregistrée." };
      }
      if (!OPEN.includes(tripStatus)) {
        return refuse("ALREADY_PICKED_UP", "Patient déjà pris en charge\u00a0: annulez la prise en charge d'abord.");
      }
      return { type: "apply", completedAt: completedAt ?? now, tripStatus: "NO_SHOW", message: "Absence enregistrée." };
    }

    case "ARRIVE": {
      if (kind !== "PICKUP") return refuse("WRONG_KIND", "L'arrivée se note sur une prise en charge.");
      if (stop.arrivedAt) return { type: "noop", message: "Arrivée déjà enregistrée." };
      if (tripStatus === "CANCELLED") return refuse("CANCELLED", CANCELLED_ERROR);
      if (tripStatus === "NO_SHOW") return refuse("NO_SHOW", "Patient déclaré absent\u00a0: annulez l'absence d'abord.");
      // The patient is already on board (taken by the other crew member): the arrival no longer tells anything.
      if (completedAt || ON_BOARD_OR_LATER.includes(tripStatus)) return { type: "noop", message: "Prise en charge déjà enregistrée." };
      return { type: "apply", completedAt, tripStatus, arrivedAt: now, message: "Arrivée enregistrée." };
    }

    case "UNDO_ARRIVE": {
      if (!stop.arrivedAt) return { type: "noop", message: "Arrivée déjà annulée." };
      if (tripStatus === "CANCELLED") return refuse("CANCELLED", CANCELLED_ERROR);
      if (completedAt || !OPEN.includes(tripStatus)) {
        return refuse("ALREADY_RECORDED", "Statut déjà saisi sur cet arrêt\u00a0: l'arrivée reste enregistrée.");
      }
      return { type: "apply", completedAt, tripStatus, arrivedAt: null, message: "Arrivée annulée." };
    }

    case "UNDO": {
      if (!completedAt) return { type: "noop", message: "Statut déjà annulé." };
      if (tripStatus === "CANCELLED") return refuse("CANCELLED", CANCELLED_ERROR);
      if (!stop.isLatestCompleted) return refuse("NOT_LATEST", "Seul le dernier statut saisi peut être annulé.");
      if (kind === "PICKUP") {
        if (tripStatus === "DROPPED_OFF") return refuse("UNDO_DROPOFF_FIRST", "Annulez d'abord la dépose de ce patient.");
        return { type: "apply", completedAt: null, tripStatus: "ASSIGNED", message: "Statut annulé." };
      }
      return {
        type: "apply",
        completedAt: null,
        tripStatus: tripStatus === "DROPPED_OFF" ? "PICKED_UP" : tripStatus,
        message: "Statut annulé.",
      };
    }
  }
}

/**
 * Stop fields written for an applied decision: the account that records a
 * status and the moment the server received it go with its time (the
 * gesture, see observed-time.ts), and an undo clears all of them. `source`:
 * a time typed afterwards in « Fin de tournée » (DECLARED, FLD-02), null for
 * a gesture; a regulator's correction (CORRECTED) is written elsewhere.
 */
export function stopWrite(
  decision: Pick<Extract<StopDecision, { type: "apply" }>, "completedAt">,
  userId: string,
  receivedAt: Date,
  source: "DECLARED" | null = null,
): {
  completedAt: Date | null;
  completedById: string | null;
  completedReceivedAt: Date | null;
  completedSource: "DECLARED" | null;
  correctionReason: null;
} {
  const recorded = decision.completedAt !== null;
  return {
    completedAt: decision.completedAt,
    completedById: recorded ? userId : null,
    completedReceivedAt: recorded ? receivedAt : null,
    completedSource: recorded ? source : null,
    correctionReason: null,
  };
}

/** Buttons of a stop on the roadmap. */
export type StopControls = {
  /** Main status button: "Pris en charge" on a pickup, "Déposé" on a dropoff. */
  primary: "PICKUP" | "DROPOFF" | null;
  /** Why the main button is disabled (dropoff before its pickup), null when it is usable. */
  blockedReason: string | null;
  /** "Patient absent" is available. */
  noShow: boolean;
  /** "Annuler" is available (latest recorded status of the route). */
  undo: boolean;
  /** "Arrivé" is available (a pickup still to do, no arrival yet). */
  arrive: boolean;
  /** "Annuler l'arrivée" is available (an arrival on a pickup still to do). */
  undoArrive: boolean;
};

export const NO_CONTROLS: StopControls = { primary: null, blockedReason: null, noShow: false, undo: false, arrive: false, undoArrive: false };

/**
 * Buttons to show on a stop: exactly the actions decideStopAction would apply.
 * `editable` is false outside the service day (statuses are recorded on the day only).
 */
export function stopControls(stop: StopSnapshot, editable: boolean): StopControls {
  if (!editable) return NO_CONTROLS;
  const now = new Date(0);
  const applies = (action: StopAction) => decideStopAction(action, stop, now).type === "apply";
  const state = stopState(stop);

  if (state === "done" || state === "no_show") return { ...NO_CONTROLS, undo: applies("UNDO") };
  if (state !== "pending") return NO_CONTROLS;

  if (stop.kind === "PICKUP") {
    return {
      ...NO_CONTROLS,
      primary: applies("PICKUP") ? "PICKUP" : null,
      noShow: applies("NO_SHOW"),
      arrive: applies("ARRIVE"),
      undoArrive: applies("UNDO_ARRIVE"),
    };
  }
  const dropoff = decideStopAction("DROPOFF", stop, now);
  if (dropoff.type === "apply") return { ...NO_CONTROLS, primary: "DROPOFF" };
  if (dropoff.type === "refuse" && dropoff.reason === "NOT_PICKED_UP") {
    return { ...NO_CONTROLS, primary: "DROPOFF", blockedReason: "Prise en charge non saisie\u00a0: enregistrez-la d'abord." };
  }
  return NO_CONTROLS;
}
