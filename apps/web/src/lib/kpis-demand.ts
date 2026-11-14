/**
 * Demand and service of a day (KPI-01): every trip of the date, not only the
 * served ones, so a plan that leaves trips aside never looks better. Pure.
 *
 * Funnel of a date: demandées → annulées la veille → servies (then réalisées
 * or without a recorded drop-off) / absentes / annulées le jour J / non
 * affectées / confiées à un confrère. Each trip is in exactly one bucket:
 *   requested = cancelledBefore + cancelledOnDay + handedOver + noShows + served + unassigned
 *
 * Taux de service = placées ÷ à transporter, where the trips to carry are the
 * requested ones minus the patients' cancellations (the day before and the
 * day itself: patient, facility, hospitalisation, the regulation after an
 * absence, the referential…), and the placed ones those on a route (served,
 * or the patient was absent when the crew came). What was not placed is lost
 * for the company: left without a vehicle, or handed over to a partner.
 */
import { isoDateOf } from "@/lib/time";
import { isLyingTrip, isRealizedTrip, isServedTrip, ratio, type KpiTrip } from "./kpis-rows";

export type DemandTotals = {
  /** Every trip of the date, whatever its status. */
  requested: number;
  /** Cancelled before the service day (Europe/Paris), not handed over: by the patient, the facility, the app. */
  cancelledBefore: number;
  /** Cancelled on the service day itself, not handed over. */
  cancelledOnDay: number;
  /** Handed over to a partner company (cancellation reason PARTNER): demand the company could not carry. */
  handedOver: number;
  /** The crew declared the patient absent. */
  noShows: number;
  /** Served: in a route, planned, picked up or dropped off. */
  served: number;
  /** Of the served trips, dropped off. */
  realized: number;
  /** Not cancelled, not absent, in no route. */
  unassigned: number;
  /**
   * Estimated revenue of the trips not placed (unassigned or handed over): each
   * priced at the day's average revenue of a served trip of the same kind
   * (lying or seated), else of any served trip. Unpriced when the day has none.
   */
  lostRevenue: number;
  unpricedLost: number;
};

export function emptyDemand(): DemandTotals {
  return {
    requested: 0,
    cancelledBefore: 0,
    cancelledOnDay: 0,
    handedOver: 0,
    noShows: 0,
    served: 0,
    realized: 0,
    unassigned: 0,
    lostRevenue: 0,
    unpricedLost: 0,
  };
}

export function addDemand(a: DemandTotals, b: DemandTotals): DemandTotals {
  return {
    requested: a.requested + b.requested,
    cancelledBefore: a.cancelledBefore + b.cancelledBefore,
    cancelledOnDay: a.cancelledOnDay + b.cancelledOnDay,
    handedOver: a.handedOver + b.handedOver,
    noShows: a.noShows + b.noShows,
    served: a.served + b.served,
    realized: a.realized + b.realized,
    unassigned: a.unassigned + b.unassigned,
    lostRevenue: a.lostRevenue + b.lostRevenue,
    unpricedLost: a.unpricedLost + b.unpricedLost,
  };
}

/** Trips to carry: requested minus the patients' cancellations. */
export function tripsToCarry(d: DemandTotals): number {
  return d.requested - d.cancelledBefore - d.cancelledOnDay;
}

/** Trips placed on a route: served, or the patient was absent. */
export function placedTrips(d: DemandTotals): number {
  return d.served + d.noShows;
}

/** Trips lost for the company: left without a vehicle or handed over. */
export function lostTrips(d: DemandTotals): number {
  return d.unassigned + d.handedOver;
}

/** Placed ÷ to carry; null when there was nothing to carry. */
export function serviceRate(d: DemandTotals): number | null {
  return ratio(placedTrips(d), placedTrips(d) + lostTrips(d));
}

/** The cancellation happened before the service day (Paris). Unknown instant: before (cancellations predating the field). */
export function cancelledBeforeDay(trip: Pick<KpiTrip, "cancelledAt">, serviceDate: string): boolean {
  return !trip.cancelledAt || isoDateOf(trip.cancelledAt) < serviceDate;
}

/** Bucket of a trip in the funnel of its date. */
export type DemandBucket = "cancelledBefore" | "cancelledOnDay" | "handedOver" | "noShow" | "served" | "unassigned";

export function demandBucket(trip: KpiTrip): DemandBucket {
  if (trip.status === "CANCELLED") {
    if (trip.cancellationReason === "PARTNER") return "handedOver";
    return cancelledBeforeDay(trip, trip.serviceDate) ? "cancelledBefore" : "cancelledOnDay";
  }
  if (trip.status === "NO_SHOW") return "noShow";
  if (isServedTrip(trip)) return "served";
  return "unassigned";
}

/** Demand of the trips of one date (the caller passes the trips of that date). */
export function demandOfDay(trips: readonly KpiTrip[]): DemandTotals {
  const totals = emptyDemand();
  const revenue = { lying: { sum: 0, count: 0 }, seated: { sum: 0, count: 0 } };
  const lost: KpiTrip[] = [];
  for (const trip of trips) {
    // A transport interrupted on the way (DAY-03) is one demand with its continuation: only the continuation counts.
    if (trip.status === "CANCELLED" && trip.cancellationReason === "INTERRUPTED") continue;
    totals.requested += 1;
    const bucket = demandBucket(trip);
    if (bucket === "cancelledBefore") totals.cancelledBefore += 1;
    else if (bucket === "cancelledOnDay") totals.cancelledOnDay += 1;
    else if (bucket === "handedOver") totals.handedOver += 1;
    else if (bucket === "noShow") totals.noShows += 1;
    else if (bucket === "unassigned") totals.unassigned += 1;
    else {
      totals.served += 1;
      if (isRealizedTrip(trip)) totals.realized += 1;
      if (typeof trip.estimatedRevenue === "number" && Number.isFinite(trip.estimatedRevenue)) {
        const kind = isLyingTrip(trip) ? revenue.lying : revenue.seated;
        kind.sum += trip.estimatedRevenue;
        kind.count += 1;
      }
    }
    if (bucket === "handedOver" || bucket === "unassigned") lost.push(trip);
  }
  const overall = ratio(revenue.lying.sum + revenue.seated.sum, revenue.lying.count + revenue.seated.count);
  for (const trip of lost) {
    const kind = isLyingTrip(trip) ? revenue.lying : revenue.seated;
    const price = ratio(kind.sum, kind.count) ?? overall;
    if (price === null) totals.unpricedLost += 1;
    else totals.lostRevenue += price;
  }
  return totals;
}
