/**
 * « Accepter véhicule par véhicule » (INS-02): the plan of a re-optimization waiting for the
 * regulator's word, taken for some vehicles only. A vehicle refused keeps its route in place, stop
 * for stop; an accepted vehicle takes its new route. The two halves can disagree on a trip:
 * - a trip the new plan moves from a refused vehicle to an accepted one would be on both: it stays
 *   on the refused vehicle (whose route is kept as it is) and leaves the accepted one's new route;
 * - a trip the new plan moves from an accepted vehicle to a refused one would be on neither: it is
 *   left without a vehicle, and said (never silently).
 * The merged routes are then re-timed and re-checked by the optimizer's /evaluate before anything is
 * saved: the regulator sees the day it makes (figures, violations, trips left out) first.
 * Pure module.
 */
import type { StopKind } from "@prisma/client";
import { restorableRoutes } from "./plan-compare";

export type StopSequence = { vehicleId: string; stops: { tripId: string; kind: StopKind }[] };

export type SelectionMerge = {
  /** The merged routes, each trip once, picked up before dropped off (restorableRoutes). */
  routes: StopSequence[];
  /** Trips kept on a refused vehicle that the new plan gave to an accepted one (taken out of its new route). */
  keptOnRefused: { tripId: string; vehicleId: string; insteadOf: string }[];
  /** Trips served in place or by the new plan that no merged route serves. */
  leftOut: { tripId: string; inPlace: string | null; next: string | null }[];
};

function vehicleOfTrips(routes: readonly StopSequence[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const route of routes) for (const stop of route.stops) if (!map.has(stop.tripId)) map.set(stop.tripId, route.vehicleId);
  return map;
}

/**
 * The routes of the day once the new plan is taken for every vehicle but those of `refused`.
 * `inPlace` and `next` give stop sequences in order; `vehicleIds` and `tripIds` are the request's
 * (a route in place of a vehicle no longer sent cannot be kept: it is never among the refused).
 */
export function mergeSelection(args: {
  inPlace: readonly StopSequence[];
  next: readonly StopSequence[];
  refused: ReadonlySet<string>;
  vehicleIds: ReadonlySet<string>;
  tripIds: ReadonlySet<string>;
}): SelectionMerge {
  const { inPlace, next, refused, vehicleIds, tripIds } = args;
  const keptInPlace = new Map(restorableRoutes({ routes: [...inPlace] }, vehicleIds, tripIds).map((r) => [r.vehicleId, r]));
  const kept: StopSequence[] = [];
  for (const vehicleId of refused) {
    const route = keptInPlace.get(vehicleId);
    if (route) kept.push(route);
  }
  const claimed = vehicleOfTrips(kept);
  const keptOnRefused: SelectionMerge["keptOnRefused"] = [];
  const accepted: StopSequence[] = [];
  for (const route of next) {
    if (refused.has(route.vehicleId)) continue;
    const stops = route.stops.filter((stop) => {
      const owner = claimed.get(stop.tripId);
      if (owner === undefined) return true;
      if (stop.kind === "PICKUP") keptOnRefused.push({ tripId: stop.tripId, vehicleId: owner, insteadOf: route.vehicleId });
      return false;
    });
    if (stops.length > 0) accepted.push({ vehicleId: route.vehicleId, stops });
  }
  const routes = restorableRoutes({ routes: [...kept, ...accepted] }, vehicleIds, tripIds);

  const served = vehicleOfTrips(routes);
  const wasOn = vehicleOfTrips(inPlace);
  const nextOn = vehicleOfTrips(next);
  const leftOut: SelectionMerge["leftOut"] = [];
  for (const tripId of new Set([...wasOn.keys(), ...nextOn.keys()])) {
    if (!tripIds.has(tripId) || served.has(tripId)) continue;
    leftOut.push({ tripId, inPlace: wasOn.get(tripId) ?? null, next: nextOn.get(tripId) ?? null });
  }
  return { routes, keptOnRefused, leftOut };
}

/** A stable key of a selection's routes: the confirmation saves the routes the regulator saw checked. */
export function selectionKeySource(routes: readonly StopSequence[]): string {
  return routes
    .map((route) => `${route.vehicleId}:${route.stops.map((s) => `${s.tripId}/${s.kind}`).join(",")}`)
    .sort()
    .join("|");
}

function listing(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} et ${items[items.length - 1]}`;
}

/**
 * How to keep the trips a selection leaves without a vehicle: « Pour qu'elles gardent un véhicule,
 * cochez aussi Taxi 1, ou décochez Taxi 2. » (the refused vehicles the new plan gives them to, the
 * accepted ones that serve them in place); null when no trip is left out.
 */
export function selectionHint(
  leftOut: SelectionMerge["leftOut"],
  refused: ReadonlySet<string>,
  label: (vehicleId: string) => string,
): string | null {
  if (leftOut.length === 0) return null;
  const tick = [...new Set(leftOut.flatMap((l) => (l.next && refused.has(l.next) ? [l.next] : [])))].map(label);
  const untick = [...new Set(leftOut.flatMap((l) => (l.inPlace && !refused.has(l.inPlace) ? [l.inPlace] : [])))].map(label);
  const who = leftOut.length > 1 ? "qu'elles gardent" : "qu'elle garde";
  const parts = [
    ...(tick.length > 0 ? [`cochez aussi ${listing(tick)}`] : []),
    ...(untick.length > 0 ? [`décochez ${listing(untick)}`] : []),
  ];
  return parts.length > 0 ? `Pour ${who} un véhicule, ${parts.join(", ou ")}.` : null;
}

/** The refused vehicles that can be: those of a changed route whose vehicle is sent today, or that would get a new one. */
export function refusableVehicles(
  changedRoutes: ReadonlyArray<{ vehicleId: string; before: unknown | null }>,
  vehicleIds: ReadonlySet<string>,
): Set<string> {
  return new Set(changedRoutes.filter((route) => route.before === null || vehicleIds.has(route.vehicleId)).map((route) => route.vehicleId));
}
