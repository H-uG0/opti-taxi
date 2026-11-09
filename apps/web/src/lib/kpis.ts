/**
 * Dashboard indicators (MVP item 7: the five indicators of the spec, day by day).
 *
 * Pure module: it works on plain rows loaded by the dashboard page, never
 * touches the database, and is unit-tested with vitest. Every rate is a
 * fraction (0.23 = 23 %) computed from sums, and is null when its
 * denominator is zero (displayed as "—"), never NaN or Infinity.
 */
import type { TripDirection, TripStatus } from "@prisma/client";
import { addDays, formatShortDate, fromIsoDate, isIsoDate, isoDateOf, minuteOfDay } from "@/lib/time";

// ---------------------------------------------------------------------------
// Input rows
// ---------------------------------------------------------------------------

export type KpiRoute = {
  /** Service date, "YYYY-MM-DD". */
  serviceDate: string;
  vehicleId: string;
  distanceKm: number;
  emptyKm: number;
  revenue: number;
  cost: number;
  margin: number;
  validatedAt: Date | null;
  /**
   * Stops still in the route. Cancelling or moving a trip removes its stops
   * but keeps the route row: a route left without stops no longer uses its
   * vehicle (same rule as /planning).
   */
  stopCount: number;
  /** The crew recorded at least one stop status (pickup, drop-off or absence) on this route. */
  hasRecordedStatus: boolean;
  /** Source of its times and km (Route.matrixSource: osrm, haversine, mixed); absent or null: unknown. */
  matrixSource?: string | null;
};

export type KpiTrip = {
  serviceDate: string;
  status: TripStatus;
  routeId: string | null;
  direction: TripDirection;
  shared: boolean;
  appointmentMinute: number | null;
  plannedDropoffMinute: number | null;
  /** Real drop-off instant entered by the driver (completedAt of the trip's DROPOFF stop). */
  dropoffCompletedAt: Date | null;
  /**
   * A seated trip carried by an ambulance on a regulator's proposal (« recours
   * exceptionnel », billed at the VSL tariff); absent: false.
   */
  exceptionalAmbulance?: boolean;
};

/** `simulated`: a run of the history simulation (pnpm db:history), whose day is marked « simulé ». */
export type KpiRun = { serviceDate: string; startedAt: Date; simulated?: boolean };

export type KpiData = { routes: KpiRoute[]; trips: KpiTrip[]; runs: KpiRun[] };

/** Trips that are in a route and will be (or were) billed. */
export const SERVED_TRIP_STATUSES = ["ASSIGNED", "PICKED_UP", "DROPPED_OFF"] as const satisfies readonly TripStatus[];

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
  sharedTrips: number;
  /** Realized (DROPPED_OFF) outbound trips that have an appointment time. */
  realizedOutbound: number;
  /** Of which the driver recorded the drop-off time: the lateness can be measured. */
  measuredOutbound: number;
  /** Measured outbound trips dropped off after the appointment minute. */
  lateArrivals: number;
  /** Largest delay among late arrivals, in minutes. */
  maxDelayMinutes: number | null;
  /** Served outbound trips with both an appointment and a planned drop-off. */
  plannedOutbound: number;
  /** Of which the plan already drops the patient after the appointment (should be 0). */
  plannedLateArrivals: number;
  optimizationRuns: number;
  /** Served seated trips carried by an ambulance as an exceptional measure (protocol of 24 September 2025). */
  exceptionalAmbulanceTrips: number;
  revenue: number;
  cost: number;
  margin: number;
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
  /** 3. Taux de transport partagé. */
  sharedRate: number | null;
  /** 4. Share of measured outbound trips that arrived after the appointment. */
  lateRate: number | null;
};

/**
 * NONE: no optimization and no route; NOT_VALIDATED: work started but some
 * route is not validated; VALIDATED: every route of the day is validated.
 */
export type PlanningStatus = "NONE" | "NOT_VALIDATED" | "VALIDATED";

export type DayKpis = KpiTotals &
  KpiRates & {
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
  };

