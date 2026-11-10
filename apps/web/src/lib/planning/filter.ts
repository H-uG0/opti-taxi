/**
 * Filters of the planning timeline at fleet scale (120 vehicles, 6 depots):
 * depots, vehicle types, vehicle states, « masquer les libres », collapsed
 * depot groups and density. Kept in the URL (?depot=…&type=…) so that each
 * depot regulator keeps a bookmark; the KPI strip and the map follow the same
 * filter. Pure: no React, no database.
 */
import type { VehicleType } from "@prisma/client";
import { computeDayKpis as computeDashboardDayKpis, type KpiRoute, type KpiTrip } from "@/lib/kpis";
import type { DayKpis, TripView, VehicleRowView, ViolationView } from "./types";

/** route: has a route; free: available without one; off: off the road that day; issue: something to handle (« À traiter »). */
export type VehicleState = "route" | "free" | "off" | "issue";

export type PlanningFilter = {
  /** Depot ids; empty: every depot. */
  depots: string[];
  /** Empty: every type. */
  types: VehicleType[];
  /** A vehicle in any of these states; empty: every state. */
  states: VehicleState[];
  /** « Masquer les libres »: available vehicles without a route are hidden. */
  hideFree: boolean;
  /** Depot groups folded (their rows not drawn). */
  collapsed: string[];
  /** Compact density: 28 px rows on one line. */
  compact: boolean;
};

export const EMPTY_FILTER: PlanningFilter = { depots: [], types: [], states: [], hideFree: false, collapsed: [], compact: false };

/** Query parameters owned by the filter (DateNav keeps them when the date changes). */
export const FILTER_PARAMS = ["depot", "type", "etat", "masquer", "replie", "densite"] as const;

const TYPE_PARAM: Record<VehicleType, string> = { TAXI: "taxi", VSL: "vsl", AMBULANCE: "ambulance" };
const STATE_PARAM: Record<VehicleState, string> = { route: "tournee", free: "libre", off: "indisponible", issue: "a-traiter" };
const TYPE_ORDER: VehicleType[] = ["TAXI", "VSL", "AMBULANCE"];
const STATE_ORDER: VehicleState[] = ["route", "free", "off", "issue"];

export const VEHICLE_STATE_LABELS: Record<VehicleState, string> = {
  route: "Avec tournée",
  free: "Libre",
  off: "Indisponible",
  issue: "À traiter",
};

type ParamSource = URLSearchParams | Readonly<Record<string, string | string[] | undefined>>;

function read(params: ParamSource, key: string): string {
  if (params instanceof URLSearchParams) return params.get(key) ?? "";
  const value = params[key];
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/** Comma-separated tokens, deduplicated, at most 50 (a URL typed by hand cannot blow the page up). */
function list(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => /^[\w-]{1,64}$/.test(part)),
    ),
  ].slice(0, 50);
}

function decode<T extends string>(tokens: readonly string[], names: Record<T, string>, order: readonly T[]): T[] {
  const wanted = new Set(tokens.map((t) => t.toLowerCase()));
  return order.filter((value) => wanted.has(names[value]));
}

export function parseFilter(params: ParamSource): PlanningFilter {
  return {
    depots: list(read(params, "depot")),
    types: decode(list(read(params, "type")), TYPE_PARAM, TYPE_ORDER),
    states: decode(list(read(params, "etat")), STATE_PARAM, STATE_ORDER),
    hideFree: list(read(params, "masquer")).includes("libres"),
    collapsed: list(read(params, "replie")),
    compact: read(params, "densite") === "compacte",
  };
}

/** Drops the depots that do not exist (an old bookmark): a filter never hides every vehicle by mistake. */
export function sanitizeFilter(filter: PlanningFilter, depotIds: ReadonlySet<string>): PlanningFilter {
  const depots = filter.depots.filter((id) => depotIds.has(id));
  const collapsed = filter.collapsed.filter((id) => depotIds.has(id));
  return depots.length === filter.depots.length && collapsed.length === filter.collapsed.length
    ? filter
    : { ...filter, depots, collapsed };
}

/**
 * The query string of `filter`, keeping the other parameters of `current`
 * (date, trip): « ?date=2026-11-10&depot=d1,d2&type=taxi ».
 */
export function filterQuery(current: URLSearchParams, filter: PlanningFilter): string {
  const next = new URLSearchParams(current);
  for (const key of FILTER_PARAMS) next.delete(key);
  if (filter.depots.length > 0) next.set("depot", filter.depots.join(","));
  if (filter.types.length > 0) next.set("type", filter.types.map((t) => TYPE_PARAM[t]).join(","));
  if (filter.states.length > 0) next.set("etat", filter.states.map((s) => STATE_PARAM[s]).join(","));
  if (filter.hideFree) next.set("masquer", "libres");
  if (filter.collapsed.length > 0) next.set("replie", filter.collapsed.join(","));
  if (filter.compact) next.set("densite", "compacte");
  const text = next.toString();
  return text ? `?${text}` : "";
}

