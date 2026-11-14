/**
 * Breakdowns of the dashboard by depot, vehicle type, vehicle and person
 * (KPI-02), and the unit economics they share with the « Économie » tab
 * (KPI-10). Pure.
 *
 * One line per route with stops: its vehicle (type and depot), its crew, the
 * trips placed on it, its km, its money and its planned time. A group (a
 * depot, a type, a vehicle, a person) sums its lines, and every rate is
 * computed from the sums, like the dashboard's. A person counts the routes
 * they drove or crewed. The vehicle-days of the fleet (available,
 * unavailable, without a crew) come from the crews of each day
 * (kpis-fleet.ts), with today's depot and type of each vehicle.
 */
import type { VehicleType } from "@prisma/client";
import { isSharingEligible } from "@/lib/domain/rules";
import { arrivalDelayMinutes } from "./kpis";
import {
  DEFAULT_KPI_OPTIONS,
  isLyingTrip,
  isRealizedTrip,
  isServedTrip,
  isTapType,
  isUsedRoute,
  ratio,
  type KpiData,
  type KpiFleetDay,
  type KpiFrozenPlan,
  type KpiOptions,
} from "./kpis-rows";

export type RouteLine = {
  date: string;
  routeId: string | null;
  vehicleId: string;
  vehicleType: VehicleType | null;
  depotId: string | null;
  driverId: string | null;
  crewMateId: string | null;
  /** The day is over (before `today`): what the crews recorded can be read. */
  finished: boolean;
  /** Served trips (in the route, not cancelled nor absent). */
  trips: number;
  sharedTrips: number;
  /** Served CPAM seated trips in a taxi or a VSL whose prescription allows sharing, and those shared. */
  eligible: number;
  eligibleShared: number;
  noShows: number;
  /** Served trips dropped off. */
  realized: number;
  /** On a finished day: trips placed on the route (served or absent), and those whose crew recorded the outcome. */
  placedFinished: number;
  recorded: number;
  distanceKm: number;
  emptyKm: number;
  /** Estimated revenue of the served trips (absent patients out), euros. */
  revenue: number;
  /** Cost of the route (optimizer: km × cost per km + hours × hourly cost). */
  cost: number;
  /** Km part of the cost at the vehicle's cost per km (null: unknown). */
  kmCost: number | null;
  /** Planned minutes (break out), with a patient on board, waiting at a place of care (0 when unknown). */
  activeMinutes: number;
  /** Minutes charged at the hourly cost by the optimizer (break included, 0 when unknown). */
  paidMinutes: number;
  onboardMinutes: number;
  facilityWaitMinutes: number;
  /** The route's planned times are known. */
  timed: boolean;
  /** Outbound trips dropped off with a recorded time, and those late beyond the tolerance. */
  measuredOutbound: number;
  lateArrivals: number;
};

/**
 * The lines of every route with stops in `data`. `costPerKmOf` gives a
 * vehicle's cost per km (the km part of the route cost), `today` decides
 * which days are finished.
 */
