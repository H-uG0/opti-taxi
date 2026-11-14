/**
 * Waits and time on board measured from the crews' timestamps (KPI-05). Pure.
 *
 * - Wait before the appointment: appointment - « Déposé » (the patient is left
 *   at the reception then); 0 when dropped off after the appointment.
 * - Wait after the session: « Pris en charge » - planned service time at the
 *   pickup - end of the session, at least 0 (the crew taps once the patient is
 *   on board: the service time is how long boarding takes in the plan).
 * - Total wait of a care session (a patient's outbound and return of the same
 *   episode, lib/domain/no-show isSameEpisode), compared with the 45 min of
 *   the decree 2025-202 (AppSettings.maxTotalWaitMin): measured only when
 *   every leg of the session still served that day has its time. The shared
 *   sessions over it are listed: to justify in an audit by the caisse.
 * - Time on board: « Déposé » - « Pris en charge », against the direct drive,
 *   estimated from the plan (planned time on board × direct km ÷ km on board,
 *   the patient's own detour taken out).
 */
import { isSameEpisode } from "@/lib/domain/no-show";
import { isServedTrip, minuteOfServiceDay, type KpiOptions, type KpiTrip } from "./kpis-rows";

/** A shared care session whose measured wait went over the limit (ids and minutes only). */
export type WaitCase = {
  serviceDate: string;
  patientId: string;
  outboundTripId: string | null;
  returnTripId: string | null;
  beforeMin: number | null;
  afterMin: number | null;
  totalMin: number;
};

export type WaitTotals = {
  /** Waits before the appointment of the outbound legs measured (minutes). */
  beforeWaits: number[];
  /** Waits after the session of the return legs measured (minutes). */
  afterWaits: number[];
  /** Total wait of each care session fully measured (minutes). */
  totalWaits: number[];
  /** Sessions fully measured, and those over the limit. */
  sessions: number;
  overMax: number;
  /** Sessions with a shared leg, and those over the limit (listed in `cases`). */
  sharedSessions: number;
  sharedOverMax: number;
  cases: WaitCase[];
  /** Minutes on board of the trips with both times recorded. */
  rideMinutes: number[];
  /** Minutes on board beyond the estimated direct drive. */
  rideExcess: number[];
  /** Trips whose time on board exceeded the direct drive by more than AppSettings.maxRideExtraMin. */
  rideOverMax: number;
};

export function emptyWaits(): WaitTotals {
  return {
    beforeWaits: [],
    afterWaits: [],
    totalWaits: [],
    sessions: 0,
    overMax: 0,
    sharedSessions: 0,
    sharedOverMax: 0,
    cases: [],
    rideMinutes: [],
    rideExcess: [],
    rideOverMax: 0,
  };
}

export function addWaits(a: WaitTotals, b: WaitTotals): WaitTotals {
  return {
    beforeWaits: [...a.beforeWaits, ...b.beforeWaits],
    afterWaits: [...a.afterWaits, ...b.afterWaits],
    totalWaits: [...a.totalWaits, ...b.totalWaits],
    sessions: a.sessions + b.sessions,
    overMax: a.overMax + b.overMax,
    sharedSessions: a.sharedSessions + b.sharedSessions,
    sharedOverMax: a.sharedOverMax + b.sharedOverMax,
    cases: [...a.cases, ...b.cases],
    rideMinutes: [...a.rideMinutes, ...b.rideMinutes],
    rideExcess: [...a.rideExcess, ...b.rideExcess],
    rideOverMax: a.rideOverMax + b.rideOverMax,
  };
}

/** Wait before the appointment of a dropped-off outbound leg, null when not measured. */
export function waitBeforeAppointment(trip: KpiTrip): number | null {
  if (trip.direction !== "OUTBOUND" || trip.status !== "DROPPED_OFF" || trip.appointmentMinute === null || !trip.dropoffCompletedAt) {
    return null;
  }
  return Math.max(0, trip.appointmentMinute - minuteOfServiceDay(trip.dropoffCompletedAt, trip.serviceDate));
}

