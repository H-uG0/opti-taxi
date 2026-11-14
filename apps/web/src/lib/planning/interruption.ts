/**
 * A vehicle out of service, or its crew unavailable, from a time of the day (DAY-03): what becomes of
 * its route. Pure: the server step (interrupt-route.ts) reads the route and writes the outcome.
 *
 * - What was done stays (the stops done never change).
 * - From now or earlier (a breakdown): every trip not picked up yet leaves the route (« à replacer »);
 *   a patient on board is picked up again where the vehicle last stopped, by a trip of its own (the
 *   continuation), and their trip is closed as interrupted (its pickup stays done on the route).
 * - From a later time (the garage at 14:00, a person leaving at 15:00): the trips planned to end
 *   before then stay, the others leave; a patient on board now stays (dropped before, or the regulator
 *   sees the shift end).
 */
import type { StopKind, TripStatus } from "@prisma/client";
import { formatMinute } from "@/lib/time";
import { isStopDone } from "./stop-done";

export type InterruptStop = {
  id: string;
  tripId: string;
  kind: StopKind;
  sequence: number;
  startMinute: number;
  departureMinute: number;
  completedAt: Date | null;
};

export type InterruptionPlan = {
  keptStopIds: string[];
  removedStopIds: string[];
  /** Trips taken off the route, back without a vehicle (« à replacer »), in route order. */
  detachedTripIds: string[];
  /** Patients on board picked up again by a continuation trip, in route order. */
  interruptedTripIds: string[];
  /** Patients on board kept on the vehicle (an unavailability from a later time). */
  keptOnBoardTripIds: string[];
  /** The last stop done, where a patient on board is picked up again (null: nothing done). */
  lastDoneStopId: string | null;
  /** Departure of the last stop kept (null: none): the route ends there. */
  lastKeptDeparture: number | null;
};

/**
 * What happens to a route whose vehicle (or crew) is unavailable from `fromMinute`, at `nowMinute`
 * (null for a later date: nothing is under way).
 */
export function planInterruption(args: {
  stops: readonly InterruptStop[];
  statusOf: (tripId: string) => TripStatus | undefined;
  fromMinute: number;
  nowMinute: number | null;
}): InterruptionPlan {
  const { statusOf, fromMinute, nowMinute } = args;
  const stops = [...args.stops].sort((a, b) => a.sequence - b.sequence);
  const immediate = nowMinute !== null && fromMinute <= nowMinute;
  const byTrip = new Map<string, { pickup?: InterruptStop; dropoff?: InterruptStop }>();
  for (const stop of stops) {
    const entry = byTrip.get(stop.tripId) ?? {};
    if (stop.kind === "PICKUP") entry.pickup ??= stop;
    else entry.dropoff ??= stop;
    byTrip.set(stop.tripId, entry);
  }
  const done = (stop: InterruptStop | undefined) => stop !== undefined && isStopDone(stop, statusOf(stop.tripId));
  const removed = new Set<string>();
  const detached: string[] = [];
  const interrupted: string[] = [];
  const keptOnBoard: string[] = [];
  for (const [tripId, { pickup, dropoff }] of byTrip) {
    const pickedUp = done(pickup) || done(dropoff);
    const droppedOff = done(dropoff);
    if (pickedUp && droppedOff) continue;
    if (pickedUp) {
      if (immediate) {
        interrupted.push(tripId);
        if (dropoff) removed.add(dropoff.id);
      } else {
        keptOnBoard.push(tripId);
      }
      continue;
    }
    // Not picked up yet: kept only when the route ends it before the unavailability.
    const endsBefore = !immediate && dropoff !== undefined && dropoff.departureMinute <= fromMinute;
    if (endsBefore) continue;
    detached.push(tripId);
    for (const stop of [pickup, dropoff]) if (stop) removed.add(stop.id);
  }
  const kept = stops.filter((stop) => !removed.has(stop.id));
  const lastDone = [...stops].reverse().find((stop) => done(stop)) ?? null;
  return {
    keptStopIds: kept.map((stop) => stop.id),
    removedStopIds: stops.filter((stop) => removed.has(stop.id)).map((stop) => stop.id),
    detachedTripIds: detached,
    interruptedTripIds: interrupted,
    keptOnBoardTripIds: keptOnBoard,
    lastDoneStopId: lastDone?.id ?? null,
    lastKeptDeparture: kept.length > 0 ? Math.max(...kept.map((stop) => stop.departureMinute)) : null,
  };
}

/** Who becomes unavailable: the vehicle itself, its driver, or the crew mate of an ambulance. */
export type InterruptWho = "VEHICLE" | "DRIVER" | "CREW_MATE";

const WHO_TEXT: Record<InterruptWho, string> = {
  VEHICLE: "hors service",
  DRIVER: "sans chauffeur",
  CREW_MATE: "sans équipier",
};

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

/**
 * « Taxi 3 hors service à partir de 11:20 : 2 courses à replacer, 1 patient à bord repris au lieu du dernier
 * arrêt (course de reprise créée). » What the interruption did, for the regulator.
 */
export function interruptionMessage(args: { vehicleLabel: string; who: InterruptWho; fromMinute: number; plan: InterruptionPlan }): string {
  const { vehicleLabel, who, fromMinute, plan } = args;
  const toPlace = plan.detachedTripIds.length + plan.interruptedTripIds.length;
  const parts: string[] = [];
  parts.push(toPlace > 0 ? `${plural(toPlace, "course", "courses")} à replacer` : "aucune course à replacer");
  if (plan.interruptedTripIds.length > 0) {
    parts.push(
      `${plural(plan.interruptedTripIds.length, "patient à bord repris", "patients à bord repris")} au lieu du dernier arrêt (${plural(plan.interruptedTripIds.length, "course de reprise créée", "courses de reprise créées")})`,
    );
  }
  if (plan.keptOnBoardTripIds.length > 0) {
    parts.push(`${plural(plan.keptOnBoardTripIds.length, "patient à bord reste", "patients à bord restent")} jusqu'à sa dépose`);
  }
  return `${vehicleLabel} ${WHO_TEXT[who]} à partir de ${formatMinute(fromMinute)}\u00a0: ${parts.join(", ")}.`;
}
