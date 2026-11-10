/**
 * « Où placer cette course ? » (INS-01): the pure parts of the placement assistant, server side.
 *
 * The optimizer's POST /insert gives, for one trip, its best place in each vehicle's route in place
 * (contract/README.md, « InsertRequest et InsertResponse »): the routes it changes (the target, and
 * the source of a move) as /evaluate times and prices them, their figures against the plan in
 * place, the patients it delays, or why a vehicle cannot take the trip. This module:
 * - builds the request from the stored routes (routesInPlace: the stops of the trips and vehicles
 *   sent), and says which routes the web must not hand over: one under way (a stop done), one of a
 *   vehicle off the road that day (not sent), one holding a trip no longer sent (cancelled or
 *   incomplete: rewriting it would drop that trip), one saved with another crew than today's
 *   (« Véhicules à revoir »);
 * - shapes the answer for the trip panel (lib/planning/place-view.ts);
 * - plans the writes of « Appliquer »: the target and source routes only, through the pure mapping
 *   of persist.ts (stops, totals, trip results, sharing traceability), the stops that stay updated
 *   in place (their ids kept: the drivers' phones send statuses by stop id), the trip locked on its
 *   new vehicle as « Déplacer vers… » does, and the day's stored violations updated for these routes;
 * - on today's date, refuses a place whose pickup, or another patient's moved stop, is already past.
 *
 * The answer for one vehicle (`vehicleIds`) is the check of a manual move onto it: the base of the
 * drag-and-drop draft (INS-03).
 */
import type { RouteStatus, StopKind, TripStatus } from "@prisma/client";
import type { DayRequest, InsertOption, InsertRequest, InsertResponse, Violation } from "@/lib/optimizer/contract";
import {
  planRoutes,
  planTripUpdates,
  type CurrentTrip,
  type RouteRow,
  type StopRow,
  type TripUpdate,
  type VehicleCrew,
} from "@/lib/optimizer/persist";
import { formatMinute } from "@/lib/time";
import { isDrivable, routesInPlace, type TodayCrew } from "./plan-compare";
import { marginText, signedKmText, type PlaceRejectionView, type PlacesView } from "./place-view";
import { isStopDone, relevantViolations } from "./refresh-routes";

/** A route of the date as « Où placer » reads it. */
export type StoredPlaceRoute = {
  id: string;
  vehicleId: string;
  status: RouteStatus;
  driverId: string | null;
  crewMateId: string | null;
  stops: { id: string; tripId: string; kind: StopKind; sequence: number; completedAt: Date | null }[];
};

/** Why a stored route cannot be handed to the assistant (neither as source nor as target). */
export type RouteHold = "STARTED" | "UNAVAILABLE" | "OFF_REQUEST" | "CREW";

export const ROUTE_HOLD_REASONS: Record<RouteHold, string> = {
  STARTED: "a une tournée commencée, qui ne change plus en cours de journée",
  UNAVAILABLE: "est indisponible ce jour\u00a0: seule une réoptimisation de la journée refait sa tournée",
  OFF_REQUEST: "a dans sa tournée une course annulée ou incomplète (réoptimisez la journée d'abord)",
  CREW: "a une tournée prévue avec un autre équipage que celui du jour (voir «\u202fÀ traiter\u202f»)",
};

/**
 * Why the route cannot change now, or null: a stop done by the crew (or its trip picked up), a
 * vehicle off the road that day (no crew of the day: not sent), a stop of a trip the request does
 * not carry, or a crew that is no longer the vehicle's of the day.
 */
export function routeHold(
  route: Pick<StoredPlaceRoute, "vehicleId" | "driverId" | "crewMateId" | "stops">,
  sentTripIds: ReadonlySet<string>,
  statusOf: (tripId: string) => TripStatus | undefined,
  todayCrews: ReadonlyMap<string, TodayCrew>,
): RouteHold | null {
  if (route.stops.some((stop) => isStopDone(stop, statusOf(stop.tripId)))) return "STARTED";
  if (!todayCrews.has(route.vehicleId)) return "UNAVAILABLE";
  if (route.stops.some((stop) => !sentTripIds.has(stop.tripId))) return "OFF_REQUEST";
  if (!isDrivable(route, todayCrews)) return "CREW";
  return null;
}

/**
 * The request of POST /insert: the day's request, the stored routes as their stop sequences (the
 * stops of the trips and vehicles sent), the trip to place, and the vehicles to try (null: every one).
 */
export function buildInsertRequest(
  request: DayRequest,
  routes: readonly Pick<StoredPlaceRoute, "vehicleId" | "stops">[],
  tripId: string,
  vehicleIds: readonly string[] | null,
): InsertRequest {
  const { date, settings, vehicles, trips, tariffs } = request;
  return {
    date,
    settings,
    vehicles,
    trips,
    tariffs,
    routes: routesInPlace(routes, request) ?? [],
    tripId,
    vehicleIds: vehicleIds ? [...vehicleIds] : null,
  };
}

