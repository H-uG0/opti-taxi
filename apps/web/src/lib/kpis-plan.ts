/**
 * Planned, served, done (KPI-07). Pure.
 *
 * The plan of a date changes after its validation: an absent patient's trip
 * leaves the served ones, a trip cancelled on the day leaves its route, which
 * is recomputed. What was validated is therefore frozen at the validation
 * (ValidatedPlan, written by lib/kpis-plan-store.ts): the same indicators as
 * the dashboard's, computed from the routes and trips at that instant, with a
 * line per vehicle for the breakdowns. A validation made before the service
 * day replaces the frozen plan; a validation on the day itself (after a
 * reopening) keeps the one of the day before, so the absences and the
 * cancellations of the day stay visible against it. A reopening before the
 * service day drops the frozen plan: the routes re-optimized after it are no
 * longer what was validated, and the next validation freezes them.
 *
 * Comparisons are fair: the same weekday of the week before (the series of
 * dialysis follow Mon-Wed-Fri or Tue-Thu-Sat), or the four same weekdays before
 * it, their counters summed (a rate of the four weeks, not an average of rates).
 */
import { z } from "zod";
import type { VehicleType } from "@prisma/client";
import { addDays, isoDateOf } from "@/lib/time";
import type { DayKpis } from "./kpis";
import { byTap, tapTotal, type ByTap } from "./kpis-sharing";
import { isServedTrip, isUsedRoute, ratio, type KpiFrozenPlan, type KpiRoute, type KpiTrip } from "./kpis-rows";

export type PlanVehicleFigures = {
  vehicleId: string;
  vehicleType: VehicleType | null;
  depotId: string | null;
  trips: number;
  sharedTrips: number;
  distanceKm: number;
  emptyKm: number;
  revenue: number;
  cost: number;
};

/** Indicators of a plan: the routes of a date as they stand (or stood at the validation). */
export type PlanFigures = {
  /** Trips in a route (served). */
  served: number;
  /** Not cancelled, not absent, in no route. */
  unassigned: number;
  /** Handed over to a partner company. */
  handedOver: number;
  /** Declared absent (a plan validated on the day itself). */
  noShows: number;
  vehicles: number;
  distanceKm: number;
  emptyKm: number;
  revenue: number;
  cost: number;
  margin: number;
  sharedTrips: number;
  /** Shared transport as the Assurance maladie counts it (kpis-sharing.ts). */
  tap: ByTap;
  tapShared: ByTap;
  eligible: ByTap;
  eligibleShared: ByTap;
  /** Outbound trips with an appointment and a planned drop-off, and those planned less than the margin before it. */
  plannedOutbound: number;
  tightOutbound: number;
  byVehicle: PlanVehicleFigures[];
};

/** One line per route with stops of `date`: its trips, km and money (breakdowns by vehicle, type, depot). */
export function vehicleFiguresOf(date: string, routes: readonly KpiRoute[], trips: readonly KpiTrip[]): PlanVehicleFigures[] {
  const byRoute = new Map<string, PlanVehicleFigures>();
  const lines: PlanVehicleFigures[] = [];
  for (const route of routes) {
    if (route.serviceDate !== date || !isUsedRoute(route)) continue;
    const line: PlanVehicleFigures = {
      vehicleId: route.vehicleId,
      vehicleType: route.vehicleType ?? null,
      depotId: route.depotId ?? null,
      trips: 0,
      sharedTrips: 0,
      distanceKm: route.distanceKm,
      emptyKm: route.emptyKm,
      revenue: route.revenue,
      cost: route.cost,
    };
    lines.push(line);
    if (route.id) byRoute.set(route.id, line);
  }
  for (const trip of trips) {
    if (trip.serviceDate !== date || !isServedTrip(trip) || trip.routeId === null) continue;
    const line = byRoute.get(trip.routeId);
    if (!line) continue;
    line.trips += 1;
    if (trip.shared) line.sharedTrips += 1;
  }
  return lines.sort((a, b) => a.vehicleId.localeCompare(b.vehicleId));
}

/** The figures of a day's routes as they stand. */
export function planFiguresOf(day: DayKpis, byVehicle: PlanVehicleFigures[] = []): PlanFigures {
  return {
    served: day.servedTrips,
    unassigned: day.demand.unassigned,
    handedOver: day.demand.handedOver,
    noShows: day.demand.noShows,
    vehicles: day.vehicles,
    distanceKm: day.distanceKm,
    emptyKm: day.emptyKm,
    revenue: day.revenue,
    cost: day.cost,
    margin: day.margin,
    sharedTrips: day.sharedTrips,
    tap: { ...day.sharing.tap },
    tapShared: { ...day.sharing.tapShared },
    eligible: { ...day.sharing.eligible },
    eligibleShared: { ...day.sharing.eligibleShared },
    plannedOutbound: day.plannedOutbound,
    tightOutbound: day.tightOutbound,
    byVehicle,
  };
}

export function emptyPlanFigures(): PlanFigures {
  return {
    served: 0,
    unassigned: 0,
    handedOver: 0,
    noShows: 0,
    vehicles: 0,
    distanceKm: 0,
    emptyKm: 0,
    revenue: 0,
    cost: 0,
    margin: 0,
    sharedTrips: 0,
    tap: byTap(),
    tapShared: byTap(),
    eligible: byTap(),
    eligibleShared: byTap(),
    plannedOutbound: 0,
    tightOutbound: 0,
    byVehicle: [],
  };
}

function sumTap(a: ByTap, b: ByTap): ByTap {
  return { VSL: a.VSL + b.VSL, TAXI: a.TAXI + b.TAXI };
}

