"use client";

import { useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { filterQuery, parseFilter, sanitizeFilter, type PlanningFilter } from "@/lib/planning/filter";

/**
 * The timeline filter, read from the URL and written back to it with
 * history.replaceState: Next.js keeps useSearchParams in step without a
 * server round trip (the page and its plan.view audit are not reloaded), and
 * the address bar can be bookmarked per depot.
 */
export function usePlanningFilter(depotIds: ReadonlySet<string>): {
  filter: PlanningFilter;
  setFilter: (next: PlanningFilter) => void;
  setTrip: (tripId: string | null) => void;
} {
  const params = useSearchParams();
  const filter = useMemo(() => sanitizeFilter(parseFilter(params), depotIds), [params, depotIds]);
  const setFilter = useCallback((next: PlanningFilter) => {
    const current = new URLSearchParams(window.location.search);
    // State null: Next.js copies its own history state and syncs useSearchParams (a state of its own would skip that).
    window.history.replaceState(null, "", `${window.location.pathname}${filterQuery(current, next)}`);
  }, []);
  // The selected trip follows in the URL: a reload, or the link copied, opens the same trip.
  const setTrip = useCallback((tripId: string | null) => {
    const current = new URLSearchParams(window.location.search);
    if ((current.get("trip") ?? null) === tripId) return;
    if (tripId) current.set("trip", tripId);
    else current.delete("trip");
    const query = current.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }, []);
  return { filter, setFilter, setTrip };
}