/** Wait after the session of a picked-up return leg, null when not measured. */
export function waitAfterSession(trip: KpiTrip): number | null {
  const ready = trip.readyMinute ?? null;
  if (trip.direction !== "RETURN" || ready === null || !trip.pickupCompletedAt) return null;
  if (trip.status !== "PICKED_UP" && trip.status !== "DROPPED_OFF") return null;
  const boarding = Math.max(0, trip.pickupServiceMinutes ?? 0);
  return Math.max(0, minuteOfServiceDay(trip.pickupCompletedAt, trip.serviceDate) - boarding - ready);
}

/** Minutes on board and beyond the estimated direct drive, null when not measured. */
export function rideTime(trip: KpiTrip): { onBoard: number; excess: number | null } | null {
  if (trip.status !== "DROPPED_OFF" || !trip.pickupCompletedAt || !trip.dropoffCompletedAt) return null;
  const onBoard = (trip.dropoffCompletedAt.getTime() - trip.pickupCompletedAt.getTime()) / 60_000;
  if (onBoard < 0) return null;
  const planned = trip.plannedRideMinutes ?? null;
  if (planned === null || planned < 0) return { onBoard, excess: null };
  const direct = trip.directKm ?? null;
  const detour = trip.detourKm ?? 0;
  // The patient's own detour is taken out of the planned time on board, at the same speed.
  const directMinutes = direct !== null && direct > 0 && detour > 0 ? (planned * direct) / (direct + detour) : planned;
  return { onBoard, excess: onBoard - directMinutes };
}

/** Legs of a care session that are still to be (or were) carried. */
function carried(trip: KpiTrip): boolean {
  return isServedTrip(trip);
}

/** Waits and times on board of the trips of one date. */
export function waitsOfDay(trips: readonly KpiTrip[], options: Pick<KpiOptions, "maxTotalWaitMin" | "maxRideExtraMin">): WaitTotals {
  const totals = emptyWaits();
  for (const trip of trips) {
    const before = waitBeforeAppointment(trip);
    if (before !== null) totals.beforeWaits.push(before);
    const after = waitAfterSession(trip);
    if (after !== null) totals.afterWaits.push(after);
    const ride = rideTime(trip);
    if (ride) {
      totals.rideMinutes.push(ride.onBoard);
      if (ride.excess !== null) {
        totals.rideExcess.push(ride.excess);
        if (ride.excess > options.maxRideExtraMin) totals.rideOverMax += 1;
      }
    }
  }

  // Care sessions: the outbound and return legs of a patient's episode, both measured.
  const legs = trips.filter((t) => carried(t) && t.patientId !== undefined);
  const byPatient = new Map<string, KpiTrip[]>();
  for (const leg of legs) {
    const list = byPatient.get(leg.patientId ?? "");
    if (list) list.push(leg);
    else byPatient.set(leg.patientId ?? "", [leg]);
  }
  const used = new Set<KpiTrip>();
  for (const trip of legs) {
    if (used.has(trip)) continue;
    const key = { patientId: trip.patientId ?? "", recurrenceId: trip.recurrenceId ?? null, facilityId: trip.facilityId ?? null };
    const session = (byPatient.get(key.patientId) ?? []).filter(
      (other) =>
        !used.has(other) &&
        isSameEpisode(key, { patientId: other.patientId ?? "", recurrenceId: other.recurrenceId ?? null, facilityId: other.facilityId ?? null }),
    );
    for (const leg of session) used.add(leg);
    const outbound = session.find((leg) => leg.direction === "OUTBOUND") ?? null;
    const back = session.find((leg) => leg.direction === "RETURN") ?? null;
    const beforeMin = outbound ? waitBeforeAppointment(outbound) : null;
    const afterMin = back ? waitAfterSession(back) : null;
    if ((outbound && beforeMin === null) || (back && afterMin === null)) continue;
    const total = (beforeMin ?? 0) + (afterMin ?? 0);
    const shared = session.some((leg) => leg.shared);
    totals.sessions += 1;
    totals.totalWaits.push(total);
    const over = total > options.maxTotalWaitMin;
    if (over) totals.overMax += 1;
    if (!shared) continue;
    totals.sharedSessions += 1;
    if (!over) continue;
    totals.sharedOverMax += 1;
    totals.cases.push({
      serviceDate: trip.serviceDate,
      patientId: trip.patientId ?? "",
      outboundTripId: outbound?.id ?? null,
      returnTripId: back?.id ?? null,
      beforeMin,
      afterMin,
      totalMin: total,
    });
  }
  return totals;
}