export type PeriodKpis = KpiTotals &
  KpiRates & {
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

/** numerator / denominator, or null when the denominator is zero. */
export function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

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
 * Real instant -> minute of the planned day `serviceDate` (Europe/Paris), so
 * that it compares with planned minutes: a drop-off at 00:10 the next day is
 * minute 1450, not 10.
 */
export function minuteOfServiceDay(instant: Date, serviceDate: string): number {
  const offsetDays = Math.round((fromIsoDate(isoDateOf(instant)).getTime() - fromIsoDate(serviceDate).getTime()) / DAY_MS);
  return offsetDays * 1440 + minuteOfDay(instant);
}

export function isServedTrip(trip: Pick<KpiTrip, "status" | "routeId">): boolean {
  return trip.routeId !== null && (SERVED_TRIP_STATUSES as readonly TripStatus[]).includes(trip.status);
}

export function isRealizedTrip(trip: Pick<KpiTrip, "status" | "routeId">): boolean {
  return trip.routeId !== null && trip.status === "DROPPED_OFF";
}

/** A route that still has stops: its vehicle, km and money count. */
export function isUsedRoute(route: Pick<KpiRoute, "stopCount">): boolean {
  return route.stopCount > 0;
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
    maxDelayMinutes: null,
    plannedOutbound: 0,
    plannedLateArrivals: 0,
    optimizationRuns: 0,
    exceptionalAmbulanceTrips: 0,
    revenue: 0,
    cost: 0,
    margin: 0,
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
    maxDelayMinutes: maxOrNull(sum.maxDelayMinutes, day.maxDelayMinutes),
    plannedOutbound: sum.plannedOutbound + day.plannedOutbound,
    plannedLateArrivals: sum.plannedLateArrivals + day.plannedLateArrivals,
    optimizationRuns: sum.optimizationRuns + day.optimizationRuns,
    exceptionalAmbulanceTrips: sum.exceptionalAmbulanceTrips + day.exceptionalAmbulanceTrips,
    revenue: sum.revenue + day.revenue,
    cost: sum.cost + day.cost,
    margin: sum.margin + day.margin,
  };
}

/** Rates derived from counters: the same formulas for a day and for a period. */
export function deriveRates(totals: KpiTotals): KpiRates {
  return {
    tripsPerVehiclePlanned: ratio(totals.servedTrips, totals.vehicles),
    tripsPerVehicleRealized: ratio(totals.realizedTrips, totals.realizedVehicles),
    emptyKmShare: ratio(totals.emptyKm, totals.distanceKm),
    sharedRate: ratio(totals.sharedTrips, totals.servedTrips),
    lateRate: ratio(totals.lateArrivals, totals.measuredOutbound),
  };
}

// ---------------------------------------------------------------------------
// Per-day computation
// ---------------------------------------------------------------------------

/**
 * Indicators of one service date. The rows may contain other dates: only
 * those of `date` are used. `today` ("YYYY-MM-DD", Europe/Paris) decides
 * whether realized indicators make sense yet.
 */