/** A pickup placed on today's date leaves the crew at least this long (to be told, and to get there). */
export const PLACE_NOW_MARGIN_MIN = 10;

/**
 * Why a place cannot be taken at `nowMinute` (minutes since midnight in Europe/Paris, today's date
 * only): the trip picked up before now plus PLACE_NOW_MARGIN_MIN, or another patient's stop moved
 * to a time already past (the optimizer times the routes from the start of the shift, unaware of
 * the hour). Null when it can; to follow the vehicle's name.
 */
export function pastPlaceReason(option: Pick<InsertOption, "pickupMin" | "shifts">, nowMinute: number): string | null {
  if (option.pickupMin < nowMinute) return `la prendrait en charge à ${formatMinute(option.pickupMin)}, heure déjà passée`;
  if (option.pickupMin < nowMinute + PLACE_NOW_MARGIN_MIN) {
    return `la prendrait en charge à ${formatMinute(option.pickupMin)}, dans moins de ${PLACE_NOW_MARGIN_MIN}\u00a0min`;
  }
  for (const shift of option.shifts) {
    const moved = [
      ...(shift.pickupShiftMin !== 0 ? [shift.pickupMin] : []),
      ...(shift.dropoffShiftMin !== 0 ? [shift.dropoffMin] : []),
    ].find((minute) => minute < nowMinute);
    if (moved !== undefined) return `décalerait un autre patient de sa tournée à une heure déjà passée (${formatMinute(moved)})`;
  }
  return null;
}

/** The largest of the two shifts of a trip (pickup, dropoff), sign kept. */
function largestShift(shift: { pickupShiftMin: number; dropoffShiftMin: number }): number {
  return Math.abs(shift.dropoffShiftMin) > Math.abs(shift.pickupShiftMin) ? shift.dropoffShiftMin : shift.pickupShiftMin;
}

/** The optimizer's answer as the trip panel shows it, with the web's own rejections (routes held). */
export function placesView(
  response: InsertResponse,
  held: readonly PlaceRejectionView[],
  version: string,
  elapsedMs: number,
): PlacesView {
  const heldIds = new Set(held.map((h) => h.vehicleId));
  return {
    tripId: response.tripId,
    fromVehicleId: response.fromVehicleId,
    version,
    options: response.options
      .filter((option) => !heldIds.has(option.vehicleId))
      .map((option) => ({
        vehicleId: option.vehicleId,
        pickupMinute: option.pickupMin,
        dropoffMinute: option.dropoffMin,
        shared: option.shared,
        coPassengerTripIds: option.coPassengerTripIds,
        deltaKm: option.deltaKm,
        deltaEmptyKm: option.deltaEmptyKm,
        deltaDurationMin: option.deltaDurationMin,
        deltaRevenue: option.deltaRevenue,
        deltaMargin: option.deltaMargin,
        shifts: option.shifts.map((shift) => ({ tripId: shift.tripId, minutes: largestShift(shift) })).filter((s) => s.minutes !== 0),
        remainingViolations: option.violations.length,
      })),
    rejected: [...response.rejected.filter((r) => !heldIds.has(r.vehicleId)), ...held],
    elapsedMs,
    straightLine: response.meta.matrixSource === "haversine",
  };
}

/**
 * How the stops of a route in place are rewritten: the stops that stay (same trip and kind) are
 * updated in place, so their ids hold (a driver's roadmap on the phone, and the statuses waiting in
 * its offline queue, name stops by id: refresh-routes.ts and detach.ts keep them too); the stops
 * that leave are deleted, those that come are created.
 */
export type StopWrites = {
  deleteIds: string[];
  updates: { id: string; data: StopRow }[];
  creates: StopRow[];
};

export function planStopWrites(stored: readonly Pick<StoredPlaceRoute["stops"][number], "id" | "tripId" | "kind">[], rows: readonly StopRow[]): StopWrites {
  const byKey = new Map(stored.map((stop) => [`${stop.tripId}:${stop.kind}`, stop.id]));
  const kept = new Set<string>();
  const updates: StopWrites["updates"] = [];
  const creates: StopRow[] = [];
  for (const row of rows) {
    const id = byKey.get(`${row.tripId}:${row.kind}`);
    if (id !== undefined && !kept.has(id)) {
      kept.add(id);
      updates.push({ id, data: row });
    } else {
      creates.push(row);
    }
  }
  return { deleteIds: stored.filter((stop) => !kept.has(stop.id)).map((stop) => stop.id), updates, creates };
}

