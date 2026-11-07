/**
 * Guard before saving a computed plan. Pure: shared by runOptimization and its tests.
 *
 * Saving a plan replaces every route of the day (savePlan). A plan serving no
 * trip, although the optimizer received some, must not do that: on a
 * 120-vehicle day the optimizer once answered with such a plan, empty and yet
 * "valid" (it breaks no rule), when its time limit cut the search short.
 */
import type { PlanResponse } from "@/lib/optimizer/contract";

function clause(text: string): string {
  return text.trim().replace(/[.\s]+$/, "");
}

/** Why the plan must not replace the day's routes (it serves no trip at all), or null. */
export function emptyPlanIssue(plan: Pick<PlanResponse, "kpis" | "unassigned">): string | null {
  if (plan.kpis.tripsServed > 0 || plan.kpis.tripsTotal === 0) return null;
  const counts = new Map<string, number>();
  for (const { reason } of plan.unassigned) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  let main: [string, number] | null = null;
  for (const entry of counts) if (!main || entry[1] > main[1]) main = entry;
  const total = plan.kpis.tripsTotal;
  const why = main ? ` Motif le plus fréquent (${main[1]} sur ${total}) : ${clause(main[0])}.` : "";
  return `L'optimisation n'a placé aucune des ${total} courses : le planning actuel est conservé.${why}`;
}