export function computeDayKpis(
  date: string,
  rows: { routes: readonly KpiRoute[]; trips: readonly KpiTrip[]; runs: readonly KpiRun[] },
  today: string,
): DayKpis {
  const dayRoutes = rows.routes.filter((r) => r.serviceDate === date);
  // Routes emptied by cancellations keep stale km and money: leave them out, like /planning.
  const routes = dayRoutes.filter(isUsedRoute);
  const trips = rows.trips.filter((t) => t.serviceDate === date);
  const runs = rows.runs.filter((r) => r.serviceDate === date);
  const upcoming = date > today;

  const totals = emptyTotals();
  totals.vehicles = new Set(routes.map((r) => r.vehicleId)).size;
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
    if (!isServedTrip(trip)) continue;
    totals.servedTrips += 1;
    if (trip.shared) totals.sharedTrips += 1;
    if (trip.exceptionalAmbulance) totals.exceptionalAmbulanceTrips += 1;

    const outboundWithAppointment = trip.direction === "OUTBOUND" && trip.appointmentMinute !== null;
    if (outboundWithAppointment && trip.plannedDropoffMinute !== null) {
      totals.plannedOutbound += 1;
      if (trip.plannedDropoffMinute > (trip.appointmentMinute ?? 0)) totals.plannedLateArrivals += 1;
    }

    if (!isRealizedTrip(trip)) continue;
    totals.realizedTrips += 1;
    if (!outboundWithAppointment) continue;
    totals.realizedOutbound += 1;
    const delay = arrivalDelayMinutes(trip);
    if (delay === null) continue;
    totals.measuredOutbound += 1;
    if (delay > 0) {
      totals.lateArrivals += 1;
      totals.maxDelayMinutes = maxOrNull(totals.maxDelayMinutes, delay);
    }
  }

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

  return {
    date,
    upcoming,
    inProgress: date === today,
    ...totals,
    ...deriveRates(totals),
    planningStatus,
    firstRunAt,
    validatedAt,
    // A validation older than the first run means the routes did not come from these runs.
    planningMinutes: elapsed !== null && elapsed >= 0 ? elapsed : null,
    matrixSources: distinctSources(routes),
    simulated: runs.some((run) => run.simulated === true),
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
export function computeKpisByDay(from: string, to: string, data: KpiData, today: string): DayKpis[] {
  const byDate = new Map<string, { routes: KpiRoute[]; trips: KpiTrip[]; runs: KpiRun[] }>();
  const bucket = (date: string) => {
    let rows = byDate.get(date);
    if (!rows) {
      rows = { routes: [], trips: [], runs: [] };
      byDate.set(date, rows);
    }
    return rows;
  };
  for (const route of data.routes) bucket(route.serviceDate).routes.push(route);
  for (const trip of data.trips) bucket(trip.serviceDate).trips.push(trip);
  for (const run of data.runs) bucket(run.serviceDate).runs.push(run);

  return listDates(from, to).map((date) =>
    computeDayKpis(date, byDate.get(date) ?? { routes: [], trips: [], runs: [] }, today),
  );
}

/**
 * Period summary: rates are recomputed from summed counters, not averaged day
 * by day. The realized trips-per-vehicle rate only sums finished days: the
 * day in progress would add all its vehicles but only part of its drop-offs.
 */
export function summarizePeriod(days: readonly DayKpis[]): PeriodKpis {
  const totals = days.reduce<KpiTotals>((sum, day) => addTotals(sum, day), emptyTotals());
  const finished = days.filter((d) => !d.inProgress);
  totals.realizedTrips = finished.reduce((sum, d) => sum + d.realizedTrips, 0);
  totals.realizedVehicles = finished.reduce((sum, d) => sum + d.realizedVehicles, 0);
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
    ...deriveRates(totals),
  };
}

// ---------------------------------------------------------------------------
// Page helpers: range, focus day, comparison
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
    else errors.push("Date de fin invalide : J+1 est utilisé.");
  }
  let from = addDays(to, -(DEFAULT_RANGE_DAYS - 1));
  if (rawFrom !== null) {
    if (isIsoDate(rawFrom)) from = rawFrom;
    else errors.push(`Date de début invalide : les ${DEFAULT_RANGE_DAYS} jours précédant la date de fin sont affichés.`);
  }
  if (from > to) {
    [from, to] = [to, from];
    errors.push("La date de début était après la date de fin : les deux dates ont été inversées.");
  }
  if (dayCount(from, to) > MAX_RANGE_DAYS) {
    from = addDays(to, -(MAX_RANGE_DAYS - 1));
    errors.push(`La période est limitée à ${MAX_RANGE_DAYS} jours : elle commence le ${formatShortDate(from)}.`);
  }
  return { from, to, error: errors.length > 0 ? errors.join(" ") : null };
}

/** Day with planning activity (an optimization or a route). */
export function hasPlanning(day: Pick<DayKpis, "vehicles" | "optimizationRuns">): boolean {
  return day.vehicles > 0 || day.optimizationRuns > 0;
}

/**
 * Day shown in the headline tiles and the day it is compared with.
 * Focus: the requested day when it is in [from, last day], otherwise the most
 * recent day with routes (J+1 once optimized), otherwise the most recent day
 * with planning activity, otherwise the last day. Comparison: the closest
 * earlier day with routes (weekends without transport are skipped); `days`
 * may start before `from` so the first visible day still has one.
 */
export function pickFocusDay(
  days: readonly DayKpis[],
  options: { from: string; requested?: string | null },
): { focus: DayKpis | null; previous: DayKpis | null } {
  const visible = days.filter((d) => d.date >= options.from);
  const latest = <T>(list: readonly T[]): T | null => list[list.length - 1] ?? null;
  const focus =
    (options.requested ? visible.find((d) => d.date === options.requested) : undefined) ??
    latest(visible.filter((d) => d.vehicles > 0)) ??
    latest(visible.filter(hasPlanning)) ??
    latest(visible);
  if (!focus) return { focus: null, previous: null };
  const previous = latest(days.filter((d) => d.date < focus.date && d.vehicles > 0));
  return { focus, previous };
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
