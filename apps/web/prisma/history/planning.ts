/**
 * The regulator's decisions on the eve of a simulated day (pure, unit-tested).
 *
 * - After each « Optimiser demain » / « Réoptimiser », every patient the plan
 *   shares is called. A refusal is recorded as such and calls for a new
 *   optimization: a refused trip is no longer shareable, so the loop
 *   converges. The cap is only a safety net (a run with a new refusal after
 *   the cap gives the day up rather than validating a plan that shares a
 *   patient who refused).
 * - Trips the last optimization could not place are handed over to a partner
 *   company (« confrère ») before validation: recorded in « Courses » with a
 *   note, then « Annuler », so no past day ends with a patient silently left
 *   without transport.
 */
import type { TripStatus } from "@prisma/client";

/** Safety cap on the optimizations of one day (one refusal after another). */
export const MAX_RUNS_PER_DAY = 6;

export type PlanningStep = "validate" | "reoptimize" | "give-up";

/** What follows the answers to the `runs`-th optimization of the day. */
export function nextPlanningStep(runs: number, refused: number): PlanningStep {
  if (refused === 0) return "validate";
  return runs < MAX_RUNS_PER_DAY ? "reoptimize" : "give-up";
}

/** Note written on a trip handed over to a partner company. */
export const HANDOVER_NOTE = "Course confiée à un confrère la veille : non placée par l'optimisation.";

/** Trip notes after the hand-over: the existing note is kept, the hand-over is added below. */
export function handOverNotes(existing: string | null): string {
  const kept = existing?.trim();
  return kept ? `${kept}\n${HANDOVER_NOTE}` : HANDOVER_NOTE;
}

/** Trips that are still to be carried by V. */
const OPEN_STATUSES: readonly TripStatus[] = ["PLANNED", "ASSIGNED"];

/** Trips of the day left on no route by the last optimization: to hand over, in a stable order. */
export function unplacedTripIds(trips: readonly { id: string; status: TripStatus; routeId: string | null }[]): string[] {
  return trips
    .filter((trip) => trip.routeId === null && OPEN_STATUSES.includes(trip.status))
    .map((trip) => trip.id)
    .sort((a, b) => a.localeCompare(b));
}
