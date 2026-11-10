/**
 * What a new plan changes in the plan in place, trip by trip and route by route (INS-02): the trips
 * that change vehicle, the pickups shifted by SHIFT_NOTICE_MIN minutes or more (the patient and the
 * driver may already have been told), the trips the new plan leaves without a vehicle and those it
 * places; and, for each vehicle whose stop sequence changes, its route before and after. Computed
 * before a re-optimization is saved (run-optimization.ts), shown in the « Changements » list of the
 * plan waiting for the regulator's word, and per vehicle for « accepter véhicule par véhicule »
 * (plan-selection.ts). The drag-and-drop draft (draft.ts) lists its own side effects the same way.
 * Pure module.
 */
import type { StopKind } from "@prisma/client";
import { formatKmRounded } from "./format";
import { marginText, signedKmText } from "./place-view";

/** A pickup moved by at least this many minutes is listed: the patient and the driver may have been told the old time. */
export const SHIFT_NOTICE_MIN = 10;

/** Where a trip is served on one side of the comparison. */
export type Placement = { vehicleId: string; pickupMinute: number | null };

/** A route on one side of the comparison (stops in order, or with their sequence). */
export type RouteSide = {
  vehicleId: string;
  distanceKm: number;
  margin: number;
  stops: ReadonlyArray<{ tripId: string; kind: StopKind; sequence?: number }>;
};

/** One side of the comparison: its routes and where each trip it serves is picked up. */
export type PlanSide = { routes: readonly RouteSide[]; placements: ReadonlyMap<string, Placement> };

/**
 * vehicle: served on both sides by two vehicles; time: same vehicle, pickup shifted by
 * SHIFT_NOTICE_MIN or more; unassigned: served in place, not by the new plan; assigned: the reverse.
 */
export type ChangeKind = "unassigned" | "vehicle" | "time" | "assigned";

export type TripChange = {
  tripId: string;
  kind: ChangeKind;
  /** Vehicle in place (null: without a vehicle). */
  from: string | null;
  /** Vehicle of the new plan (null: without a vehicle). */
  to: string | null;
  fromPickup: number | null;
  toPickup: number | null;
};

/** A route's figures as the per-vehicle choice shows them. */
export type RouteSummary = { trips: number; km: number; margin: number };

/** A vehicle whose stop sequence changes (a route created or removed included). */
export type RouteChange = { vehicleId: string; before: RouteSummary | null; after: RouteSummary | null };

export type PlanChanges = { trips: TripChange[]; routes: RouteChange[] };

export const NO_CHANGES: PlanChanges = { trips: [], routes: [] };

const KIND_ORDER: Record<ChangeKind, number> = { unassigned: 0, vehicle: 1, time: 2, assigned: 3 };

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function sequenceOf(route: RouteSide): string {
  const stops = route.stops.some((s) => s.sequence !== undefined)
    ? [...route.stops].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
    : route.stops;
  return stops.map((s) => `${s.tripId}/${s.kind}`).join(" ");
}

function summaryOf(route: RouteSide): RouteSummary {
  return { trips: new Set(route.stops.map((s) => s.tripId)).size, km: round2(route.distanceKm), margin: round2(route.margin) };
}

/**
 * The changes from `before` (the plan in place) to `after` (the new plan). `considered`: the trips
 * the new plan was computed for (null: all); a trip served in place but not sent (cancelled or
 * incomplete since) is not « left without a vehicle » by the new plan, and is not listed.
 */
export function planChanges(before: PlanSide, after: PlanSide, considered: ReadonlySet<string> | null = null): PlanChanges {
  const trips: TripChange[] = [];
  const ids = new Set([...before.placements.keys(), ...after.placements.keys()]);
  for (const tripId of ids) {
    if (considered && !considered.has(tripId)) continue;
    const was = before.placements.get(tripId);
    const now = after.placements.get(tripId);
    let kind: ChangeKind | null = null;
    if (was && now) {
      if (was.vehicleId !== now.vehicleId) kind = "vehicle";
      else if (was.pickupMinute !== null && now.pickupMinute !== null && Math.abs(now.pickupMinute - was.pickupMinute) >= SHIFT_NOTICE_MIN) {
        kind = "time";
      }
    } else if (was) kind = "unassigned";
    else if (now) kind = "assigned";
    if (kind === null) continue;
    trips.push({
      tripId,
      kind,
      from: was?.vehicleId ?? null,
      to: now?.vehicleId ?? null,
      fromPickup: was?.pickupMinute ?? null,
      toPickup: now?.pickupMinute ?? null,
    });
  }
  trips.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (a.toPickup ?? a.fromPickup ?? 0) - (b.toPickup ?? b.fromPickup ?? 0) ||
      a.tripId.localeCompare(b.tripId),
  );

  const beforeBy = new Map(before.routes.filter((r) => r.stops.length > 0).map((r) => [r.vehicleId, r]));
  const afterBy = new Map(after.routes.filter((r) => r.stops.length > 0).map((r) => [r.vehicleId, r]));
  const routes: RouteChange[] = [];
  for (const vehicleId of new Set([...beforeBy.keys(), ...afterBy.keys()])) {
    const was = beforeBy.get(vehicleId);
    const now = afterBy.get(vehicleId);
    if (was && now && sequenceOf(was) === sequenceOf(now)) continue;
    routes.push({ vehicleId, before: was ? summaryOf(was) : null, after: now ? summaryOf(now) : null });
  }
  return { trips, routes };
}

