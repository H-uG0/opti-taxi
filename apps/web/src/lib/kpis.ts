/**
 * Dashboard indicators (MVP item 7, and the indicators added for the
 * manager: demand and service, fleet use, shared transport as the Assurance
 * maladie counts it, waits and punctuality, planned / served / done).
 *
 * Pure module: it works on plain rows loaded by the dashboard page
 * (@/lib/kpis-load), never touches the database, and is unit-tested with
 * vitest. Every rate is a fraction (0.23 = 23 %) computed from sums, and is
 * null when its denominator is zero (displayed as "—"), never NaN or
 * Infinity. The parts live in kpis-demand, kpis-fleet, kpis-sharing,
 * kpis-waits and kpis-plan; the input rows in kpis-rows.
 */
import type { VehicleType } from "@prisma/client";
import { addDays, formatShortDate, fromIsoDate, isIsoDate } from "@/lib/time";
import { addDemand, demandOfDay, emptyDemand, serviceRate, type DemandTotals } from "./kpis-demand";
import { addFleet, fleetOfDay, fleetUseRate, type FleetTotals } from "./kpis-fleet";
import {
  DEFAULT_KPI_OPTIONS,
  isRealizedTrip,
  isServedTrip,
  isUsedRoute,
  minuteOfServiceDay,
  ratio,
  type KpiData,
  type KpiFleetDay,
  type KpiFrozenPlan,
  type KpiOptions,
  type KpiRoute,
  type KpiRun,
  type KpiTrip,
} from "./kpis-rows";
import { addSharing, eligibleSharedRate, emptySharing, measuredSharedRate, sharingOfDay, type SharingTotals } from "./kpis-sharing";
import { addWaits, emptyWaits, waitsOfDay, type WaitTotals } from "./kpis-waits";

export {
  DEFAULT_KPI_OPTIONS,
  isRealizedTrip,
  isServedTrip,
  isUsedRoute,
  minuteOfServiceDay,
  quantile,
  ratio,
  SERVED_TRIP_STATUSES,
  type KpiData,
  type KpiFleetDay,
  type KpiFrozenPlan,
  type KpiOptions,
  type KpiRoute,
  type KpiRun,
  type KpiTrip,
} from "./kpis-rows";

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * Additive counters: summing them over several days gives the period's
 * counters, except realizedTrips and realizedVehicles, which a period summary
 * takes from finished days only (see summarizePeriod).
 */
export type KpiTotals = {
  /** Vehicles with a route that still has stops. */
  vehicles: number;
  /**
   * Of those, vehicles whose crew recorded at least one stop status, on a day
   * that has started: denominator of the realized rate. A crew that never
   * used the roadmap tells nothing about what was done (not "0 trips").
   */
  realizedVehicles: number;
  /** Trips in a route, status ASSIGNED, PICKED_UP or DROPPED_OFF. */
  servedTrips: number;
  /** Served trips with status DROPPED_OFF. */
  realizedTrips: number;
  distanceKm: number;
  emptyKm: number;
  /** Served trips with another patient on board in the plan (every vehicle type and payer). */
  sharedTrips: number;
  /** Realized (DROPPED_OFF) outbound trips that have an appointment time. */
  realizedOutbound: number;
  /** Of which the driver recorded the drop-off time: the lateness can be measured. */
  measuredOutbound: number;
  /** Measured outbound trips dropped off more than the tolerance after the appointment (KpiOptions.lateToleranceMin). */
  lateArrivals: number;
  /** Measured outbound trips dropped off more than 5 and more than 15 minutes after the appointment. */
  lateOver5: number;
  lateOver15: number;
  /** Largest delay among the measured outbound trips dropped off after the appointment, in minutes. */
  maxDelayMinutes: number | null;
  /** Served outbound trips with both an appointment and a planned drop-off. */
  plannedOutbound: number;
  /** Of which the plan starts the drop-off less than KpiOptions.tightMarginMin before the appointment. */
  tightOutbound: number;
  optimizationRuns: number;
  /** Served seated trips carried by an ambulance as an exceptional measure (protocol of 24 September 2025). */
  exceptionalAmbulanceTrips: number;
  /** Money of the routes (optimizer, last plan or recomputation): an absent patient's trip still counts in it. */
  revenue: number;
  cost: number;
  margin: number;
  /** Estimated revenue of the served trips (trip by trip: an absent patient's trip is no longer in it). */
  servedRevenue: number;
  /** Of which the trips dropped off. */
  realizedRevenue: number;
  /** Estimated revenue of the trips whose patient was absent (not billed). */
  noShowRevenue: number;
};

