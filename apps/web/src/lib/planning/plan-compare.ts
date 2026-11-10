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
 *
 * The plan in place is judged on what can still be driven: a route whose
 * vehicle was made unavailable or deactivated since, or whose crew changed
 * (absence, replacement: lib/planning/route-issues.ts), serves nobody. Its
 * trips count neither as served in place nor as lost by the new plan.
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
  /**
   * Routes in place that can no longer be driven as saved (vehicle labels)
   * and the trips on them: left out of `current` and of lostTripIds. Absent
   * when there is none (and from comparisons stored before).
   */
  undrivable?: { vehicles: string[]; trips: number };
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

/** The crew a route is saved with (persist.ts planRoutes): its driver, and the crew mate of an ambulance. */
export type RouteCrew = { driverId: string | null; crewMateId: string | null };

/** The crew a new route of a vehicle gets today; no crewMateId: not an ambulance, the crew mate does not matter. */
export type TodayCrew = { driverId: string | null; crewMateId?: string | null };

/**
 * Whether a route in place can still be driven as saved: its vehicle is sent
 * to the optimizer today, with the crew a new route would get. Otherwise the
 * vehicle was made unavailable or deactivated, or its crew changed since
 * (the same cases as route-issues.ts, whose « Véhicules à revoir » lists them).
 */
export function isDrivable(route: RouteCrew & { vehicleId: string }, todayCrews: ReadonlyMap<string, TodayCrew>): boolean {
  const crew = todayCrews.get(route.vehicleId);
  if (!crew || crew.driverId !== route.driverId) return false;
  return crew.crewMateId === undefined || crew.crewMateId === route.crewMateId;
}

export function comparePlans(
  current: {
    figures: PlanFigures;
    servedTripIds: readonly string[];
    undrivable?: { vehicles: string[]; trips: number };
  } | null,
  next: { figures: PlanFigures; servedTripIds: readonly string[] },
): PlanComparison {
  const nextServed = new Set(next.servedTripIds);
  return {
    current: current?.figures ?? null,
    next: next.figures,
    lostTripIds: current ? current.servedTripIds.filter((id) => !nextServed.has(id)) : [],
    ...(current?.undrivable && current.undrivable.vehicles.length > 0 ? { undrivable: current.undrivable } : {}),
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

/** "a", "a et b", "a, b et c". */
function listing(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} et ${items[items.length - 1]}`;
}

/**
 * « Les tournées de Taxi 2 et VSL 2 ne peuvent plus être assurées : 8 courses
 * ne sont pas comptées comme servies dans le planning actuel. », or null.
 */
export function undrivableNote(comparison: Pick<PlanComparison, "undrivable">): string | null {
  const undrivable = comparison.undrivable;
  if (!undrivable || undrivable.vehicles.length === 0) return null;
  const vehicles = listing(undrivable.vehicles);
  const routes =
    undrivable.vehicles.length > 1
      ? `Les tournées de ${vehicles} ne peuvent plus être assurées`
      : `La tournée de ${vehicles} ne peut plus être assurée`;
  if (undrivable.trips === 0) return `${routes}.`;
  const trips = plural(undrivable.trips, "course n'est pas comptée comme servie", "courses ne sont pas comptées comme servies");
  return `${routes}\u00a0: ${trips} dans le planning actuel.`;
}

/**
 * The question asked before replacing the routes in place: « Ce calcul sert
 * 280 courses contre 300 dans le planning actuel, avec 2 violations de
 * contraintes (aucune actuellement) : remplacer quand même ? ». Only the
 * concerns are named; the page shows every figure side by side. Routes in
 * place that can no longer be driven are said first (undrivableNote).
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
  const question = current ? `${what}\u00a0: remplacer quand même\u202f?` : `${what}\u00a0: l'enregistrer quand même\u202f?`;
  const note = undrivableNote(comparison);
  return note ? `${note} ${question}` : question;
}

/** Figures as a short line: "300 courses servies · 0 violation · marge 4 800 € · 1 790 km". */
export function figuresLine(figures: PlanFigures): string {
  const km = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(figures.km);
  return [
    plural(figures.served, "course servie", "courses servies"),
    violationsText(figures.violations),
    `marge ${euros.format(figures.margin)}`,
    `${km}\u00a0km`,
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

/**
 * The routes in place of a date as the start of its re-optimization (contract
 * `initialRoutes`): their stop sequences in order, on the vehicles and trips
 * of the request (restorableRoutes). The optimizer repairs them to the rules
 * of the request and never returns a plan that scores worse under its
 * objective (contract/README.md, « Planning en place »); null when there are none.
 */
export function routesInPlace(
  routes: ReadonlyArray<Pick<RouteFigures, "vehicleId" | "stops">>,
  request: { vehicles: ReadonlyArray<{ id: string }>; trips: ReadonlyArray<{ id: string }> },
): { vehicleId: string; stops: { tripId: string; kind: StopKind }[] }[] | null {
  const ordered = routes.map((route) => ({
    vehicleId: route.vehicleId,
    stops: [...route.stops].sort((a, b) => a.sequence - b.sequence).map(({ tripId, kind }) => ({ tripId, kind })),
  }));
  const kept = restorableRoutes(
    { routes: ordered },
    new Set(request.vehicles.map((v) => v.id)),
    new Set(request.trips.map((t) => t.id)),
  );
  return kept.length > 0 ? kept : null;
}

/** How a new plan's routes differ from the routes in place (changedRoutes). */
export type RouteChanges = {
  /** Routes of the new plan whose stop sequence is not that of the vehicle's route in place (new ones included). */
  changed: number;
  /** Routes in place whose vehicle has no route in the new plan. */
  removed: number;
  /** Routes of the new plan. */
  total: number;
};

/**
 * Routes a new plan changes, vehicle by vehicle, against the routes in place
 * as stored (stops by sequence; routes without stops ignored). A
 * re-optimization of an unchanged day often gives back the plan in place: the
 * regulator is told so rather than shown it as a new result.
 */
export function changedRoutes(
  inPlace: ReadonlyArray<Pick<RouteFigures, "vehicleId" | "stops">>,
  next: ReadonlyArray<{ vehicleId: string; stops: ReadonlyArray<{ tripId: string; kind: StopKind }> }>,
): RouteChanges {
  const sequence = (stops: ReadonlyArray<{ tripId: string; kind: StopKind }>) =>
    stops.map((stop) => `${stop.tripId}/${stop.kind}`).join(" ");
  const before = new Map(
    inPlace
      .filter((route) => route.stops.length > 0)
      .map((route) => [route.vehicleId, sequence([...route.stops].sort((a, b) => a.sequence - b.sequence))]),
  );
  const after = next.filter((route) => route.stops.length > 0);
  const kept = new Set(after.map((route) => route.vehicleId));
  return {
    changed: after.filter((route) => before.get(route.vehicleId) !== sequence(route.stops)).length,
    removed: [...before.keys()].filter((vehicleId) => !kept.has(vehicleId)).length,
    total: after.length,
  };
}
