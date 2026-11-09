/**
 * What « Valider le planning » asks the regulator to confirm. Pure: built
 * from the planning view (the page and the action read the same thing).
 */
import type { PlanningDayView } from "./types";

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

/** "a", "a et b", "a, b et c". */
function listing(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} et ${items[items.length - 1]}`;
}

export type ValidationView = Pick<
  PlanningDayView,
  "unassigned" | "violations" | "violationsKnown" | "staleTrips" | "trips" | "vehicleIssues"
>;

/** Everything a validated day should not carry silently, in French, most serious first. */
export function validationIssues(view: ValidationView): string[] {
  const issues: string[] = [];
  const replan = view.vehicleIssues.filter((issue) => issue.changes.length > 0).length;
  if (replan > 0) {
    issues.push(
      plural(
        replan,
        "tournée planifiée avant un changement de véhicule ou d'équipage",
        "tournées planifiées avant un changement de véhicule ou d'équipage",
      ),
    );
  }
  // Only vehicles that drive that day: an overdue vehicle without a route stays in « À traiter » and /equipages.
  const compliance = view.vehicleIssues.filter((issue) => issue.hasRoute && issue.compliance.length > 0).length;
  if (compliance > 0) {
    issues.push(
      plural(
        compliance,
        "véhicule à l'échéance dépassée (contrôle technique ou assurance)",
        "véhicules à l'échéance dépassée (contrôle technique ou assurance)",
      ),
    );
  }
  if (view.unassigned.length > 0) issues.push(plural(view.unassigned.length, "course non affectée", "courses non affectées"));
  if (view.violations.length > 0) {
    issues.push(plural(view.violations.length, "violation de contrainte", "violations de contraintes"));
  } else if (!view.violationsKnown) {
    issues.push("des violations de contraintes");
  }
  const returnsToCheck = view.trips.filter((trip) => trip.outboundNoShow).length;
  if (returnsToCheck > 0) {
    issues.push(plural(returnsToCheck, "retour à vérifier (patient absent à l'aller)", "retours à vérifier (patient absent à l'aller)"));
  }
  if (view.staleTrips.length > 0) {
    issues.push(
      plural(
        view.staleTrips.length,
        "course à revoir (annulée, patient absent ou figée ailleurs)",
        "courses à revoir (annulées, patient absent ou figées ailleurs)",
      ),
    );
  }
  return issues;
}

/** The question shown before validating a day with issues. */
export function validationQuestion(issues: readonly string[]): string {
  return `Le planning comporte ${listing(issues)}. Valider quand même ?`;
}
