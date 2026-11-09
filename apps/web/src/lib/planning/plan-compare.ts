/**
 * Never replace the routes in place silently with a worse or invalid plan.
 * Pure: shared by savePlan's guard, runOptimization and the planning page.
 *
 * Saving a plan replaces every route of the day (savePlan). Before it does,
 * the new plan is compared with the routes in place: trips served, hard-rule
 * violations, margin and km. It is saved at once only when it serves as many
 * trips (AppSettings.replanMaxServedLoss: fewer accepted), breaks no more
 * rules (no tolerance: every plan must pass the validator), and does not lose
 * more margin than AppSettings.replanMaxMarginLoss × the revenue in place.
 * Otherwise the regulator decides: « remplacer quand même » or keep the plan
 * in place. A move (« Déplacer vers… ») that would leave other trips without
 * a vehicle is refused outright.
 */
import type { StopKind } from "@prisma/client";

/** Figures of a plan (routes in place, or a new computation). */
export type PlanFigures = {
  /** Trips on a route (cancelled and absent ones aside). */
  served: number;
  /** Hard-rule violations; null when unknown (computation saved before they were stored). */
  violations: number | null;
  revenue: number;
  margin: number;
  km: number;
};

export type PlanComparison = {
  /** The routes in place; null when the date has none (first computation). */
  current: PlanFigures | null;
  next: PlanFigures;
  /** Trips served in place that the new plan leaves without a vehicle. */
  lostTripIds: string[];
};

/** AppSettings.replanMaxServedLoss and replanMaxMarginLoss. */
export type ReplaceThresholds = { maxServedLoss: number; maxMarginLoss: number };

/** Start of the error of a run whose plan was not kept (discarded, superseded, no longer savable). */
export const NOT_KEPT_PREFIX = "Calcul non retenu";

/** The schema defaults: no trip lost, margin loss up to 10 % of the revenue in place. */
export const DEFAULT_REPLACE_THRESHOLDS: ReplaceThresholds = { maxServedLoss: 0, maxMarginLoss: 0.1 };

export type ReplaceConcern = "served" | "violations" | "margin";