/** True when the filter hides vehicles (folding a group or the density does not). */
export function isFiltering(filter: PlanningFilter): boolean {
  return filter.depots.length > 0 || filter.types.length > 0 || filter.states.length > 0 || filter.hideFree;
}

/** The states of a row (a vehicle with a route on a vehicle off the road since is both « route » and « off »). */
export function vehicleStates(row: VehicleRowView, issueVehicleIds: ReadonlySet<string>): VehicleState[] {
  const states: VehicleState[] = [];
  if (row.route) states.push("route");
  else if (row.available) states.push("free");
  if (!row.available) states.push("off");
  if (issueVehicleIds.has(row.id)) states.push("issue");
  return states;
}

export function matchesFilter(row: VehicleRowView, filter: PlanningFilter, issueVehicleIds: ReadonlySet<string>): boolean {
  if (filter.depots.length > 0 && !filter.depots.includes(row.depot.id)) return false;
  if (filter.types.length > 0 && !filter.types.includes(row.type)) return false;
  const states = vehicleStates(row, issueVehicleIds);
  if (filter.hideFree && states.includes("free")) return false;
  if (filter.states.length > 0 && !filter.states.some((s) => states.includes(s))) return false;
  return true;
}

/**
 * Rows the filter keeps, in their order. `always` (the selected vehicle) stays
 * whatever the filter: a trip found by the search or opened from a link is
 * never hidden by it.
 */
export function filterRows(
  rows: readonly VehicleRowView[],
  filter: PlanningFilter,
  issueVehicleIds: ReadonlySet<string>,
  always: string | null = null,
): VehicleRowView[] {
  return rows.filter((row) => row.id === always || matchesFilter(row, filter, issueVehicleIds));
}

/**
 * Vehicles with something to handle, as « À traiter » lists them: a violation
 * of the vehicle or of one of its trips, a route planned before a change of
 * crew or vehicle (route-issues.ts), a trip to review on its route (cancelled
 * or absent but still there, locked elsewhere), a return to check, a lock
 * ignored because its vehicle cannot take the trip. Trips without a vehicle
 * are in « À traiter » too, but on no vehicle.
 */
export function issueVehicleIds(args: {
  trips: Readonly<Record<string, TripView>>;
  violations: readonly ViolationView[];
  vehicleIssues: ReadonlyArray<{ vehicleId: string }>;
  staleTrips: ReadonlyArray<{ tripId: string }>;
  returnsToCheck: readonly string[];
  droppedLocks?: ReadonlyArray<{ vehicleId: string }>;
}): Set<string> {
  const ids = new Set<string>();
  const vehicleOf = (tripId: string | null) => (tripId ? (args.trips[tripId]?.vehicleId ?? null) : null);
  for (const v of args.violations) {
    const id = v.vehicleId ?? vehicleOf(v.tripId);
    if (id) ids.add(id);
  }
  for (const issue of args.vehicleIssues) ids.add(issue.vehicleId);
  for (const stale of args.staleTrips) {
    const id = vehicleOf(stale.tripId);
    if (id) ids.add(id);
  }
  for (const tripId of args.returnsToCheck) {
    const id = vehicleOf(tripId);
    if (id) ids.add(id);
  }
  for (const dropped of args.droppedLocks ?? []) ids.add(dropped.vehicleId);
  return ids;
}

/** Trips of the row's route locked on this vehicle (« figées »). */
export function lockedTripCount(row: VehicleRowView, trips: Readonly<Record<string, TripView>>): number {
  if (!row.route) return 0;
  const ids = new Set(row.route.stops.map((s) => s.tripId));
  let count = 0;
  for (const id of ids) if (trips[id]?.lockedVehicleId === row.id) count += 1;
  return count;
}

/**
 * Indicators of a set of vehicles with the dashboard formulas (@/lib/kpis), as
 * the planning's KPI strip computes them for the whole day: trips served by
 * these vehicles, km, empty km, shared rate, money. `tripsTotal` is the trips
 * they serve (an unassigned trip belongs to no depot); `violations` those of
 * these vehicles and their trips, null when the day's violations cannot be
 * read (`violationsKnown` false: a filter never turns « ? » into « 0 »).
 */
