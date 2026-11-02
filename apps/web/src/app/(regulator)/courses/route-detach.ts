/**
 * What changes in a route when one trip leaves it (cancelled, or rescheduled
 * out of its planned times). Pure: the server actions apply the plan in a
 * transaction, the tests cover it.
 */
import type { StopKind } from "@prisma/client";
import { coPassengersFromStops } from "./trip-list";

export type RouteStopForDetach = {
  id: string;
  routeId: string;
  tripId: string;
  kind: StopKind;
  sequence: number;
  loadAfter: number;
};

export type DetachPlan = {
  /** Stops of the leaving trip, to delete. */
  removedStopIds: string[];
  /** Remaining stops whose number of patients on board changes. */
  loadUpdates: { id: string; loadAfter: number }[];
  /**
   * Former co-passengers left alone on board: no longer shared (contract:
   * shared = at least one co-passenger), their shared-discounted revenue and
   * their detour no longer hold.
   */
  nowAlone: string[];
  /** Former co-passengers still sharing with someone else: revenue and detour no longer hold. */
  stillShared: string[];
};

/** Patients on board after each stop, route by route, in sequence order. */
function loadsAfter(stops: readonly RouteStopForDetach[]): Map<string, number> {
  const byRoute = new Map<string, RouteStopForDetach[]>();
  for (const stop of stops) {
    const list = byRoute.get(stop.routeId);
    if (list) list.push(stop);
    else byRoute.set(stop.routeId, [stop]);
  }
  const loads = new Map<string, number>();
  for (const routeStops of byRoute.values()) {
    let load = 0;
    for (const stop of [...routeStops].sort((a, b) => a.sequence - b.sequence)) {
      load = stop.kind === "PICKUP" ? load + 1 : Math.max(0, load - 1);
      loads.set(stop.id, load);
    }
  }
  return loads;
}

/**
 * Plan of the removal of `tripId` from the given stops (all the stops of the
 * routes that serve it). The other stops keep their order and planned times;
 * only their load is recomputed. Re-optimizing the day rebuilds everything.
 */
export function planDetach(stops: readonly RouteStopForDetach[], tripId: string): DetachPlan {
  const remaining = stops.filter((stop) => stop.tripId !== tripId);
  const formerCoPassengers = coPassengersFromStops(stops).get(tripId) ?? [];
  const after = coPassengersFromStops(remaining);
  const loads = loadsAfter(remaining);

  return {
    removedStopIds: stops.filter((stop) => stop.tripId === tripId).map((stop) => stop.id),
    loadUpdates: remaining.flatMap((stop) => {
      const load = loads.get(stop.id) ?? 0;
      return load === stop.loadAfter ? [] : [{ id: stop.id, loadAfter: load }];
    }),
    nowAlone: formerCoPassengers.filter((id) => (after.get(id)?.length ?? 0) === 0),
    stillShared: formerCoPassengers.filter((id) => (after.get(id)?.length ?? 0) > 0),
  };
}