export function routeLines(
  data: Pick<KpiData, "routes" | "trips">,
  today: string,
  options: KpiOptions = DEFAULT_KPI_OPTIONS,
  costPerKmOf: (vehicleId: string) => number | undefined = () => undefined,
): RouteLine[] {
  const lines: RouteLine[] = [];
  const byRoute = new Map<string, RouteLine>();
  for (const route of data.routes) {
    if (!isUsedRoute(route)) continue;
    const perKm = costPerKmOf(route.vehicleId);
    const line: RouteLine = {
      date: route.serviceDate,
      routeId: route.id ?? null,
      vehicleId: route.vehicleId,
      vehicleType: route.vehicleType ?? null,
      depotId: route.depotId ?? null,
      driverId: route.driverId ?? null,
      crewMateId: route.crewMateId ?? null,
      finished: route.serviceDate < today,
      trips: 0,
      sharedTrips: 0,
      eligible: 0,
      eligibleShared: 0,
      noShows: 0,
      realized: 0,
      placedFinished: 0,
      recorded: 0,
      distanceKm: route.distanceKm,
      emptyKm: route.emptyKm,
      revenue: 0,
      cost: route.cost,
      kmCost: perKm === undefined ? null : route.distanceKm * perKm,
      activeMinutes: route.activeMinutes ?? 0,
      paidMinutes: route.paidMinutes ?? route.activeMinutes ?? 0,
      onboardMinutes: route.onboardMinutes ?? 0,
      facilityWaitMinutes: route.facilityWaitMinutes ?? 0,
      timed: route.activeMinutes !== undefined,
      measuredOutbound: 0,
      lateArrivals: 0,
    };
    lines.push(line);
    if (route.id) byRoute.set(`${route.serviceDate}|${route.id}`, line);
  }
  for (const trip of data.trips) {
    if (trip.routeId === null) continue;
    const line = byRoute.get(`${trip.serviceDate}|${trip.routeId}`);
    if (!line) continue;
    if (trip.status === "NO_SHOW") {
      line.noShows += 1;
      if (line.finished) {
        line.placedFinished += 1;
        line.recorded += 1;
      }
      continue;
    }
    if (!isServedTrip(trip)) continue;
    line.trips += 1;
    if (trip.shared) line.sharedTrips += 1;
    if (typeof trip.estimatedRevenue === "number" && Number.isFinite(trip.estimatedRevenue)) line.revenue += trip.estimatedRevenue;
    if (!isLyingTrip(trip) && isTapType(line.vehicleType) && isSharingEligible(trip)) {
      line.eligible += 1;
      if (trip.shared) line.eligibleShared += 1;
    }
    const realized = isRealizedTrip(trip);
    if (realized) line.realized += 1;
    if (line.finished) {
      line.placedFinished += 1;
      if (realized) line.recorded += 1;
    }
    const delay = realized ? arrivalDelayMinutes(trip) : null;
    if (delay !== null) {
      line.measuredOutbound += 1;
      if (delay > options.lateToleranceMin) line.lateArrivals += 1;
    }
  }
  return lines;
}

/** Sums of a group of lines. */
export type LineTotals = {
  /** Routes, i.e. vehicle-days used (one route per vehicle and date). */
  vehicleDays: number;
  /** Distinct dates and vehicles. */
  days: number;
  vehicles: number;
  trips: number;
  sharedTrips: number;
  eligible: number;
  eligibleShared: number;
  noShows: number;
  realized: number;
  placedFinished: number;
  recorded: number;
  distanceKm: number;
  emptyKm: number;
  revenue: number;
  cost: number;
  /** Km part of the cost, over the lines whose vehicle's cost per km is known, and their km. */
  kmCost: number;
  kmCostKm: number;
  /** Over the timed routes only. */
  activeMinutes: number;
  paidMinutes: number;
  onboardMinutes: number;
  facilityWaitMinutes: number;
  timedRoutes: number;
  /** Cost of the timed routes (the hourly cost reads the same routes as their minutes). */
  timedCost: number;
  timedKmCost: number;
  measuredOutbound: number;
  lateArrivals: number;
};

