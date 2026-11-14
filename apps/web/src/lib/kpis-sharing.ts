/**
 * Shared transport as the Assurance maladie counts it (KPI-04). Pure.
 *
 * The regulatory shared transport is the transport assis professionnalisé
 * (taxi conventionné, VSL), for patients of the Assurance maladie: neither
 * the ambulance (one lying patient) nor the private clients count. The rate
 * is taken over the trips whose prescription allows sharing (« éligibles »),
 * taxis and VSL apart, against the objective of the protocol of 24 September
 * 2025 (strictly more than 30 % at the end of 2027, art. 4.2) and the markers
 * the Cour des comptes cites (36 % in VSL, 25 % in taxi). The all-TAP rate
 * (every seated CPAM trip in a taxi or a VSL) is kept beside it: the caisse
 * has not published its own formula yet.
 *
 * - « Prévu » sharing is the plan's (Trip.shared: a co-passenger on board in
 *   the routes). « Mesuré » sharing reads the crews' timestamps: a dropped-off
 *   trip was shared when another patient of the same route was on board at the
 *   same time (their « Pris en charge » → « Déposé » intervals overlap). A
 *   co-passenger declared absent never was.
 * - The funnel of the decree 2025-202: eligible trips, proposed (the plan
 *   shared them, or the patient's answer was recorded), accepted, refused; the
 *   patients who refuse (they lose the third-party payment) and the time
 *   between the proposal and the answer (refusals known in advance, recorded
 *   at the proposal, are not delays).
 * - Why a served seated trip in a taxi or a VSL was not shared: a private
 *   client, a prescription that does not allow it, a refusal, or no compatible
 *   co-passenger in the plan (times, detour, capacity).
 */
import type { VehicleType } from "@prisma/client";
import { cancelledBeforeDay } from "./kpis-demand";
import { isLyingTrip, isRealizedTrip, isServedTrip, isTapType, ratio, TAP_TYPES, type KpiTrip, type TapType } from "./kpis-rows";

/** Objective of the protocol of 24 September 2025 (art. 4.2): strictly more than 30 % of shared transports at the end of 2027. */
export const SHARING_OBJECTIVE = 0.3;
/** Implicit 2027 objectives the Cour des comptes cites (VSL 21,7 % in 2024): markers, not rules. */
export const COUR_DES_COMPTES_MARKERS: Record<TapType, number> = { VSL: 0.36, TAXI: 0.25 };

export type ByTap = Record<TapType, number>;

export function byTap(vsl = 0, taxi = 0): ByTap {
  return { VSL: vsl, TAXI: taxi };
}

export function tapTotal(value: ByTap): number {
  return value.VSL + value.TAXI;
}

function addTap(a: ByTap, b: ByTap): ByTap {
  return { VSL: a.VSL + b.VSL, TAXI: a.TAXI + b.TAXI };
}

export type NotSharedReason = "private" | "prescription" | "refused" | "noMatch";

export type SharingTotals = {
  /** Served CPAM trips in a taxi or a VSL. */
  tap: ByTap;
  tapShared: ByTap;
  /** Of which the prescription allows sharing: the eligible trips. */
  eligible: ByTap;
  eligibleShared: ByTap;
  /** Eligible trips dropped off whose pickup and drop-off were both recorded. */
  measured: ByTap;
  /** Of which another patient was on board at the same time (recorded times). */
  measuredShared: ByTap;
  /** Funnel: eligible trips of the day (not cancelled the day before), whatever their outcome. */
  funnel: { eligible: number; proposed: number; accepted: number; refused: number };
  /** Patients (ids) who refused at least once: a set over a period. */
  refusingPatientIds: string[];
  /** Minutes from the proposal to the answer, answers recorded after the proposal only. */
  responseDelays: number[];
  /** Served seated trips in a taxi or a VSL: shared, or why not. */
  reasons: Record<NotSharedReason | "shared", number>;
  /** Detour of the shared served trips in a taxi or a VSL (km). */
  detour: { count: number; sumKm: number; maxKm: number | null };
};

export function emptySharing(): SharingTotals {
  return {
    tap: byTap(),
    tapShared: byTap(),
    eligible: byTap(),
    eligibleShared: byTap(),
    measured: byTap(),
    measuredShared: byTap(),
    funnel: { eligible: 0, proposed: 0, accepted: 0, refused: 0 },
    refusingPatientIds: [],
    responseDelays: [],
    reasons: { shared: 0, private: 0, prescription: 0, refused: 0, noMatch: 0 },
    detour: { count: 0, sumKm: 0, maxKm: null },
  };
}