/** A route as the comparison and the snapshot read it. */
export type RouteFigures = {
  vehicleId: string;
  revenue: number;
  margin: number;
  distanceKm: number;
  stops: ReadonlyArray<{ tripId: string; kind: StopKind; sequence: number }>;
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Figures of a set of routes and the trips they serve. */
export function planFigures(
  routes: ReadonlyArray<Pick<RouteFigures, "revenue" | "margin" | "distanceKm">>,
  served: number,
  violations: number | null,
): PlanFigures {
  return {
    served,
    violations,
    revenue: round2(routes.reduce((sum, r) => sum + r.revenue, 0)),
    margin: round2(routes.reduce((sum, r) => sum + r.margin, 0)),
    km: round2(routes.reduce((sum, r) => sum + r.distanceKm, 0)),
  };
}

export function comparePlans(
  current: { figures: PlanFigures; servedTripIds: readonly string[] } | null,
  next: { figures: PlanFigures; servedTripIds: readonly string[] },
): PlanComparison {
  const nextServed = new Set(next.servedTripIds);
  return {
    current: current?.figures ?? null,
    next: next.figures,
    lostTripIds: current ? current.servedTripIds.filter((id) => !nextServed.has(id)) : [],
  };
}

/** Why the new plan must not replace the routes in place without the regulator's word (empty: save it). */
export function replaceConcerns(comparison: PlanComparison, thresholds: ReplaceThresholds): ReplaceConcern[] {
  const { current, next } = comparison;
  const concerns: ReplaceConcern[] = [];
  if (current && current.served - next.served > thresholds.maxServedLoss) concerns.push("served");
  // Unknown violations in place count as none: the new plan must pass the validator anyway.
  if ((next.violations ?? 0) > (current?.violations ?? 0)) concerns.push("violations");
  if (current) {
    const loss = current.margin - next.margin;
    if (loss > 0.005 && loss > thresholds.maxMarginLoss * Math.max(current.revenue, 0)) concerns.push("margin");
  }
  return concerns;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

const euros = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

/** "2 violations de contraintes", "aucune violation". */
function violationsText(count: number | null): string {
  if (count === null) return "des violations non détaillées";
  return count === 0 ? "aucune violation" : plural(count, "violation de contrainte", "violations de contraintes");
}

/**
 * The question asked before replacing the routes in place: « Ce calcul sert
 * 280 courses contre 300 dans le planning actuel, avec 2 violations de
 * contraintes (aucune actuellement) : remplacer quand même ? ». Only the
 * concerns are named; the page shows every figure side by side.
 */
export function comparisonQuestion(
  comparison: PlanComparison,
  concerns: readonly ReplaceConcern[],
  subject = "Ce calcul",
): string {
  const { current, next } = comparison;
  const parts: string[] = [];
  if (concerns.includes("served") && current) {
    parts.push(`sert ${plural(next.served, "course")} contre ${current.served} dans le planning actuel`);
  }
  if (concerns.includes("violations")) {
    const now = current ? ` (${current.violations === 0 ? "aucune" : (current.violations ?? "?")} actuellement)` : "";
    parts.push(`${parts.length > 0 ? "avec" : "comporte"} ${violationsText(next.violations)}${now}`);
  }
  if (concerns.includes("margin") && current) {
    parts.push(`dégage une marge de ${euros.format(next.margin)} contre ${euros.format(current.margin)}`);
  }
  const what = parts.length > 0 ? `${subject} ${parts.join(", ")}` : `${subject} est moins bon que le planning actuel`;
  return current ? `${what} : remplacer quand même ?` : `${what} : l'enregistrer quand même ?`;
}

/** Figures as a short line: "300 courses servies · 0 violation · marge 4 800 € · 1 790 km". */
export function figuresLine(figures: PlanFigures): string {
  const km = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(figures.km);
  return [
    plural(figures.served, "course servie", "courses servies"),
    violationsText(figures.violations),
    `marge ${euros.format(figures.margin)}`,
    `${km} km`,
  ].join(" · ");
}

// ---------------------------------------------------------------------------
// Snapshot of the routes replaced, and their restoration
// ---------------------------------------------------------------------------

/** Stop sequences of the routes replaced by a computation (OptimizationRun.details.previous). */
export type PlanSnapshot = {
  /** Run that had produced them (null: unknown). */
  runId: string | null;
  figures: PlanFigures;
  routes: { vehicleId: string; stops: { tripId: string; kind: StopKind }[] }[];
};

export function snapshotOf(runId: string | null, routes: readonly RouteFigures[], figures: PlanFigures): PlanSnapshot {
  return {
    runId,
    figures,
    routes: routes
      .filter((route) => route.stops.length > 0)
      .map((route) => ({
        vehicleId: route.vehicleId,
        stops: [...route.stops].sort((a, b) => a.sequence - b.sequence).map(({ tripId, kind }) => ({ tripId, kind })),
      })),
  };
}

/**
 * The snapshot's stop sequences that can be evaluated today: routes of the
 * vehicles still sent to the optimizer, stops of the trips still sent, and
 * only trips with their pick-up then drop-off on the same route (a trip met
 * twice keeps its first route). What is left out comes back unassigned.
 */
export function restorableRoutes(
  snapshot: Pick<PlanSnapshot, "routes">,
  vehicleIds: ReadonlySet<string>,
  tripIds: ReadonlySet<string>,
): { vehicleId: string; stops: { tripId: string; kind: StopKind }[] }[] {
  const placed = new Set<string>();
  const routes: { vehicleId: string; stops: { tripId: string; kind: StopKind }[] }[] = [];
  const seenVehicles = new Set<string>();
  for (const route of snapshot.routes) {
    if (!vehicleIds.has(route.vehicleId) || seenVehicles.has(route.vehicleId)) continue;
    seenVehicles.add(route.vehicleId);
    const pickupAt = new Map<string, number>();
    const dropoffAt = new Map<string, number>();
    route.stops.forEach((stop, i) => {
      const map = stop.kind === "PICKUP" ? pickupAt : dropoffAt;
      if (!map.has(stop.tripId)) map.set(stop.tripId, i);
    });
    const keep = new Set(
      [...pickupAt.keys()].filter((id) => {
        const pickup = pickupAt.get(id) ?? -1;
        const dropoff = dropoffAt.get(id) ?? -1;
        return tripIds.has(id) && !placed.has(id) && dropoff > pickup;
      }),
    );
    for (const id of keep) placed.add(id);
    const stops = route.stops.filter(
      (stop, i) => keep.has(stop.tripId) && (stop.kind === "PICKUP" ? pickupAt : dropoffAt).get(stop.tripId) === i,
    );
    if (stops.length > 0) routes.push({ vehicleId: route.vehicleId, stops });
  }
  return routes;
}