export type KpiRates = {
  /** 1. Courses facturées par véhicule et par jour (plan). */
  tripsPerVehiclePlanned: number | null;
  /**
   * 1. Same, counting realized (dropped-off) trips over the vehicles whose
   * crew recorded a status; null before the day has started or when no
   * status was recorded.
   */
  tripsPerVehicleRealized: number | null;
  /** 2. Part des km à vide. */
  emptyKmShare: number | null;
  /** 3. Shared rate as the Assurance maladie counts it: eligible CPAM trips in a taxi or a VSL, planned. */
  eligibleSharedRate: number | null;
  /** Same, measured from the crews' timestamps on the eligible trips dropped off. */
  measuredSharedRate: number | null;
  /** 4. Share of measured outbound trips that arrived after the appointment plus the tolerance. */
  lateRate: number | null;
  /** Share of the planned outbound trips planned less than the margin before the appointment. */
  tightRate: number | null;
  /** Placed ÷ to carry (kpis-demand.ts). */
  serviceRate: number | null;
  /** Served trips per vehicle available (kpis-fleet.ts). */
  tripsPerAvailableVehicle: number | null;
  /** Used ÷ available vehicles. */
  useRate: number | null;
  /** (Served revenue − cost of the routes) ÷ served trips. */
  marginPerTrip: number | null;
};

/**
 * NONE: no optimization and no route; NOT_VALIDATED: work started but some
 * route is not validated; VALIDATED: every route of the day is validated.
 */
export type PlanningStatus = "NONE" | "NOT_VALIDATED" | "VALIDATED";

/** The parts of the indicators that are not flat counters. */
export type KpiParts = {
  demand: DemandTotals;
  /** Null when the fleet of the day is unknown (rows without it). */
  fleet: FleetTotals | null;
  sharing: SharingTotals;
  waits: WaitTotals;
};

/** What a day and a period have in common: counters, rates and parts. */
export type KpiSummary = KpiTotals & KpiRates & KpiParts;

export type DayKpis = KpiTotals &
  KpiRates &
  KpiParts & {
    date: string;
    /** Day after `today`: nothing can have been realized yet. */
    upcoming: boolean;
    /** The day is `today`: its realized values are still partial. */
    inProgress: boolean;
    planningStatus: PlanningStatus;
    /** First optimization run started for the date. */
    firstRunAt: Date | null;
    /** Latest route validation, when the whole day is validated. */
    validatedAt: Date | null;
    /** 5. Temps passé à construire le planning: first run -> last validation, in minutes. */
    planningMinutes: number | null;
    /** Distance sources of the day's routes, sorted (km and planned delays compare only within one). */
    matrixSources: string[];
    /**
     * The day was produced by the history simulation (pnpm db:history): its
     * lateness and planning time are parameters of the simulation, not measurements.
     */
    simulated: boolean;
    /** The validated plan, frozen at its validation (kpis-plan.ts); null when there is none. */
    frozen: KpiFrozenPlan | null;
  };