export function addSharing(a: SharingTotals, b: SharingTotals): SharingTotals {
  return {
    tap: addTap(a.tap, b.tap),
    tapShared: addTap(a.tapShared, b.tapShared),
    eligible: addTap(a.eligible, b.eligible),
    eligibleShared: addTap(a.eligibleShared, b.eligibleShared),
    measured: addTap(a.measured, b.measured),
    measuredShared: addTap(a.measuredShared, b.measuredShared),
    funnel: {
      eligible: a.funnel.eligible + b.funnel.eligible,
      proposed: a.funnel.proposed + b.funnel.proposed,
      accepted: a.funnel.accepted + b.funnel.accepted,
      refused: a.funnel.refused + b.funnel.refused,
    },
    refusingPatientIds: [...new Set([...a.refusingPatientIds, ...b.refusingPatientIds])].sort(),
    responseDelays: [...a.responseDelays, ...b.responseDelays],
    reasons: {
      shared: a.reasons.shared + b.reasons.shared,
      private: a.reasons.private + b.reasons.private,
      prescription: a.reasons.prescription + b.reasons.prescription,
      refused: a.reasons.refused + b.reasons.refused,
      noMatch: a.reasons.noMatch + b.reasons.noMatch,
    },
    detour: {
      count: a.detour.count + b.detour.count,
      sumKm: a.detour.sumKm + b.detour.sumKm,
      maxKm: a.detour.maxKm === null ? b.detour.maxKm : b.detour.maxKm === null ? a.detour.maxKm : Math.max(a.detour.maxKm, b.detour.maxKm),
    },
  };
}

/** Planned shared rate over the eligible trips, one type or both (null: none eligible). */
export function eligibleSharedRate(s: Pick<SharingTotals, "eligible" | "eligibleShared">, type?: TapType): number | null {
  return type ? ratio(s.eligibleShared[type], s.eligible[type]) : ratio(tapTotal(s.eligibleShared), tapTotal(s.eligible));
}

/** Measured shared rate over the eligible trips dropped off with both times recorded. */
export function measuredSharedRate(s: Pick<SharingTotals, "measured" | "measuredShared">, type?: TapType): number | null {
  return type ? ratio(s.measuredShared[type], s.measured[type]) : ratio(tapTotal(s.measuredShared), tapTotal(s.measured));
}

/** Planned shared rate over every served CPAM trip in a taxi or a VSL. */
export function tapSharedRate(s: Pick<SharingTotals, "tap" | "tapShared">, type?: TapType): number | null {
  return type ? ratio(s.tapShared[type], s.tap[type]) : ratio(tapTotal(s.tapShared), tapTotal(s.tap));
}

/** Why a served seated trip in a taxi or a VSL was not shared. */
export function notSharedReason(trip: Pick<KpiTrip, "payer" | "sharingAllowed" | "sharingStatus">): NotSharedReason {
  if (trip.payer === "PRIVATE") return "private";
  if (!trip.sharingAllowed) return "prescription";
  if (trip.sharingStatus === "REFUSED") return "refused";
  return "noMatch";
}

function isCpam(trip: Pick<KpiTrip, "payer">): boolean {
  return (trip.payer ?? "CPAM") === "CPAM";
}

/** Another trip dropped off on the same route (`routeTrips`) whose recorded times overlap `trip`'s. */
function onBoardTogether(trip: KpiTrip, routeTrips: readonly KpiTrip[]): boolean {
  const from = trip.pickupCompletedAt?.getTime();
  const to = trip.dropoffCompletedAt?.getTime();
  if (from === undefined || to === undefined) return false;
  return routeTrips.some((other) => {
    if (other === trip) return false;
    const otherFrom = other.pickupCompletedAt?.getTime();
    const otherTo = other.dropoffCompletedAt?.getTime();
    if (otherFrom === undefined || otherTo === undefined) return false;
    return Math.max(from, otherFrom) < Math.min(to, otherTo);
  });
}

/**
 * Sharing of the trips of one date. `vehicleTypeOf` gives the type of a
 * route's vehicle (undefined: unknown, the trip is not counted as TAP).
 */