/** Where each trip of a plan's routes is served, with its pickup minute (`pickupOf`: from the plan's trip results). */
export function placementsOf(
  routes: ReadonlyArray<Pick<RouteSide, "vehicleId" | "stops">>,
  pickupOf: (tripId: string) => number | null,
): Map<string, Placement> {
  const placements = new Map<string, Placement>();
  for (const route of routes) {
    for (const stop of route.stops) {
      if (stop.kind === "PICKUP" && !placements.has(stop.tripId)) {
        placements.set(stop.tripId, { vehicleId: route.vehicleId, pickupMinute: pickupOf(stop.tripId) });
      }
    }
  }
  return placements;
}

export type ChangeCounts = Record<ChangeKind, number>;

export function changeCounts(changes: Pick<PlanChanges, "trips">): ChangeCounts {
  const counts: ChangeCounts = { unassigned: 0, vehicle: 0, time: 0, assigned: 0 };
  for (const change of changes.trips) counts[change.kind] += 1;
  return counts;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

/** Title of each group of the « Changements » list. */
export const CHANGE_GROUP_TITLES: Record<ChangeKind, string> = {
  unassigned: "Resteraient sans véhicule",
  vehicle: "Changent de véhicule",
  time: `Prise en charge décalée de ${SHIFT_NOTICE_MIN}\u00a0min ou plus`,
  assigned: "Nouvellement placées",
};

/**
 * « 3 courses changent de véhicule, 2 prises en charge décalées de 10 min ou plus, 1 course resterait
 * sans véhicule, 2 courses placées » (the kinds present, most serious first); "" when none.
 */
export function changesText(counts: ChangeCounts): string {
  const parts: string[] = [];
  if (counts.unassigned > 0) {
    parts.push(plural(counts.unassigned, "course resterait sans véhicule", "courses resteraient sans véhicule"));
  }
  if (counts.vehicle > 0) parts.push(plural(counts.vehicle, "course change de véhicule", "courses changent de véhicule"));
  if (counts.time > 0) {
    parts.push(
      `${plural(counts.time, "prise en charge décalée", "prises en charge décalées")} de ${SHIFT_NOTICE_MIN}\u00a0min ou plus`,
    );
  }
  if (counts.assigned > 0) parts.push(plural(counts.assigned, "course placée", "courses placées"));
  return parts.join(", ");
}

/** The changes but those of `tripId` (a move: the trip moved is what was asked). */
export function otherChanges(changes: PlanChanges, ignored: (change: TripChange) => boolean): PlanChanges {
  return { trips: changes.trips.filter((change) => !ignored(change)), routes: changes.routes };
}

/**
 * The question of a plan held for review: « Ce calcul change 6 courses du planning en place : 3
 * changent de véhicule, … Vérifiez la liste « Changements », puis enregistrez tout, ou véhicule par
 * véhicule. » (`perVehicle`: the choice is offered).
 */
export function reviewQuestion(changes: Pick<PlanChanges, "trips">, subject: string, perVehicle: boolean): string {
  const count = changes.trips.length;
  const what = `${subject} change ${plural(count, "course", "courses")} du planning en place\u00a0: ${changesText(changeCounts(changes))}.`;
  const next = perVehicle
    ? "Vérifiez la liste «\u202fChangements\u202f», puis enregistrez tout ou véhicule par véhicule."
    : "Vérifiez la liste «\u202fChangements\u202f» avant de l'enregistrer.";
  return `${what} ${next}`;
}

/**
 * The line of a vehicle in the per-vehicle choice: « 6 → 5 courses · −12,0 km · marge +20 € »,
 * « nouvelle tournée, 3 courses · … », « tournée retirée (4 courses) ».
 */
export function routeChangeText(change: Pick<RouteChange, "before" | "after">): string {
  const { before, after } = change;
  if (!before && after) return `nouvelle tournée, ${plural(after.trips, "course", "courses")} · ${formatKmRounded(after.km)} · ${marginText(after.margin)}`;
  if (before && !after) return `tournée retirée (${plural(before.trips, "course", "courses")})`;
  if (!before || !after) return "";
  const trips = before.trips === after.trips ? plural(after.trips, "course", "courses") : `${before.trips} → ${plural(after.trips, "course", "courses")}`;
  return `${trips} · ${signedKmText(after.km - before.km)} · ${marginText(after.margin - before.margin)}`;
}

/** The trip changes that concern a vehicle (it loses or gains the trip, or the trip's time moves on it). */
export function changesOfVehicle(changes: Pick<PlanChanges, "trips">, vehicleId: string): TripChange[] {
  return changes.trips.filter((change) => change.from === vehicleId || change.to === vehicleId);
}