export function sumLines(lines: readonly RouteLine[]): LineTotals {
  const dates = new Set<string>();
  const vehicles = new Set<string>();
  const t: LineTotals = {
    vehicleDays: lines.length,
    days: 0,
    vehicles: 0,
    trips: 0,
    sharedTrips: 0,
    eligible: 0,
    eligibleShared: 0,
    noShows: 0,
    realized: 0,
    placedFinished: 0,
    recorded: 0,
    distanceKm: 0,
    emptyKm: 0,
    revenue: 0,
    cost: 0,
    kmCost: 0,
    kmCostKm: 0,
    activeMinutes: 0,
    paidMinutes: 0,
    onboardMinutes: 0,
    facilityWaitMinutes: 0,
    timedRoutes: 0,
    timedCost: 0,
    timedKmCost: 0,
    measuredOutbound: 0,
    lateArrivals: 0,
  };
  for (const line of lines) {
    dates.add(line.date);
    vehicles.add(line.vehicleId);
    t.trips += line.trips;
    t.sharedTrips += line.sharedTrips;
    t.eligible += line.eligible;
    t.eligibleShared += line.eligibleShared;
    t.noShows += line.noShows;
    t.realized += line.realized;
    t.placedFinished += line.placedFinished;
    t.recorded += line.recorded;
    t.distanceKm += line.distanceKm;
    t.emptyKm += line.emptyKm;
    t.revenue += line.revenue;
    t.cost += line.cost;
    if (line.kmCost !== null) {
      t.kmCost += line.kmCost;
      t.kmCostKm += line.distanceKm;
    }
    if (line.timed) {
      t.timedRoutes += 1;
      t.activeMinutes += line.activeMinutes;
      t.paidMinutes += line.paidMinutes;
      t.onboardMinutes += line.onboardMinutes;
      t.facilityWaitMinutes += line.facilityWaitMinutes;
      t.timedCost += line.cost;
      t.timedKmCost += line.kmCost ?? 0;
    }
    t.measuredOutbound += line.measuredOutbound;
    t.lateArrivals += line.lateArrivals;
  }
  t.days = dates.size;
  t.vehicles = vehicles.size;
  return t;
}

/**
 * Lines grouped by key: `keysOf` gives the groups of a line (a person drives
 * or crews: two keys; none: the line is in no group).
 */
export function groupLines(lines: readonly RouteLine[], keysOf: (line: RouteLine) => readonly (string | null)[]): Map<string, LineTotals> {
  const grouped = new Map<string, RouteLine[]>();
  for (const line of lines) {
    for (const key of new Set(keysOf(line))) {
      if (key === null) continue;
      const list = grouped.get(key);
      if (list) list.push(line);
      else grouped.set(key, [line]);
    }
  }
  return new Map([...grouped].map(([key, list]) => [key, sumLines(list)]));
}

/** The people of a route: its driver and its crew mate. */
export function crewOf(line: Pick<RouteLine, "driverId" | "crewMateId">): (string | null)[] {
  return [line.driverId, line.crewMateId];
}

/** Rates of a group, the dashboard's formulas on its sums. */
export type LineRates = {
  tripsPerVehicleDay: number | null;
  emptyKmShare: number | null;
  sharedRate: number | null;
  lateRate: number | null;
  margin: number;
  marginPerTrip: number | null;
  revenuePerVehicleDay: number | null;
  revenuePerKm: number | null;
  /** Total cost of the routes per km driven. */
  costPerKm: number | null;
  /**
   * Hourly part of the cost (cost - km part) per hour charged, over the timed
   * routes whose km cost is known: the optimizer charges the whole route, its
   * break included, so this reads the configured hourly cost when nothing changed.
   */
  hourlyCost: number | null;
  /** Total cost per hour charged (break included). */
  costPerHour: number | null;
  /** Minutes with a patient on board ÷ planned minutes. */
  occupancy: number | null;
  /** Trips whose outcome the crew recorded ÷ trips placed, finished days. */
  recordingRate: number | null;
  /** Planned hours, breaks out; and the hours charged, breaks in. */
  plannedHours: number;
  paidHours: number;
  /** Minutes waited at places of care per vehicle-day. */
  facilityWaitPerVehicleDay: number | null;
};

export function lineRates(t: LineTotals): LineRates {
  const hours = t.activeMinutes / 60;
  const paidHours = t.paidMinutes / 60;
  const kmPartKnown = t.timedRoutes > 0 && t.kmCostKm > 0;
  return {
    tripsPerVehicleDay: ratio(t.trips, t.vehicleDays),
    emptyKmShare: ratio(t.emptyKm, t.distanceKm),
    sharedRate: ratio(t.eligibleShared, t.eligible),
    lateRate: ratio(t.lateArrivals, t.measuredOutbound),
    margin: t.revenue - t.cost,
    marginPerTrip: ratio(t.revenue - t.cost, t.trips),
    revenuePerVehicleDay: ratio(t.revenue, t.vehicleDays),
    revenuePerKm: ratio(t.revenue, t.distanceKm),
    costPerKm: ratio(t.cost, t.distanceKm),
    hourlyCost: kmPartKnown ? ratio(Math.max(0, t.timedCost - t.timedKmCost), paidHours) : null,
    costPerHour: ratio(t.timedCost, paidHours),
    occupancy: ratio(t.onboardMinutes, t.activeMinutes),
    recordingRate: ratio(t.recorded, t.placedFinished),
    plannedHours: hours,
    paidHours,
    facilityWaitPerVehicleDay: ratio(t.facilityWaitMinutes, t.timedRoutes),
  };
}