export type PeriodKpis = KpiTotals &
  KpiRates &
  KpiParts & {
    from: string;
    to: string;
    days: number;
    /**
     * Day in progress (today) when the period contains it: it is left out of
     * realizedTrips and realizedVehicles, whose drop-offs are still being
     * recorded while all its vehicles would already count.
     */
    inProgressDate: string | null;
    /** Days with at least one route. */
    plannedDays: number;
    validatedDays: number;
    /** Validated days whose planning time could be measured. */
    measuredPlanningDays: number;
    averagePlanningMinutes: number | null;
    /** Distance sources of the period's routes, sorted: more than one, its days do not compare. */
    matrixSources: string[];
    /** Days produced by the history simulation. */
    simulatedDays: number;
  };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** Inclusive list of "YYYY-MM-DD" dates from `from` to `to` (empty when from > to). */
export function listDates(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) dates.push(day);
  return dates;
}

/** Number of days from `from` to `to`, both included. */
export function dayCount(from: string, to: string): number {
  return Math.round((fromIsoDate(to).getTime() - fromIsoDate(from).getTime()) / DAY_MS) + 1;
}

/**
 * Minutes the patient arrived after the appointment (positive = late,
 * 0 or negative = on time), or null when it cannot be measured.
 */
export function arrivalDelayMinutes(trip: KpiTrip): number | null {
  if (trip.direction !== "OUTBOUND" || trip.appointmentMinute === null || trip.dropoffCompletedAt === null) return null;
  return minuteOfServiceDay(trip.dropoffCompletedAt, trip.serviceDate) - trip.appointmentMinute;
}

function emptyTotals(): KpiTotals {
  return {
    vehicles: 0,
    realizedVehicles: 0,
    servedTrips: 0,
    realizedTrips: 0,
    distanceKm: 0,
    emptyKm: 0,
    sharedTrips: 0,
    realizedOutbound: 0,
    measuredOutbound: 0,
    lateArrivals: 0,
    lateOver5: 0,
    lateOver15: 0,
    maxDelayMinutes: null,
    plannedOutbound: 0,
    tightOutbound: 0,
    optimizationRuns: 0,
    exceptionalAmbulanceTrips: 0,
    revenue: 0,
    cost: 0,
    margin: 0,
    servedRevenue: 0,
    realizedRevenue: 0,
    noShowRevenue: 0,
  };
}

