/**
 * Waiting at a pickup (FLD-01): « Arrivé » dates when the crew reached the
 * patient's door (optional, one tap), « Patient absent » needs a reason from a
 * fixed list, and a minimum wait before an absence can be set in Paramètres
 * (AppSettings.noShowMinWaitMin, 0 by default: no delay, « Arrivé » optional).
 *
 * The wait is counted from the arrival, never before the planned start of the
 * pickup: a crew arriving early does not make the patient late (the patient
 * was told the planned time). Minutes of the service day (Europe/Paris), as
 * every planned time. Pure module, shared by the status route, the roadmap and
 * the dashboard.
 */
import type { NoShowReason } from "@prisma/client";
import { formatMinute } from "@/lib/time";

/** Reasons a crew may give for an absence, in the order the phone lists them. Never a free text (health data). */
export const NO_SHOW_REASONS = ["NO_ANSWER", "REFUSED", "HOSPITALIZED", "FACILITY_CANCELLED", "OTHER"] as const satisfies readonly NoShowReason[];

export const NO_SHOW_REASON_LABELS: Record<NoShowReason, string> = {
  NO_ANSWER: "Pas de réponse",
  REFUSED: "Refus du transport",
  HOSPITALIZED: "Patient hospitalisé",
  FACILITY_CANCELLED: "Séance annulée par l'établissement",
  OTHER: "Autre motif",
};

export function isNoShowReason(value: unknown): value is NoShowReason {
  return typeof value === "string" && (NO_SHOW_REASONS as readonly string[]).includes(value);
}

/** Bounds of the setting noShowMinWaitMin (minutes). */
export const NO_SHOW_MIN_WAIT = { min: 0, max: 60 } as const;

/** Minute the wait at a pickup starts: the arrival, never before the planned start; null without an arrival. */
export function waitStartMinute(arrivedMinute: number | null, plannedStartMinute: number): number | null {
  return arrivedMinute === null ? null : Math.max(arrivedMinute, plannedStartMinute);
}

/** Minutes waited at `nowMinute` since the wait started (0 before it), null without an arrival. */
export function waitedMinutes(arrivedMinute: number | null, plannedStartMinute: number, nowMinute: number): number | null {
  const start = waitStartMinute(arrivedMinute, plannedStartMinute);
  return start === null ? null : Math.max(0, nowMinute - start);
}

/**
 * First minute « Patient absent » may be declared: always (null) without a minimum wait; otherwise the start of the
 * wait plus the minimum, or "arrival" when « Arrivé » has not been recorded yet (the wait has to be shown).
 */
export function noShowAllowedFrom(args: { arrivedMinute: number | null; plannedStartMinute: number; minWaitMin: number }): number | "arrival" | null {
  if (args.minWaitMin <= 0) return null;
  const start = waitStartMinute(args.arrivedMinute, args.plannedStartMinute);
  return start === null ? "arrival" : start + args.minWaitMin;
}

/** Why an absence cannot be declared at `atMinute` (null: it can). */
export function noShowWaitIssue(args: {
  arrivedMinute: number | null;
  plannedStartMinute: number;
  minWaitMin: number;
  atMinute: number;
}): string | null {
  const from = noShowAllowedFrom(args);
  if (from === null) return null;
  if (from === "arrival") {
    return `Attente minimale de ${args.minWaitMin} min avant une absence : touchez d'abord « Arrivé ».`;
  }
  if (args.atMinute < from) {
    return `Attente minimale de ${args.minWaitMin} min avant une absence : possible à partir de ${formatMinute(from)}.`;
  }
  return null;
}