/** Sum of plans (the four weeks of a comparison); the vehicle lines are not summed. */
export function addPlanFigures(a: PlanFigures, b: PlanFigures): PlanFigures {
  return {
    served: a.served + b.served,
    unassigned: a.unassigned + b.unassigned,
    handedOver: a.handedOver + b.handedOver,
    noShows: a.noShows + b.noShows,
    vehicles: a.vehicles + b.vehicles,
    distanceKm: a.distanceKm + b.distanceKm,
    emptyKm: a.emptyKm + b.emptyKm,
    revenue: a.revenue + b.revenue,
    cost: a.cost + b.cost,
    margin: a.margin + b.margin,
    sharedTrips: a.sharedTrips + b.sharedTrips,
    tap: sumTap(a.tap, b.tap),
    tapShared: sumTap(a.tapShared, b.tapShared),
    eligible: sumTap(a.eligible, b.eligible),
    eligibleShared: sumTap(a.eligibleShared, b.eligibleShared),
    plannedOutbound: a.plannedOutbound + b.plannedOutbound,
    tightOutbound: a.tightOutbound + b.tightOutbound,
    byVehicle: [],
  };
}

/** Rates of a plan, the dashboard's formulas. */
export type PlanRates = {
  /** Placed ÷ to carry (served and absent ÷ those plus the unassigned and handed over). */
  serviceRate: number | null;
  tripsPerVehicle: number | null;
  emptyKmShare: number | null;
  /** Shared rate of the eligible trips in a taxi or a VSL (the Assurance maladie's scope). */
  sharedRate: number | null;
  tightRate: number | null;
  marginPerTrip: number | null;
};

export function planRates(plan: PlanFigures): PlanRates {
  const placed = plan.served + plan.noShows;
  return {
    serviceRate: ratio(placed, placed + plan.unassigned + plan.handedOver),
    tripsPerVehicle: ratio(plan.served, plan.vehicles),
    emptyKmShare: ratio(plan.emptyKm, plan.distanceKm),
    sharedRate: ratio(tapTotal(plan.eligibleShared), tapTotal(plan.eligible)),
    tightRate: ratio(plan.tightOutbound, plan.plannedOutbound),
    marginPerTrip: ratio(plan.margin, plan.served),
  };
}

// ---------------------------------------------------------------------------
// Frozen plan: storage format and when it is replaced

const tapSchema = z.object({ VSL: z.number(), TAXI: z.number() });

const figuresSchema = z.object({
  served: z.number(),
  unassigned: z.number(),
  handedOver: z.number(),
  noShows: z.number(),
  vehicles: z.number(),
  distanceKm: z.number(),
  emptyKm: z.number(),
  revenue: z.number(),
  cost: z.number(),
  margin: z.number(),
  sharedTrips: z.number(),
  tap: tapSchema,
  tapShared: tapSchema,
  eligible: tapSchema,
  eligibleShared: tapSchema,
  plannedOutbound: z.number(),
  tightOutbound: z.number(),
  byVehicle: z.array(
    z.object({
      vehicleId: z.string(),
      vehicleType: z.enum(["TAXI", "VSL", "AMBULANCE"]).nullable(),
      depotId: z.string().nullable(),
      trips: z.number(),
      sharedTrips: z.number(),
      distanceKm: z.number(),
      emptyKm: z.number(),
      revenue: z.number(),
      cost: z.number(),
    }),
  ),
});

/** ValidatedPlan.figures: versioned, so an older format is still read (or ignored) after a change. */
const storedSchema = z.object({ version: z.literal(1), figures: figuresSchema });

/** Km and euros to the cent: the stored JSON stays readable (no 35.88999999999999). */
function cents(value: number): number {
  return Math.round(value * 100) / 100;
}

export function encodePlanFigures(figures: PlanFigures): { version: 1; figures: PlanFigures } {
  return {
    version: 1,
    figures: {
      ...figures,
      distanceKm: cents(figures.distanceKm),
      emptyKm: cents(figures.emptyKm),
      revenue: cents(figures.revenue),
      cost: cents(figures.cost),
      margin: cents(figures.margin),
      byVehicle: figures.byVehicle.map((line) => ({
        ...line,
        distanceKm: cents(line.distanceKm),
        emptyKm: cents(line.emptyKm),
        revenue: cents(line.revenue),
        cost: cents(line.cost),
      })),
    },
  };
}

/** A stored frozen plan, or null when its format is unknown (it is then ignored, never shown wrong). */
export function decodeFrozenPlan(row: { serviceDate: string; validatedAt: Date; figures: unknown }): KpiFrozenPlan | null {
  const parsed = storedSchema.safeParse(row.figures);
  return parsed.success ? { serviceDate: row.serviceDate, validatedAt: row.validatedAt, figures: parsed.data.figures } : null;
}

/**
 * Whether a validation at `now` replaces the frozen plan of `serviceDate`:
 * always, except a validation on the service day itself (or later) when the
 * frozen plan was validated before that day.
 */
export function replacesFrozenPlan(existing: { validatedAt: Date } | null, serviceDate: string, now: Date): boolean {
  if (!existing) return true;
  return !(isoDateOf(existing.validatedAt) < serviceDate && isoDateOf(now) >= serviceDate);
}

/**
 * Whether reopening the planning of `serviceDate` on `today` drops its frozen
 * plan: before the service day, yes (it will be validated again, or it was
 * not the plan of the day); on the day itself, no (the plan of the day before
 * stays the reference against the absences and cancellations of the day).
 */
export function reopeningDropsFrozenPlan(serviceDate: string, today: string): boolean {
  return today < serviceDate;
}

// ---------------------------------------------------------------------------
// Fair comparisons

/** The four same weekdays before `date`, the closest first. */
export function comparisonDates(date: string): string[] {
  return [7, 14, 21, 28].map((days) => addDays(date, -days));
}
