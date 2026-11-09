/**
 * Outbound and return of a patient's day where only one leg has a vehicle: a
 * patient driven to the facility and not back home (or driven back without
 * having been driven there) is the first thing to fix in « À traiter ». The
 * optimizer avoids it (services/optimizer/app/solver.py, pair disjunction),
 * but when not everything fits, or after a manual change, it can remain.
 * Legs are paired like the optimizer pairs them (same_day_pairs). Pure module,
 * unit-tested.
 */
import type { TripDirection } from "@prisma/client";
import { sameDayPairs } from "@/lib/domain/day-pairs";

export type PairableTrip = {
  id: string;
  patientId: string;
  direction: TripDirection;
  facilityId: string | null;
  appointmentMinute: number | null;
  readyMinute: number | null;
  /** Vehicle of the route the trip is in, null without one. */
  vehicleId: string | null;
};

/** The leg without a vehicle whose other leg has one: its id -> the served leg's id and vehicle. */
export type HalfServed = Map<string, { tripId: string; vehicleId: string }>;

/** `trips`: the day's trips still to carry (cancelled and absent ones left out by the caller). */
export function halfServedPairs(trips: readonly PairableTrip[]): HalfServed {
  const byPatient = new Map<string, PairableTrip[]>();
  for (const trip of trips) byPatient.set(trip.patientId, [...(byPatient.get(trip.patientId) ?? []), trip]);
  const result: HalfServed = new Map();
  const byId = new Map(trips.map((trip) => [trip.id, trip]));
  for (const legs of byPatient.values()) {
    const pairs = sameDayPairs(legs);
    for (const { outbound, ret } of pairs) {
      const [out, back] = [byId.get(outbound.id), byId.get(ret.id)];
      if (!out || !back) continue;
      if (out.vehicleId && !back.vehicleId) result.set(back.id, { tripId: out.id, vehicleId: out.vehicleId });
      if (back.vehicleId && !out.vehicleId) result.set(out.id, { tripId: back.id, vehicleId: back.vehicleId });
    }
  }
  return result;
}
