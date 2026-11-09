/**
 * Does a trip's planned stop still respect its time window once the regulator
 * changes its appointment (outbound) or end of session (return)? Mirrors the
 * optimizer's hard rules (contract/README.md, services/optimizer/app/model.py
 * derive_windows / same_day_pairs: lib/domain/day-pairs.ts, validator TOTAL_WAIT).
 * Pure: no database access.
 */
import type { TripDirection } from "@prisma/client";
import { sameDayPairs, type DayPair } from "@/lib/domain/day-pairs";
import { formatMinute } from "@/lib/time";

export type WaitSettings = {
  waitBeforeAppointmentMin: number;
  waitAfterSessionMin: number;
  maxTotalWaitMin: number;
};

/** A trip of the patient on the service date (not cancelled). */
export type PatientDayTrip = {
  id: string;
  direction: TripDirection;
  facilityId: string | null;
  appointmentMinute: number | null;
  readyMinute: number | null;
  /** Planned start of service at each stop; null when the trip is not in a route. */
  plannedPickupMinute: number | null;
  plannedDropoffMinute: number | null;
};

export type ScheduleFit = { fits: true } | { fits: false; reason: string };

type Pair = DayPair<PatientDayTrip>;

/** Waiting budgets: shrunk for a paired trip when the two budgets exceed the total. */
function budgets(trip: PatientDayTrip, pairs: readonly Pair[], s: WaitSettings): { before: number; after: number } {
  const reduce = s.waitBeforeAppointmentMin + s.waitAfterSessionMin > s.maxTotalWaitMin;
  const before = Math.min(s.waitBeforeAppointmentMin, s.maxTotalWaitMin);
  const pairedOutbound = pairs.some((p) => p.outbound.id === trip.id);
  const pairedReturn = pairs.some((p) => p.ret.id === trip.id);
  return {
    before: reduce && pairedOutbound ? before : s.waitBeforeAppointmentMin,
    after: reduce && pairedReturn ? Math.max(0, Math.min(s.waitAfterSessionMin, s.maxTotalWaitMin - before)) : s.waitAfterSessionMin,
  };
}

/** Why the planned stop at the facility is outside the trip's window, or null. Unplanned trips have no problem. */
function windowProblem(trip: PatientDayTrip, pairs: readonly Pair[], s: WaitSettings): string | null {
  const budget = budgets(trip, pairs, s);
  if (trip.direction === "OUTBOUND") {
    const dropoff = trip.plannedDropoffMinute;
    const appointment = trip.appointmentMinute;
    if (dropoff === null || appointment === null) return null;
    if (dropoff > appointment) {
      return `dépose prévue à ${formatMinute(dropoff)}, après le rendez-vous de ${formatMinute(appointment)}`;
    }
    if (appointment - dropoff > budget.before) {
      return `dépose prévue à ${formatMinute(dropoff)}, soit ${appointment - dropoff} min d'attente avant le rendez-vous (${budget.before} min au plus)`;
    }
    return null;
  }
  const pickup = trip.plannedPickupMinute;
  const ready = trip.readyMinute;
  if (pickup === null || ready === null) return null;
  if (pickup < ready) {
    return `prise en charge prévue à ${formatMinute(pickup)}, avant la fin de séance de ${formatMinute(ready)}`;
  }
  if (pickup - ready > budget.after) {
    return `prise en charge prévue à ${formatMinute(pickup)}, soit ${pickup - ready} min d'attente après la séance (${budget.after} min au plus)`;
  }
  return null;
}

function withKeyMinute(trip: PatientDayTrip, minute: number): PatientDayTrip {
  return trip.direction === "OUTBOUND" ? { ...trip, appointmentMinute: minute } : { ...trip, readyMinute: minute };
}

/**
 * Checks the planned times of trip `tripId` (and of its same-day partner) once
 * its key time becomes `minute`. `patientTrips` are the patient's trips of the
 * day, the rescheduled one included with its current values.
 */
export function checkScheduleFit(
  tripId: string,
  minute: number,
  patientTrips: readonly PatientDayTrip[],
  settings: WaitSettings,
): ScheduleFit {
  const trips = patientTrips.map((t) => (t.id === tripId ? withKeyMinute(t, minute) : t));
  const trip = trips.find((t) => t.id === tripId);
  if (!trip) return { fits: false, reason: "course introuvable dans la journée du patient" };
  const plannedAtFacility = trip.direction === "OUTBOUND" ? trip.plannedDropoffMinute : trip.plannedPickupMinute;
  if (plannedAtFacility === null) return { fits: false, reason: "horaire prévu inconnu dans la tournée" };

  const pairs = sameDayPairs(trips);
  const own = windowProblem(trip, pairs, settings);
  if (own) return { fits: false, reason: own };

  const pair = pairs.find((p) => p.outbound.id === tripId || p.ret.id === tripId);
  if (!pair) return { fits: true };
  const partner = pair.outbound.id === tripId ? pair.ret : pair.outbound;
  const partnerProblem = windowProblem(partner, pairs, settings);
  if (partnerProblem) {
    return { fits: false, reason: `${partner.direction === "OUTBOUND" ? "aller" : "retour"} du même jour : ${partnerProblem}` };
  }

  const { outbound, ret } = pair;
  if (
    outbound.plannedDropoffMinute === null ||
    outbound.appointmentMinute === null ||
    ret.plannedPickupMinute === null ||
    ret.readyMinute === null
  ) {
    return { fits: true };
  }
  const total =
    Math.max(0, outbound.appointmentMinute - outbound.plannedDropoffMinute) +
    Math.max(0, ret.plannedPickupMinute - ret.readyMinute);
  if (total > settings.maxTotalWaitMin) {
    return {
      fits: false,
      reason: `attente cumulée aller + retour de ${total} min au lieu de soins (${settings.maxTotalWaitMin} min au plus)`,
    };
  }
  return { fits: true };
}