function maxOrNull(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function addTotals(sum: KpiTotals, day: KpiTotals): KpiTotals {
  return {
    vehicles: sum.vehicles + day.vehicles,
    realizedVehicles: sum.realizedVehicles + day.realizedVehicles,
    servedTrips: sum.servedTrips + day.servedTrips,
    realizedTrips: sum.realizedTrips + day.realizedTrips,
    distanceKm: sum.distanceKm + day.distanceKm,
    emptyKm: sum.emptyKm + day.emptyKm,
    sharedTrips: sum.sharedTrips + day.sharedTrips,
    realizedOutbound: sum.realizedOutbound + day.realizedOutbound,
    measuredOutbound: sum.measuredOutbound + day.measuredOutbound,
    lateArrivals: sum.lateArrivals + day.lateArrivals,
    lateOver5: sum.lateOver5 + day.lateOver5,
    lateOver15: sum.lateOver15 + day.lateOver15,
    maxDelayMinutes: maxOrNull(sum.maxDelayMinutes, day.maxDelayMinutes),
    plannedOutbound: sum.plannedOutbound + day.plannedOutbound,
    tightOutbound: sum.tightOutbound + day.tightOutbound,
    optimizationRuns: sum.optimizationRuns + day.optimizationRuns,
    exceptionalAmbulanceTrips: sum.exceptionalAmbulanceTrips + day.exceptionalAmbulanceTrips,
    revenue: sum.revenue + day.revenue,
    cost: sum.cost + day.cost,
    margin: sum.margin + day.margin,
    servedRevenue: sum.servedRevenue + day.servedRevenue,
    realizedRevenue: sum.realizedRevenue + day.realizedRevenue,
    noShowRevenue: sum.noShowRevenue + day.noShowRevenue,
  };
}

/** Rates derived from counters: the same formulas for a day and for a period. */
export function deriveRates(totals: KpiTotals, parts: KpiParts): KpiRates {
  return {
    tripsPerVehiclePlanned: ratio(totals.servedTrips, totals.vehicles),
    tripsPerVehicleRealized: ratio(totals.realizedTrips, totals.realizedVehicles),
    emptyKmShare: ratio(totals.emptyKm, totals.distanceKm),
    eligibleSharedRate: eligibleSharedRate(parts.sharing),
    measuredSharedRate: measuredSharedRate(parts.sharing),
    lateRate: ratio(totals.lateArrivals, totals.measuredOutbound),
    tightRate: ratio(totals.tightOutbound, totals.plannedOutbound),
    serviceRate: serviceRate(parts.demand),
    tripsPerAvailableVehicle: parts.fleet ? ratio(totals.servedTrips, parts.fleet.available) : null,
    useRate: fleetUseRate(parts.fleet),
    marginPerTrip: ratio(totals.servedRevenue - totals.cost, totals.servedTrips),
  };
}

// ---------------------------------------------------------------------------
// Per-day computation
// ---------------------------------------------------------------------------

/** Rows of the dashboard, the fleet and the frozen plans optional. */
export type KpiRows = {
  routes: readonly KpiRoute[];
  trips: readonly KpiTrip[];
  runs: readonly KpiRun[];
  fleet?: readonly KpiFleetDay[];
  plans?: readonly KpiFrozenPlan[];
};

/**
 * Indicators of one service date. The rows may contain other dates: only
 * those of `date` are used. `today` ("YYYY-MM-DD", Europe/Paris) decides
 * whether realized indicators make sense yet.
 */
export function computeDayKpis(date: string, rows: KpiRows, today: string, options: KpiOptions = DEFAULT_KPI_OPTIONS): DayKpis {
  const dayRoutes = rows.routes.filter((r) => r.serviceDate === date);
  // Routes emptied by cancellations keep stale km and money: leave them out, like /planning.
  const routes = dayRoutes.filter(isUsedRoute);
  const trips = rows.trips.filter((t) => t.serviceDate === date);
  const runs = rows.runs.filter((r) => r.serviceDate === date);
  const upcoming = date > today;

  const totals = emptyTotals();
  const usedVehicleIds = new Set(routes.map((r) => r.vehicleId));
  totals.vehicles = usedVehicleIds.size;
  totals.realizedVehicles = upcoming
    ? 0
    : new Set(routes.filter((r) => r.hasRecordedStatus).map((r) => r.vehicleId)).size;
  totals.optimizationRuns = runs.length;
  for (const route of routes) {
    totals.distanceKm += route.distanceKm;
    totals.emptyKm += route.emptyKm;
    totals.revenue += route.revenue;
    totals.cost += route.cost;
    totals.margin += route.margin;
  }

  for (const trip of trips) {
    const revenue = typeof trip.estimatedRevenue === "number" && Number.isFinite(trip.estimatedRevenue) ? trip.estimatedRevenue : 0;
    if (trip.status === "NO_SHOW") totals.noShowRevenue += revenue;
    if (!isServedTrip(trip)) continue;
    totals.servedTrips += 1;
    totals.servedRevenue += revenue;
    if (trip.shared) totals.sharedTrips += 1;
    if (trip.exceptionalAmbulance) totals.exceptionalAmbulanceTrips += 1;

    const outboundWithAppointment = trip.direction === "OUTBOUND" && trip.appointmentMinute !== null;
    if (outboundWithAppointment && trip.plannedDropoffMinute !== null) {
      totals.plannedOutbound += 1;
      if ((trip.appointmentMinute ?? 0) - trip.plannedDropoffMinute < options.tightMarginMin) totals.tightOutbound += 1;
    }

    if (!isRealizedTrip(trip)) continue;
    totals.realizedTrips += 1;
    totals.realizedRevenue += revenue;
    if (!outboundWithAppointment) continue;
    totals.realizedOutbound += 1;
    const delay = arrivalDelayMinutes(trip);
    if (delay === null) continue;
    totals.measuredOutbound += 1;
    if (delay > options.lateToleranceMin) totals.lateArrivals += 1;
    if (delay > 5) totals.lateOver5 += 1;
    if (delay > 15) totals.lateOver15 += 1;
    if (delay > 0) totals.maxDelayMinutes = maxOrNull(totals.maxDelayMinutes, delay);
  }

  const vehicleTypeOf = new Map<string, VehicleType>();
  for (const route of routes) if (route.id && route.vehicleType) vehicleTypeOf.set(route.id, route.vehicleType);
  const parts: KpiParts = {
    demand: demandOfDay(trips),
    fleet: fleetOfDay(rows.fleet?.find((f) => f.serviceDate === date), usedVehicleIds),
    sharing: sharingOfDay(trips, (routeId) => vehicleTypeOf.get(routeId)),
    waits: waitsOfDay(trips, options),
  };

  const firstRunAt = runs.reduce<Date | null>(
    (first, run) => (first === null || run.startedAt < first ? run.startedAt : first),
    null,
  );
  // Validation applies to every route row of the date (as /planning reads it), emptied ones included.
  const allValidated = dayRoutes.length > 0 && dayRoutes.every((r) => r.validatedAt !== null);
  const validatedAt = allValidated
    ? dayRoutes.reduce<Date | null>((last, r) => (r.validatedAt && (!last || r.validatedAt > last) ? r.validatedAt : last), null)
    : null;
  const planningStatus: PlanningStatus = allValidated
    ? "VALIDATED"
    : dayRoutes.length > 0 || runs.length > 0
      ? "NOT_VALIDATED"
      : "NONE";
  const elapsed = validatedAt && firstRunAt ? (validatedAt.getTime() - firstRunAt.getTime()) / 60_000 : null;
  const rates = deriveRates(totals, parts);

  return {
    date,
    upcoming,
    inProgress: date === today,
    ...totals,
    ...rates,
    // Nothing planned yet: no service rate (every trip would read « non affectée ») nor fleet use (every vehicle idle).
    ...(routes.length > 0 || runs.length > 0 ? {} : { serviceRate: null, useRate: null, tripsPerAvailableVehicle: null }),
    ...parts,
    planningStatus,
    firstRunAt,
    validatedAt,
    // A validation older than the first run means the routes did not come from these runs.
    planningMinutes: elapsed !== null && elapsed >= 0 ? elapsed : null,
    matrixSources: distinctSources(routes),
    simulated: runs.some((run) => run.simulated === true),
    frozen: rows.plans?.find((plan) => plan.serviceDate === date) ?? null,
  };
}

/**
 * Whether the km and times of these days (or periods) come from different
 * distance sources (OSRM, the straight-line estimate, or routes recomputed
 * with the other one): they do not compare from one to the other.
 */
export function mixedDistanceSources(...days: readonly Pick<DayKpis, "matrixSources">[]): boolean {
  const sources = new Set(days.flatMap((day) => day.matrixSources));
  return sources.size > 1 || sources.has("mixed");
}

function distinctSources(routes: readonly Pick<KpiRoute, "matrixSource">[]): string[] {
  return [...new Set(routes.flatMap((route) => (route.matrixSource ? [route.matrixSource] : [])))].sort();
}

/** Indicators of every date from `from` to `to` (empty days included), oldest first. */
export function computeKpisByDay(from: string, to: string, data: KpiData, today: string, options: KpiOptions = DEFAULT_KPI_OPTIONS): DayKpis[] {
  return computeKpisForDates(listDates(from, to), data, today, options);
}

/** Indicators of the given dates, in their order (comparison days that are not consecutive). */
export function computeKpisForDates(dates: readonly string[], data: KpiData, today: string, options: KpiOptions = DEFAULT_KPI_OPTIONS): DayKpis[] {
  type Bucket = { routes: KpiRoute[]; trips: KpiTrip[]; runs: KpiRun[]; fleet: KpiFleetDay[]; plans: KpiFrozenPlan[] };
  const byDate = new Map<string, Bucket>();
  const bucket = (date: string) => {
    let rows = byDate.get(date);
    if (!rows) {
      rows = { routes: [], trips: [], runs: [], fleet: [], plans: [] };
      byDate.set(date, rows);
    }
    return rows;
  };
  for (const route of data.routes) bucket(route.serviceDate).routes.push(route);
  for (const trip of data.trips) bucket(trip.serviceDate).trips.push(trip);
  for (const run of data.runs) bucket(run.serviceDate).runs.push(run);
  for (const day of data.fleet ?? []) bucket(day.serviceDate).fleet.push(day);
  for (const plan of data.plans ?? []) bucket(plan.serviceDate).plans.push(plan);

  return dates.map((date) => computeDayKpis(date, byDate.get(date) ?? { routes: [], trips: [], runs: [] }, today, options));
}

/** Day with planning activity (an optimization or a route). */
export function hasPlanning(day: Pick<DayKpis, "vehicles" | "optimizationRuns">): boolean {
  return day.vehicles > 0 || day.optimizationRuns > 0;
}

/**
 * Period summary: rates are recomputed from summed counters, not averaged day
 * by day. The realized trips-per-vehicle rate only sums finished days: the
 * day in progress would add all its vehicles but only part of its drop-offs.
 * Demand, fleet and sharing only sum the days with planning: a day not
 * optimized yet would read « every trip unassigned » and « every eligible trip
 * never proposed », a Sunday without transport « every vehicle idle ».
 */
export function summarizePeriod(days: readonly DayKpis[]): PeriodKpis {
  const totals = days.reduce<KpiTotals>((sum, day) => addTotals(sum, day), emptyTotals());
  const finished = days.filter((d) => !d.inProgress);
  totals.realizedTrips = finished.reduce((sum, d) => sum + d.realizedTrips, 0);
  totals.realizedVehicles = finished.reduce((sum, d) => sum + d.realizedVehicles, 0);
  const planned = days.filter(hasPlanning);
  const parts: KpiParts = {
    demand: planned.reduce((sum, d) => addDemand(sum, d.demand), emptyDemand()),
    fleet: planned.reduce<FleetTotals | null>((sum, d) => addFleet(sum, d.fleet), null),
    sharing: planned.reduce((sum, d) => addSharing(sum, d.sharing), emptySharing()),
    waits: days.reduce((sum, d) => addWaits(sum, d.waits), emptyWaits()),
  };
  const measured = days.filter((d) => d.planningMinutes !== null);
  const planningSum = measured.reduce((sum, d) => sum + (d.planningMinutes ?? 0), 0);
  return {
    from: days[0]?.date ?? "",
    to: days[days.length - 1]?.date ?? "",
    days: days.length,
    inProgressDate: days.find((d) => d.inProgress)?.date ?? null,
    plannedDays: days.filter((d) => d.vehicles > 0).length,
    validatedDays: days.filter((d) => d.planningStatus === "VALIDATED").length,
    measuredPlanningDays: measured.length,
    averagePlanningMinutes: ratio(planningSum, measured.length),
    matrixSources: [...new Set(days.flatMap((day) => day.matrixSources))].sort(),
    simulatedDays: days.filter((d) => d.simulated).length,
    ...totals,
    ...parts,
    ...deriveRates(totals, parts),
  };
}

// ---------------------------------------------------------------------------
// Page helpers: range, headline days, comparison
// ---------------------------------------------------------------------------

export const DEFAULT_RANGE_DAYS = 14;
export const MAX_RANGE_DAYS = 92;

export type KpiRange = { from: string; to: string; error: string | null };

/**
 * Date range of the dashboard from the query string. Default: the
 * DEFAULT_RANGE_DAYS days ending tomorrow (J+1). Invalid input falls back to
 * the default with a message; a reversed range is swapped; a range longer
 * than MAX_RANGE_DAYS is shortened from the start.
 */
export function resolveKpiRange(input: { from?: string | null; to?: string | null }, tomorrow: string): KpiRange {
  const errors: string[] = [];
  const rawFrom = input.from?.trim() || null;
  const rawTo = input.to?.trim() || null;

  let to = tomorrow;
  if (rawTo !== null) {
    if (isIsoDate(rawTo)) to = rawTo;
    else errors.push("Date de fin invalide\u00a0: J+1 est utilisé.");
  }
  let from = addDays(to, -(DEFAULT_RANGE_DAYS - 1));
  if (rawFrom !== null) {
    if (isIsoDate(rawFrom)) from = rawFrom;
    else errors.push(`Date de début invalide\u00a0: les ${DEFAULT_RANGE_DAYS} jours précédant la date de fin sont affichés.`);
  }
  if (from > to) {
    [from, to] = [to, from];
    errors.push("La date de début était après la date de fin\u00a0: les deux dates ont été inversées.");
  }
  if (dayCount(from, to) > MAX_RANGE_DAYS) {
    from = addDays(to, -(MAX_RANGE_DAYS - 1));
    errors.push(`La période est limitée à ${MAX_RANGE_DAYS} jours\u00a0: elle commence le ${formatShortDate(from)}.`);
  }
  return { from, to, error: errors.length > 0 ? errors.join(" ") : null };
}

/** Tolerances offered for a late arrival (minutes after the appointment): the PO decides V's. */
export const LATE_TOLERANCES = [0, 5, 10, 15] as const;

/** Tolerance of the query string (?retard=), DEFAULT_KPI_OPTIONS.lateToleranceMin when absent or not offered. */
export function resolveLateTolerance(raw: string | null | undefined): number {
  const value = Number(raw);
  return raw !== null && raw !== undefined && raw.trim() !== "" && (LATE_TOLERANCES as readonly number[]).includes(value)
    ? value
    : DEFAULT_KPI_OPTIONS.lateToleranceMin;
}

/**
 * The two days of the headline: the last day done (« Hier (réalisé) ») and the
 * next day planned (« Demain (prévu) »).
 * - A requested day in the range replaces the block of its kind: a day before
 *   tomorrow is shown as done (today: in progress), a later one as planned.
 * - Done, by default: the most recent day before today with routes.
 * - Planned, by default: tomorrow when the range contains it, else the first
 *   day after today with planning activity.
 */
export function pickHeadlineDays(
  days: readonly DayKpis[],
  options: { from: string; to: string; today: string; tomorrow: string; requested?: string | null },
): { realized: DayKpis | null; planned: DayKpis | null } {
  const visible = days.filter((d) => d.date >= options.from && d.date <= options.to);
  const requested = options.requested ? (visible.find((d) => d.date === options.requested) ?? null) : null;
  const latest = <T>(list: readonly T[]): T | null => list[list.length - 1] ?? null;
  const realized =
    requested && requested.date < options.tomorrow
      ? requested
      : latest(visible.filter((d) => d.date < options.today && d.vehicles > 0));
  const planned =
    requested && requested.date >= options.tomorrow
      ? requested
      : (visible.find((d) => d.date === options.tomorrow) ?? visible.find((d) => d.date > options.today && hasPlanning(d)) ?? null);
  return { realized, planned };
}

/** Change from `previous` to `current`, or null when either is unknown. */
export function kpiDelta(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return current - previous;
}

/**
 * How a change reads for the business: "better", "worse" or "same".
 * `higherIsBetter` is false for km à vide, retards and planning time.
 */
export function deltaTrend(delta: number | null, higherIsBetter: boolean, epsilon = 1e-9): "better" | "worse" | "same" | null {
  if (delta === null) return null;
  if (Math.abs(delta) <= epsilon) return "same";
  return delta > 0 === higherIsBetter ? "better" : "worse";
}
