/**
 * Same-day (outbound, return) pairs of one patient, matched like the
 * optimizer (services/optimizer/app/model.py, same_day_pairs): shared by the
 * schedule check of a trip (courses/schedule-fit.ts) and the half-served
 * patients of the planning (lib/planning/half-served.ts). Pure module.
 */
import type { TripDirection } from "@prisma/client";

/** What pairing a patient's legs reads of a trip. */
export type DayLeg = {
  id: string;
  direction: TripDirection;
  facilityId: string | null;
  appointmentMinute: number | null;
  readyMinute: number | null;
};

export type DayPair<T extends DayLeg> = { outbound: T; ret: T };

/**
 * Each return (by end of session) takes the latest unmatched outbound whose
 * appointment is not after its end of session, same facility first.
 */
export function sameDayPairs<T extends DayLeg>(trips: readonly T[]): DayPair<T>[] {
  const outbounds = trips.filter((t) => t.direction === "OUTBOUND" && t.appointmentMinute !== null);
  const returns = trips
    .filter((t) => t.direction === "RETURN" && t.readyMinute !== null)
    .sort((a, b) => (a.readyMinute ?? 0) - (b.readyMinute ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const used = new Set<string>();
  const pairs: DayPair<T>[] = [];
  for (const ret of returns) {
    const ready = ret.readyMinute ?? 0;
    let best: T | null = null;
    let bestKey: [number, number] = [-1, -1];
    for (const o of outbounds) {
      if (used.has(o.id) || (o.appointmentMinute ?? 0) > ready) continue;
      const key: [number, number] = [o.facilityId === ret.facilityId ? 1 : 0, o.appointmentMinute ?? 0];
      if (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {
        best = o;
        bestKey = key;
      }
    }
    if (!best) continue;
    used.add(best.id);
    pairs.push({ outbound: best, ret });
  }
  return pairs;
}
