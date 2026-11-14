/**
 * A day under way, as the optimizer reads it (contract `progress`, contract/README.md « Journée
 * commencée »): the minute of the request and, per stored route, the stops the crew has done with
 * their real times. Sent with every request of today's date (re-optimization, « Où placer »,
 * per-vehicle acceptance): nothing still to do is planned before now, the stops done never change,
 * a patient on board is dropped by their vehicle.
 *
 * Real times of a stop done: « Pris en charge » is tapped with the patient on board (the end of the
 * pickup: its departure), « Déposé » at the start of the dropoff (lot 7, DRV-02). A stop done by its
 * trip's status alone (no timestamp) keeps its planned times. The break of a route counts as taken
 * once its planned start is past.
 *
 * Pure: the caller reads the routes and statuses (place-trip.ts, run-optimization.ts).
 */
import type { StopKind, TripStatus } from "@prisma/client";
import type { DayRequest, DoneStop, Progress } from "@/lib/optimizer/contract";
import { minuteOfDay, todayIso } from "@/lib/time";
import { isStopDone } from "./stop-done";

/** Last minute the contract accepts (the next midnight). */
const MAX_DAY_MINUTE = 2 * 24 * 60;

export type ProgressStop = {
  tripId: string;
  kind: StopKind;
  sequence: number;
  startMinute: number;
  departureMinute: number;
  completedAt: Date | null;
};

export type ProgressRoute = {
  vehicleId: string;
  breakStartMinute: number | null;
  breakEndMinute: number | null;
  stops: readonly ProgressStop[];
};

/** Minute of the day of `instant` on `isoDate` (Europe/Paris), past midnight after it, within the contract's bounds. */
export function minuteOn(instant: Date, isoDate: string): number {
  const own = todayIso(instant);
  const minute = minuteOfDay(instant);
  const shifted = own > isoDate ? minute + 24 * 60 : own < isoDate ? 0 : minute;
  return Math.min(Math.max(shifted, 0), MAX_DAY_MINUTE);
}

type StartedRoute = { vehicleId: string; done: DoneStop[]; breakTaken: { startMin: number; endMin: number } | null };

/** Stop durations of a trip as the request sends them (its own, else the settings'). */
function serviceOf(request: Pick<DayRequest, "trips" | "settings">): (tripId: string, kind: StopKind) => number {
  const trips = new Map(request.trips.map((t) => [t.id, t]));
  return (tripId, kind) => {
    const trip = trips.get(tripId);
    const own = kind === "PICKUP" ? trip?.pickupServiceMin : trip?.dropoffServiceMin;
    return own ?? (kind === "PICKUP" ? request.settings.pickupServiceMin : request.settings.dropoffServiceMin);
  };
}

/**
 * The progress of `isoDate` at `now`, null for another day than today (a later date is planned from
 * the start of every shift; a past one is not planned any more). The stops of trips or vehicles the
 * request does not carry are left out, and a dropoff only follows its pickup done on the same route.
 */
export function buildProgress(args: {
  isoDate: string;
  now: Date;
  routes: readonly ProgressRoute[];
  statusOf: (tripId: string) => TripStatus | undefined;
  request: Pick<DayRequest, "vehicles" | "trips" | "settings">;
}): Progress | null {
  const { isoDate, now, routes, statusOf, request } = args;
  if (isoDate !== todayIso(now)) return null;
  const nowMin = minuteOn(now, isoDate);
  const vehicles = new Set(request.vehicles.map((v) => v.id));
  const trips = new Set(request.trips.map((t) => t.id));
  const service = serviceOf(request);
  const started: StartedRoute[] = [];
  for (const route of routes) {
    if (!vehicles.has(route.vehicleId)) continue;
    const picked = new Set<string>();
    const done: DoneStop[] = [];
    for (const stop of [...route.stops].sort((a, b) => a.sequence - b.sequence)) {
      if (!trips.has(stop.tripId) || !isStopDone(stop, statusOf(stop.tripId))) continue;
      if (stop.kind === "DROPOFF" && !picked.has(stop.tripId)) continue;
      if (stop.kind === "PICKUP") picked.add(stop.tripId);
      let startMin = stop.startMinute;
      let departureMin = stop.departureMinute;
      if (stop.completedAt) {
        const at = minuteOn(stop.completedAt, isoDate);
        const length = service(stop.tripId, stop.kind);
        // « Pris en charge » is tapped patient on board (the departure), « Déposé » on arrival (the start).
        [startMin, departureMin] = stop.kind === "PICKUP" ? [Math.max(0, at - length), at] : [at, Math.min(MAX_DAY_MINUTE, at + length)];
      }
      done.push({ tripId: stop.tripId, kind: stop.kind, startMin, departureMin: Math.max(startMin, departureMin) });
    }
    if (done.length === 0) continue;
    const taken =
      route.breakStartMinute !== null && route.breakEndMinute !== null && route.breakStartMinute <= nowMin && route.breakEndMinute > route.breakStartMinute
        ? { startMin: route.breakStartMinute, endMin: route.breakEndMinute }
        : null;
    started.push({ vehicleId: route.vehicleId, done, breakTaken: taken });
  }
  return { nowMin, routes: started };
}

/** The stops done of a progress, as stopKey-like keys « tripId/KIND ». */
export function doneKeys(progress: Progress | null | undefined): Set<string> {
  return new Set((progress?.routes ?? []).flatMap((route) => route.done.map((stop) => `${stop.tripId}/${stop.kind}`)));
}

/**
 * Whether a plan can still be saved on the routes as they are now (a plan computed earlier, held for
 * the regulator's word): every stop done now is on its vehicle's route in the plan, after none that is
 * still to do. Statuses keep coming in while the regulator reads the changes; the plan stays good as
 * long as no driver did a stop the plan moved away or put later.
 */
export function planHoldsProgress(
  plan: { routes: readonly { vehicleId: string; stops: readonly { tripId: string; kind: StopKind }[] }[] },
  progress: Progress | null | undefined,
): boolean {
  if (!progress) return true;
  const done = new Map<string, string>();
  for (const route of progress.routes ?? []) for (const stop of route.done) done.set(`${stop.tripId}/${stop.kind}`, route.vehicleId);
  const seen = new Set<string>();
  for (const route of plan.routes) {
    let open = false;
    for (const stop of route.stops) {
      const key = `${stop.tripId}/${stop.kind}`;
      const vehicle = done.get(key);
      if (vehicle === undefined) {
        open = true;
        continue;
      }
      if (vehicle !== route.vehicleId || open) return false;
      seen.add(key);
    }
  }
  return seen.size === done.size;
}
