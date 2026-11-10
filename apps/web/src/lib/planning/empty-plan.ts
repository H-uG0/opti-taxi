/**
 * Guard before saving a computed plan. Pure: shared by runOptimization and its tests.
 *
 * Saving a plan replaces every route of the day (savePlan). A plan serving no
 * trip, although the optimizer received some, must not do that: on a
 * 120-vehicle day the optimizer once answered with such a plan, empty and yet
 * "valid" (it breaks no rule), when its time limit cut the search short.
 */
import type { PlanResponse } from "@/lib/optimizer/contract";

/**
 * Start of the reason the optimizer gives a trip its routes have no place for
 * (solver.REASON_DROPPED_PREFIX): the trip's own times and what keeps each
 * vehicle from taking it follow, different for every trip.
 */
const NO_ROOM_PREFIX = "Pas de place dans les tournées pour le trajet de";

/** Times of a reason screened out by the optimizer: « (rendez-vous à 09:00) », « (fin de séance à 16:30) ». */
const TRIP_TIMES = /\s*\((?:rendez-vous|fin de séance) à \d{2}:\d{2}\)/g;

function clause(text: string): string {
  return text.trim().replace(/[.\s]+$/, "");
}

/**
 * The reason without what is particular to its trip, so that alike reasons
 * count together: free-text reasons carry the trip's times and, for a trip
 * the routes have no place for, what each vehicle does.
 */
function reasonGroup(reason: string): string {
  if (reason.startsWith(NO_ROOM_PREFIX)) return "Pas de place dans les tournées";
  return reason.replace(TRIP_TIMES, "");
}

/** Why the plan must not replace the day's routes (it serves no trip at all), or null. */
export function emptyPlanIssue(plan: Pick<PlanResponse, "kpis" | "unassigned">): string | null {
  if (plan.kpis.tripsServed > 0 || plan.kpis.tripsTotal === 0) return null;
  const counts = new Map<string, number>();
  for (const { reason } of plan.unassigned) {
    const group = reasonGroup(reason);
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  let main: [string, number] | null = null;
  for (const entry of counts) if (!main || entry[1] > main[1]) main = entry;
  const total = plan.kpis.tripsTotal;
  const why = main ? ` Motif le plus fréquent (${main[1]} sur ${total}) : ${clause(main[0])}.` : "";
  return `L'optimisation n'a placé aucune des ${total} courses : le planning actuel est conservé.${why}`;
}
