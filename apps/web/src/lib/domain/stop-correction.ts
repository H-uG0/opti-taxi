/**
 * The regulator corrects a stop's status after the fact (FLD-02): a forgotten
 * « Déposé », a phone without battery, a status tapped on the wrong stop. The
 * real time and a reason from a list are required, and the correction is
 * audited (stop.correct). Pure rules, shared by the server action and the
 * tests; the status a stop ends with agrees with its trip, as the crew's own
 * statuses do (chauffeur/_lib/transitions.ts):
 * - a pickup: « Pris en charge » (trip on board, or still dropped off), « Patient
 *   absent » (trip NO_SHOW, its drop-off then skipped), or « Sans statut »
 *   (trip back to ASSIGNED), the last two only while its drop-off is not
 *   recorded;
 * - a drop-off: « Déposé » (trip DROPPED_OFF), once the patient is on board, or
 *   « Sans statut » (trip back on board).
 * A drop-off is never before its pickup. Never a time to come.
 */
import type { StatusCorrectionReason, StopKind, TripStatus } from "@prisma/client";

export const CORRECTION_REASONS = ["CREW_FORGOT", "PHONE_ISSUE", "WRONG_ENTRY", "CREW_CALL", "OTHER"] as const satisfies readonly StatusCorrectionReason[];

export const CORRECTION_REASON_LABELS: Record<StatusCorrectionReason, string> = {
  CREW_FORGOT: "Oubli de saisie de l'équipage",
  PHONE_ISSUE: "Téléphone sans batterie ou sans réseau",
  WRONG_ENTRY: "Statut ou heure saisis par erreur",
  CREW_CALL: "Heure donnée par l'équipage au téléphone",
  OTHER: "Autre motif",
};

/** The status a stop is corrected to: « Sans statut » (NONE) removes the one recorded. */
export type CorrectionTarget = "PICKUP" | "DROPOFF" | "NO_SHOW" | "NONE";

export const CORRECTION_TARGET_LABELS: Record<CorrectionTarget, string> = {
  PICKUP: "Pris en charge",
  DROPOFF: "Déposé",
  NO_SHOW: "Patient absent",
  NONE: "Sans statut",
};

/** The targets a stop of this kind offers. */
export function correctionTargets(kind: StopKind): CorrectionTarget[] {
  return kind === "PICKUP" ? ["PICKUP", "NO_SHOW", "NONE"] : ["DROPOFF", "NONE"];
}

export type CorrectionInput = {
  kind: StopKind;
  tripStatus: TripStatus;
  /** The stop's recorded time, null when none. */
  completedAt: Date | null;
  /** The trip's other stop on the route (the drop-off of a pickup, the pickup of a drop-off): its time, null when none. */
  otherAt: Date | null;
  target: CorrectionTarget;
  /** The real time, null for « Sans statut ». */
  at: Date | null;
  now: Date;
};

export type CorrectionDecision =
  | { ok: true; completedAt: Date | null; tripStatus: TripStatus }
  | { ok: false; error: string };

const fail = (error: string): CorrectionDecision => ({ ok: false, error });

/** What a correction writes on the stop and its trip, or why it is refused. */
export function decideCorrection(input: CorrectionInput): CorrectionDecision {
  const { kind, tripStatus, completedAt, otherAt, target, at, now } = input;
  if (tripStatus === "CANCELLED") return fail("Course annulée : son statut ne se corrige pas.");
  if (!correctionTargets(kind).includes(target)) return fail("Statut impossible sur cet arrêt.");
  if (target !== "NONE") {
    if (!at) return fail("Indiquez l'heure réelle.");
    if (at.getTime() > now.getTime()) return fail("Heure à venir : indiquez l'heure réelle, déjà passée.");
  }
  const atMinute = at ? Math.floor(at.getTime() / 60_000) : null;
  const sameTime = completedAt !== null && atMinute !== null && Math.floor(completedAt.getTime() / 60_000) === atMinute;

  if (kind === "PICKUP") {
    const dropped = tripStatus === "DROPPED_OFF";
    switch (target) {
      case "PICKUP": {
        if (otherAt && at && at.getTime() > otherAt.getTime()) return fail("Prise en charge après la dépose enregistrée : corrigez d'abord la dépose.");
        const status: TripStatus = dropped ? "DROPPED_OFF" : "PICKED_UP";
        if (sameTime && (tripStatus === "PICKED_UP" || dropped)) return fail("Aucun changement : ce statut est déjà enregistré à cette heure.");
        return { ok: true, completedAt: at, tripStatus: status };
      }
      case "NO_SHOW":
        if (dropped) return fail("Dépose enregistrée : retirez-la d'abord (« Sans statut » sur la dépose).");
        if (sameTime && tripStatus === "NO_SHOW") return fail("Aucun changement : ce statut est déjà enregistré à cette heure.");
        return { ok: true, completedAt: at, tripStatus: "NO_SHOW" };
      default:
        if (dropped) return fail("Dépose enregistrée : retirez-la d'abord (« Sans statut » sur la dépose).");
        if (completedAt === null && tripStatus !== "PICKED_UP" && tripStatus !== "NO_SHOW") return fail("Aucun statut à retirer.");
        return { ok: true, completedAt: null, tripStatus: "ASSIGNED" };
    }
  }

  if (target === "DROPOFF") {
    if (tripStatus !== "PICKED_UP" && tripStatus !== "DROPPED_OFF") return fail("Prise en charge non enregistrée : corrigez-la d'abord.");
    if (otherAt && at && at.getTime() < otherAt.getTime()) return fail("Dépose avant la prise en charge enregistrée : vérifiez l'heure.");
    if (sameTime && tripStatus === "DROPPED_OFF") return fail("Aucun changement : ce statut est déjà enregistré à cette heure.");
    return { ok: true, completedAt: at, tripStatus: "DROPPED_OFF" };
  }
  if (completedAt === null && tripStatus !== "DROPPED_OFF") return fail("Aucun statut à retirer.");
  return { ok: true, completedAt: null, tripStatus: tripStatus === "DROPPED_OFF" ? "PICKED_UP" : tripStatus };
}

/** The status a stop shows now, in the words of the correction form. */
export function currentTarget(kind: StopKind, completedAt: Date | null, tripStatus: TripStatus): CorrectionTarget {
  if (kind === "PICKUP") {
    if (tripStatus === "NO_SHOW") return "NO_SHOW";
    return completedAt || tripStatus === "PICKED_UP" || tripStatus === "DROPPED_OFF" ? "PICKUP" : "NONE";
  }
  return completedAt || tripStatus === "DROPPED_OFF" ? "DROPOFF" : "NONE";
}
