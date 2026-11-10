/**
 * The drag-and-drop draft of the timeline (INS-03): trips dropped on another vehicle's row, or on
 * « À placer », kept as a list of moves (trip → vehicle, or null: without a vehicle) that nothing
 * saves yet. The server checks the whole list on the plan of the moment, move after move (each drop
 * on a vehicle is the optimizer's /insert for that vehicle alone, lib/planning/draft-plan.ts), and
 * gives back the routes it changes; « Enregistrer » writes them at once. This module holds the pure
 * parts shared by the server and the board: the list itself, the stop sequences as the moves edit
 * them, and the board's rows and trips with the draft applied. Pure module.
 */
import type { StopKind, TripStatus } from "@prisma/client";
import type { PlanFigures } from "./plan-compare";
import type { RouteView, StopView, TripView, VehicleRowView } from "./types";

/** One drop: the trip goes to `toVehicleId`, or to « À placer » (null). */
export type DraftMove = { tripId: string; toVehicleId: string | null };

/** A draft holds at most this many moves (each check replays them all on the optimizer). */
export const DRAFT_MAX_MOVES = 20;

/**
 * The moves once `move` is added: an earlier move of the same trip gives way to it (the trip's last
 * drop counts), and a drop back where the plan in place has the trip (`homeOf`) cancels its move.
 */
export function addDraftMove(moves: readonly DraftMove[], move: DraftMove, homeOf: (tripId: string) => string | null): DraftMove[] {
  const others = moves.filter((m) => m.tripId !== move.tripId);
  return homeOf(move.tripId) === move.toVehicleId ? others : [...others, move];
}

export function removeDraftMove(moves: readonly DraftMove[], tripId: string): DraftMove[] {
  return moves.filter((m) => m.tripId !== tripId);
}

/** « 1 modification non enregistrée », « 3 modifications non enregistrées ». */
export function draftCountText(count: number): string {
  return count > 1 ? `${count} modifications non enregistrées` : `${count} modification non enregistrée`;
}

/** Reads the moves kept for a date (sessionStorage): anything malformed reads as none. */
export function parseStoredMoves(raw: string | null): DraftMove[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (m): m is DraftMove =>
          typeof m === "object" &&
          m !== null &&
          typeof (m as DraftMove).tripId === "string" &&
          ((m as DraftMove).toVehicleId === null || typeof (m as DraftMove).toVehicleId === "string"),
      )
      .map((m) => ({ tripId: m.tripId, toVehicleId: m.toVehicleId }))
      .slice(0, DRAFT_MAX_MOVES);
  } catch {
    return [];
  }
}

export const draftStorageKey = (date: string) => `opti-taxi:brouillon:${date}`;

// ---------------------------------------------------------------------------
// Stop sequences as the moves edit them (server)
// ---------------------------------------------------------------------------

export type DraftSequence = { vehicleId: string; stops: { tripId: string; kind: StopKind }[] };

/** The vehicle whose route holds the trip, or null. */
export function vehicleOfTrip(routes: readonly DraftSequence[], tripId: string): string | null {
  return routes.find((route) => route.stops.some((stop) => stop.tripId === tripId))?.vehicleId ?? null;
}

/** The routes without the trip's stops (the others keep their order); a route left empty goes. */
export function withoutTrip(routes: readonly DraftSequence[], tripId: string): DraftSequence[] {
  return routes
    .map((route) => ({ vehicleId: route.vehicleId, stops: route.stops.filter((stop) => stop.tripId !== tripId) }))
    .filter((route) => route.stops.length > 0);
}

/**
 * The routes once an /insert option is taken: its routes replace the target's and, for a move, the
 * source's (absent from the option when it has no stop left: the source goes).
 */
export function withOptionRoutes(
  routes: readonly DraftSequence[],
  option: { routes: ReadonlyArray<{ vehicleId: string; stops: ReadonlyArray<{ tripId: string; kind: StopKind }> }> },
  fromVehicleId: string | null,
): DraftSequence[] {
  const replaced = new Map(
    option.routes.map((route) => [route.vehicleId, route.stops.map(({ tripId, kind }) => ({ tripId, kind }))] as const),
  );
  const result: DraftSequence[] = [];
  for (const route of routes) {
    if (replaced.has(route.vehicleId)) {
      result.push({ vehicleId: route.vehicleId, stops: replaced.get(route.vehicleId) ?? [] });
      replaced.delete(route.vehicleId);
    } else if (route.vehicleId !== fromVehicleId) {
      result.push(route);
    }
  }
  for (const [vehicleId, stops] of replaced) result.push({ vehicleId, stops });
  return result.filter((route) => route.stops.length > 0);
}

/** Vehicles whose stop sequence differs between two states (a route created or emptied included). */
export function changedVehicles(before: readonly DraftSequence[], after: readonly DraftSequence[]): Set<string> {
  const key = (route: DraftSequence | undefined) => route?.stops.map((s) => `${s.tripId}/${s.kind}`).join(" ") ?? "";
  const was = new Map(before.map((route) => [route.vehicleId, route]));
  const now = new Map(after.map((route) => [route.vehicleId, route]));
  const changed = new Set<string>();
  for (const vehicleId of new Set([...was.keys(), ...now.keys()])) {
    if (key(was.get(vehicleId)) !== key(now.get(vehicleId))) changed.add(vehicleId);
  }
  return changed;
}

// ---------------------------------------------------------------------------
// What the server answers, and the board with the draft applied (client)
// ---------------------------------------------------------------------------

/** A move as checked: placed (its times and what it changes) or refused (why). */
export type DraftMoveResult = DraftMove & { fromVehicleId: string | null } & (
    | { ok: true; pickupMinute: number | null; dropoffMinute: number | null; deltaKm: number | null; deltaMargin: number | null }
    | { ok: false; reason: string }
  );