/** Vehicle-days of a group: used, available (used or idle), unavailable, without a crew. */
export type FleetDays = { used: number; available: number; unavailable: number; crewless: number };

/**
 * The vehicle-days of each group from the fleet of each day: a vehicle with
 * a route that day is used (and available whatever the crews say now), else
 * unavailable, without a crew, or available and left idle. `keyOf` gives the
 * group of a vehicle (null: none).
 */
export function fleetDaysBy(
  fleet: readonly KpiFleetDay[],
  usedOn: (date: string) => ReadonlySet<string>,
  keyOf: (vehicleId: string) => string | null,
): Map<string, FleetDays> {
  const result = new Map<string, FleetDays>();
  const entry = (key: string) => {
    let value = result.get(key);
    if (!value) {
      value = { used: 0, available: 0, unavailable: 0, crewless: 0 };
      result.set(key, value);
    }
    return value;
  };
  for (const day of fleet) {
    const used = usedOn(day.serviceDate);
    const unavailable = new Set(day.unavailable);
    const crewless = new Set(day.crewless);
    for (const vehicleId of new Set([...day.active, ...used])) {
      const key = keyOf(vehicleId);
      if (key === null) continue;
      const counts = entry(key);
      if (used.has(vehicleId)) {
        counts.used += 1;
        counts.available += 1;
      } else if (unavailable.has(vehicleId)) counts.unavailable += 1;
      else if (crewless.has(vehicleId)) counts.crewless += 1;
      else counts.available += 1;
    }
  }
  return result;
}

/** Vehicles used each date (a route with stops), for fleetDaysBy. */
export function usedVehiclesByDate(lines: readonly RouteLine[]): (date: string) => ReadonlySet<string> {
  const byDate = new Map<string, Set<string>>();
  for (const line of lines) {
    const set = byDate.get(line.date);
    if (set) set.add(line.vehicleId);
    else byDate.set(line.date, new Set([line.vehicleId]));
  }
  const none = new Set<string>();
  return (date) => byDate.get(date) ?? none;
}

/**
 * The plan of each group: trips and vehicles of the frozen validated plans of
 * the days started (their vehicle lines, frozen with their type and depot),
 * and of the current routes of the days to come or without a frozen plan
 * (kpis-compare.ts planViewOf reads a day the same way).
 */
export function plannedBy(
  dates: readonly string[],
  plans: readonly KpiFrozenPlan[],
  lines: readonly RouteLine[],
  today: string,
  keyOf: (line: { vehicleId: string; vehicleType: VehicleType | null; depotId: string | null }) => string | null,
): Map<string, { trips: number; vehicles: number }> {
  const frozen = new Map(plans.map((plan) => [plan.serviceDate, plan]));
  const linesOf = new Map<string, RouteLine[]>();
  for (const line of lines) {
    const list = linesOf.get(line.date);
    if (list) list.push(line);
    else linesOf.set(line.date, [line]);
  }
  const result = new Map<string, { trips: number; vehicles: number }>();
  const add = (key: string | null, trips: number) => {
    if (key === null) return;
    const value = result.get(key) ?? { trips: 0, vehicles: 0 };
    value.trips += trips;
    value.vehicles += 1;
    result.set(key, value);
  };
  for (const date of dates) {
    const plan = date <= today ? frozen.get(date) : undefined;
    if (plan) for (const line of plan.figures.byVehicle) add(keyOf(line), line.trips);
    else for (const line of linesOf.get(date) ?? []) add(keyOf(line), line.trips);
  }
  return result;
}