export function subsetKpis(
  date: string,
  rows: readonly VehicleRowView[],
  trips: readonly TripView[],
  violations: readonly ViolationView[],
  violationsKnown = true,
): DayKpis {
  const routeIdOf = new Map<string, string>();
  const routes: KpiRoute[] = [];
  for (const row of rows) {
    if (!row.route) continue;
    routeIdOf.set(row.id, row.route.id);
    routes.push({
      serviceDate: date,
      vehicleId: row.id,
      distanceKm: row.route.distanceKm,
      emptyKm: row.route.emptyKm,
      revenue: row.route.revenue,
      cost: row.route.cost,
      margin: row.route.margin,
      validatedAt: row.route.validatedAt ? new Date(row.route.validatedAt) : null,
      stopCount: row.route.stops.length,
      hasRecordedStatus: row.route.stops.some((s) => s.completed),
    });
  }
  const kpiTrips: KpiTrip[] = [];
  const tripIds = new Set<string>();
  for (const trip of trips) {
    const routeId = trip.vehicleId ? routeIdOf.get(trip.vehicleId) : undefined;
    if (!routeId) continue;
    tripIds.add(trip.id);
    kpiTrips.push({
      serviceDate: date,
      status: trip.status,
      routeId,
      direction: trip.direction,
      shared: trip.shared,
      appointmentMinute: trip.appointmentMinute,
      plannedDropoffMinute: trip.plannedDropoffMinute,
      dropoffCompletedAt: null,
      exceptionalAmbulance: trip.exceptionalAmbulance === true,
    });
  }
  const day = computeDashboardDayKpis(date, { routes, trips: kpiTrips, runs: [] }, date);
  const vehicleIds = new Set(rows.map((r) => r.id));
  const ownViolations = violations.filter(
    (v) => (v.vehicleId !== null && vehicleIds.has(v.vehicleId)) || (v.vehicleId === null && v.tripId !== null && tripIds.has(v.tripId)),
  ).length;
  return {
    tripsTotal: day.servedTrips,
    tripsServed: day.servedTrips,
    vehiclesUsed: day.vehicles,
    tripsPerVehicle: day.tripsPerVehiclePlanned,
    totalKm: day.distanceKm,
    emptyKm: day.emptyKm,
    emptyKmRatio: day.emptyKmShare,
    sharedTrips: day.sharedTrips,
    sharedTripRatio: day.sharedRate,
    revenue: day.revenue,
    margin: day.margin,
    violations: violationsKnown ? ownViolations : null,
  };
}

export type DepotGroup = {
  id: string;
  label: string;
  /** Rows of the depot kept by the filter, in the view's order. */
  rows: VehicleRowView[];
  /** Every row of the depot, before the filter. */
  fleet: number;
};

/** Rows by depot, depots in alphabetical order (as on Équipages), each keeping the rows' order. */
export function groupByDepot(rows: readonly VehicleRowView[], fleetRows: readonly VehicleRowView[] = rows): DepotGroup[] {
  const groups = new Map<string, DepotGroup>();
  for (const row of fleetRows) {
    const group = groups.get(row.depot.id);
    if (group) group.fleet += 1;
    else groups.set(row.depot.id, { id: row.depot.id, label: row.depot.label, rows: [], fleet: 1 });
  }
  for (const row of rows) {
    let group = groups.get(row.depot.id);
    if (!group) {
      group = { id: row.depot.id, label: row.depot.label, rows: [], fleet: 0 };
      groups.set(row.depot.id, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()]
    .filter((g) => g.rows.length > 0)
    .sort((a, b) => a.label.localeCompare(b.label, "fr") || a.id.localeCompare(b.id));
}

/** A depot's rows kept by the filter, with its subtotals (the timeline's group header). */
export type DepotGroupView = DepotGroup & {
  totals: Pick<DayKpis, "tripsServed" | "totalKm" | "emptyKmRatio" | "margin">;
  /** Trips of the group's routes locked on their vehicle. */
  locked: number;
};

/**
 * The timeline's depot groups: the rows shown, by depot, with the subtotals of
 * those rows (trips served, km, empty share, margin; same formulas as the
 * KPI strip) and their locked trips.
 */
export function depotGroupViews(
  date: string,
  shown: readonly VehicleRowView[],
  fleet: readonly VehicleRowView[],
  trips: readonly TripView[],
  tripsById: Readonly<Record<string, TripView>>,
): DepotGroupView[] {
  return groupByDepot(shown, fleet).map((group) => {
    const kpis = subsetKpis(date, group.rows, trips, []);
    return {
      ...group,
      totals: { tripsServed: kpis.tripsServed, totalKm: kpis.totalKm, emptyKmRatio: kpis.emptyKmRatio, margin: kpis.margin },
      locked: group.rows.reduce((sum, row) => sum + lockedTripCount(row, tripsById), 0),
    };
  });
}

/** Depots of the rows, alphabetical, with their vehicle count (the depot filter's choices). */
export function depotChoices(rows: readonly VehicleRowView[]): Array<{ id: string; label: string; count: number }> {
  return groupByDepot(rows).map((g) => ({ id: g.id, label: g.label, count: g.fleet }));
}