/** A changed route as the timeline draws it (times from /evaluate). */
export type DraftRoute = Pick<
  RouteView,
  "startMinute" | "endMinute" | "distanceKm" | "emptyKm" | "revenue" | "cost" | "margin" | "breakStartMinute" | "breakEndMinute"
> & {
  stops: Pick<StopView, "tripId" | "kind" | "lat" | "lng" | "arrivalMinute" | "startMinute" | "departureMinute" | "loadAfter">[];
};

/** A trip's results in the draft: on a changed route, or taken out of one. */
export type DraftTrip = {
  tripId: string;
  vehicleId: string | null;
  pickupMinute: number | null;
  dropoffMinute: number | null;
  shared: boolean;
  coPassengerTripIds: string[];
  estimatedRevenue: number | null;
  detourKm: number | null;
};

export type DraftView = {
  /** Plan version the draft was checked on. */
  version: string;
  moves: DraftMoveResult[];
  /** The routes the draft changes (null: the vehicle has no route left). */
  routes: { vehicleId: string; route: DraftRoute | null }[];
  trips: DraftTrip[];
  /** The day's figures in place and with the draft, both re-checked by /evaluate. */
  before: PlanFigures;
  after: PlanFigures;
  /** Violations the draft day has that the plan in place has not (codes, trips and vehicles by id). */
  newViolations: { code: string; message: string; tripId: string | null; vehicleId: string | null }[];
  /** Other patients whose pickup the draft moves by 10 min or more (lib/planning/plan-changes.ts). */
  shifted: { tripId: string; vehicleId: string; fromPickupMinute: number; toPickupMinute: number }[];
  /** Asked before saving on a validated or started day (null otherwise). */
  question: string | null;
};

/** The timeline's rows with the draft's routes (a route created takes the row's crew; one emptied goes). */
export function rowsWithDraft(rows: readonly VehicleRowView[], draft: Pick<DraftView, "routes"> | null, addressOf: (tripId: string, kind: StopKind) => string): VehicleRowView[] {
  if (!draft || draft.routes.length === 0) return [...rows];
  const changed = new Map(draft.routes.map((r) => [r.vehicleId, r.route]));
  return rows.map((row) => {
    if (!changed.has(row.id)) return row;
    const route = changed.get(row.id) ?? null;
    if (!route) return { ...row, route: null };
    const stops: StopView[] = route.stops.map((stop, sequence) => ({
      ...stop,
      id: `brouillon-${row.id}-${sequence}`,
      sequence,
      address: addressOf(stop.tripId, stop.kind),
      completed: false,
    }));
    const base: RouteView = row.route ?? {
      id: `brouillon-${row.id}`,
      status: "PROPOSED",
      validatedAt: null,
      driverId: null,
      crewMateId: null,
      remaining: null,
      ...route,
      tripCount: 0,
      stops: [],
    };
    return {
      ...row,
      route: { ...base, ...route, stops, tripCount: new Set(stops.map((s) => s.tripId)).size, remaining: { start: route.startMinute, end: route.endMinute } },
    };
  });
}

/** The trips with their draft results: vehicle, planned times, co-passengers, revenue. */
export function tripsWithDraft(
  trips: Readonly<Record<string, TripView>>,
  draft: Pick<DraftView, "trips"> | null,
): Record<string, TripView> {
  if (!draft || draft.trips.length === 0) return { ...trips };
  const result: Record<string, TripView> = { ...trips };
  for (const t of draft.trips) {
    const trip = trips[t.tripId];
    if (!trip) continue;
    result[t.tripId] = {
      ...trip,
      vehicleId: t.vehicleId,
      plannedPickupMinute: t.pickupMinute,
      plannedDropoffMinute: t.dropoffMinute,
      shared: t.shared,
      coPassengerTripIds: t.coPassengerTripIds,
      estimatedRevenue: t.estimatedRevenue,
      detourKm: t.detourKm,
    };
  }
  return result;
}

const ACTIVE_STATUSES: readonly TripStatus[] = ["PLANNED", "ASSIGNED"];

/**
 * Why a trip of the timeline cannot be dragged (null: it can): cancelled, under way or done, an
 * exceptional ambulance (« Défiger » first), or on a route the crew has started.
 */
export function dragIssue(trip: Pick<TripView, "status" | "exceptionalAmbulance" | "vehicleId">, routeStarted: boolean): string | null {
  if (!ACTIVE_STATUSES.includes(trip.status)) return "Course annulée, commencée ou terminée.";
  if (trip.exceptionalAmbulance) return "Recours exceptionnel à une ambulance\u00a0: «\u202fDéfiger\u202f» d'abord.";
  if (routeStarted) return "Tournée commencée\u00a0: elle ne change plus en cours de journée.";
  return null;
}

/**
 * Why a trip cannot be dropped on a row (null: it can): the same row, a vehicle off the road or of a
 * type the prescription does not allow, a route the crew has started. The server checks again.
 */
export function dropIssue(
  trip: Pick<TripView, "vehicleId" | "allowedVehicleTypes">,
  row: Pick<VehicleRowView, "id" | "label" | "type" | "available"> & { started: boolean } | null,
): string | null {
  if (row === null) return trip.vehicleId === null ? "Déjà à placer." : null;
  if (row.id === trip.vehicleId) return "Déjà sur ce véhicule.";
  if (!row.available) return `${row.label} est indisponible ce jour.`;
  if (!trip.allowedVehicleTypes.includes(row.type)) return `Véhicule non autorisé par la prescription.`;
  if (row.started) return `${row.label} a une tournée commencée.`;
  return null;
}