/** What « Appliquer » writes: the routes it changes, and the results of their trips. */
export type PlaceWrite = {
  /** Rows of the target route and, for a move, of the source route; routeId null: a route to create. */
  routes: { routeId: string | null; row: RouteRow }[];
  /** Routes in place left without any stop: deleted (their trips have gone elsewhere). */
  deletedRouteIds: string[];
  /** Results of every trip of these routes (persist.ts planTripUpdates). */
  trips: TripUpdate[];
};

/**
 * The writes of an option: its routes through persist.ts's mapping (stops renumbered, address of
 * each stop, crew of a new route from `vehicles`), the source route deleted when the option left
 * it without a stop, and the results of every trip of these routes.
 */
export function planPlaceWrite(args: {
  option: Pick<InsertOption, "routes" | "trips">;
  fromVehicleId: string | null;
  stored: ReadonlyMap<string, Pick<StoredPlaceRoute, "id">>;
  vehicles: ReadonlyMap<string, VehicleCrew>;
  current: ReadonlyMap<string, CurrentTrip>;
  now: Date;
}): PlaceWrite {
  const { option, fromVehicleId, stored, vehicles, current, now } = args;
  const rows = planRoutes({ routes: option.routes }, vehicles, current);
  const source = fromVehicleId ? stored.get(fromVehicleId) : undefined;
  const sourceKept = rows.some((row) => row.vehicleId === fromVehicleId);
  return {
    routes: rows.map((row) => ({ routeId: stored.get(row.vehicleId)?.id ?? null, row })),
    deletedRouteIds: source && !sourceKept ? [source.id] : [],
    trips: planTripUpdates(
      option.trips.map((t) => t.tripId),
      { trips: option.trips },
      rows,
      current,
      now,
    ),
  };
}

/**
 * The day's stored violations once the option is saved: those of its routes, their trips and their
 * patients' total wait are replaced by the option's (what these routes still break), the others kept.
 */
export function violationsAfterPlace(
  stored: readonly Violation[],
  option: Pick<InsertOption, "routes" | "trips" | "violations">,
  fromVehicleId: string | null,
  request: Pick<DayRequest, "trips">,
): Violation[] {
  const vehicles = new Set([...option.routes.map((r) => r.vehicleId), ...(fromVehicleId ? [fromVehicleId] : [])]);
  const trips = new Set(option.trips.map((t) => t.tripId));
  const replaced = new Set(relevantViolations({ validation: { valid: false, violations: [...stored] } }, request, vehicles, trips));
  return [...stored.filter((v) => !replaced.has(v)), ...option.violations];
}

/** A route created by « Appliquer » is validated when every route of the day is (the day stays « Validé »). */
export function newRouteStatus(dayRoutes: readonly { status: RouteStatus }[]): RouteStatus {
  return dayRoutes.length > 0 && dayRoutes.every((route) => route.status === "VALIDATED") ? "VALIDATED" : "PROPOSED";
}

function listing(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} et ${items[items.length - 1]}`;
}

/**
 * The question asked before changing the routes of a validated or started day (null otherwise):
 * the drivers of these routes see their roadmap change at once.
 */
export function placeQuestion(state: { validated: boolean; started: boolean }, vehicleLabels: readonly string[]): string | null {
  if (!state.validated && !state.started) return null;
  const what = state.validated && state.started ? "Planning validé et journée commencée" : state.validated ? "Planning validé" : "Journée commencée";
  const routes = vehicleLabels.length > 1 ? `les feuilles de route de ${listing(vehicleLabels)} changent` : `la feuille de route de ${vehicleLabels[0] ?? "ce véhicule"} change`;
  return `${what}\u00a0: ${routes} dès l'enregistrement, prévenez les chauffeurs. Appliquer quand même\u202f?`;
}

/**
 * « Course de Jeanne Martin placée sur VSL 12 et figée : prise en charge 09:12, +6,2 km, marge +18 €.
 * Seules les tournées de VSL 12 et Taxi 3 ont changé. » (the figures worded as on the panel)
 */
export function placedMessage(args: {
  patient: string;
  vehicleLabel: string;
  fromLabel: string | null;
  option: Pick<InsertOption, "pickupMin" | "deltaKm" | "deltaMargin">;
}): string {
  const { patient, vehicleLabel, fromLabel, option } = args;
  const km = signedKmText(option.deltaKm);
  const margin = marginText(option.deltaMargin);
  const routes = fromLabel ? `Seules les tournées de ${vehicleLabel} et ${fromLabel} ont changé.` : `Seule la tournée de ${vehicleLabel} a changé.`;
  return `Course de ${patient} placée sur ${vehicleLabel} et figée\u00a0: prise en charge ${formatMinute(option.pickupMin)}, ${km}, ${margin}. ${routes}`;
}