export function sharingOfDay(
  trips: readonly KpiTrip[],
  vehicleTypeOf: (routeId: string) => VehicleType | undefined,
): SharingTotals {
  const totals = emptySharing();
  const refusing = new Set<string>();
  // Trips with both times recorded, by route: the co-passengers actually on board.
  const timedByRoute = new Map<string, KpiTrip[]>();
  for (const trip of trips) {
    if (!isRealizedTrip(trip) || !trip.pickupCompletedAt || !trip.dropoffCompletedAt || trip.routeId === null) continue;
    const list = timedByRoute.get(trip.routeId);
    if (list) list.push(trip);
    else timedByRoute.set(trip.routeId, [trip]);
  }

  for (const trip of trips) {
    const seated = !isLyingTrip(trip);
    const cpam = isCpam(trip);

    // Funnel: every eligible trip of the day not cancelled the day before.
    if (seated && cpam && trip.sharingAllowed) {
      const cancelledBefore = trip.status === "CANCELLED" && trip.cancellationReason !== "PARTNER" && cancelledBeforeDay(trip, trip.serviceDate);
      if (!cancelledBefore) {
        totals.funnel.eligible += 1;
        const status = trip.sharingStatus;
        if (status === "PROPOSED" || status === "ACCEPTED" || status === "REFUSED") totals.funnel.proposed += 1;
        if (status === "ACCEPTED") totals.funnel.accepted += 1;
        if (status === "REFUSED") {
          totals.funnel.refused += 1;
          if (trip.patientId) refusing.add(trip.patientId);
        }
        if ((status === "ACCEPTED" || status === "REFUSED") && trip.sharingProposedAt && trip.sharingRespondedAt) {
          const minutes = (trip.sharingRespondedAt.getTime() - trip.sharingProposedAt.getTime()) / 60_000;
          if (minutes > 0) totals.responseDelays.push(minutes);
        }
      }
    }

    if (!isServedTrip(trip) || trip.routeId === null) continue;
    const type = vehicleTypeOf(trip.routeId);
    if (!isTapType(type) || !seated) continue;

    if (trip.shared) {
      totals.reasons.shared += 1;
      if (typeof trip.detourKm === "number" && Number.isFinite(trip.detourKm)) {
        totals.detour.count += 1;
        totals.detour.sumKm += trip.detourKm;
        totals.detour.maxKm = totals.detour.maxKm === null ? trip.detourKm : Math.max(totals.detour.maxKm, trip.detourKm);
      }
    } else {
      totals.reasons[notSharedReason(trip)] += 1;
    }

    if (!cpam) continue;
    totals.tap[type] += 1;
    if (trip.shared) totals.tapShared[type] += 1;
    if (!trip.sharingAllowed) continue;
    totals.eligible[type] += 1;
    if (trip.shared) totals.eligibleShared[type] += 1;
    if (isRealizedTrip(trip) && trip.pickupCompletedAt && trip.dropoffCompletedAt) {
      totals.measured[type] += 1;
      if (onBoardTogether(trip, timedByRoute.get(trip.routeId) ?? [])) totals.measuredShared[type] += 1;
    }
  }
  totals.refusingPatientIds = [...refusing].sort();
  return totals;
}

/** Month of the year-to-date table: planned sharing of the served eligible trips, by type (loaded by month in SQL). */
export type SharingMonth = { month: string; tap: ByTap; tapShared: ByTap; eligible: ByTap; eligibleShared: ByTap };

/** Months of the year from January to the month of `to`, filled with zeros where the query returned nothing. */
export function yearToDateMonths(
  rows: readonly { month: string; type: string; tap: number; tapShared: number; eligible: number; eligibleShared: number }[],
  to: string,
): { months: SharingMonth[]; total: SharingMonth } {
  const year = to.slice(0, 4);
  const last = Number(to.slice(5, 7));
  const months: SharingMonth[] = [];
  for (let m = 1; m <= last; m++) {
    months.push({ month: `${year}-${String(m).padStart(2, "0")}`, tap: byTap(), tapShared: byTap(), eligible: byTap(), eligibleShared: byTap() });
  }
  const byMonth = new Map(months.map((m) => [m.month, m]));
  for (const row of rows) {
    const month = byMonth.get(row.month);
    if (!month || !(TAP_TYPES as readonly string[]).includes(row.type)) continue;
    const type = row.type as TapType;
    month.tap[type] += row.tap;
    month.tapShared[type] += row.tapShared;
    month.eligible[type] += row.eligible;
    month.eligibleShared[type] += row.eligibleShared;
  }
  const total: SharingMonth = { month: year, tap: byTap(), tapShared: byTap(), eligible: byTap(), eligibleShared: byTap() };
  for (const month of months) {
    total.tap = addTap(total.tap, month.tap);
    total.tapShared = addTap(total.tapShared, month.tapShared);
    total.eligible = addTap(total.eligible, month.eligible);
    total.eligibleShared = addTap(total.eligibleShared, month.eligibleShared);
  }
  return { months, total };
}
