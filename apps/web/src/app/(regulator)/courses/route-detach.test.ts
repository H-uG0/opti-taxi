import { describe, expect, it } from "vitest";
import { planDetach, type RouteStopForDetach } from "./route-detach";

function stop(routeId: string, sequence: number, tripId: string, kind: "PICKUP" | "DROPOFF", loadAfter: number): RouteStopForDetach {
  return { id: `${routeId}-${sequence}`, routeId, sequence, tripId, kind, loadAfter };
}

describe("planDetach", () => {
  it("removes the trip's stops, recomputes the load and unshares the co-passenger left alone", () => {
    const plan = planDetach(
      [
        stop("r1", 0, "A", "PICKUP", 1),
        stop("r1", 1, "B", "PICKUP", 2),
        stop("r1", 2, "A", "DROPOFF", 1),
        stop("r1", 3, "B", "DROPOFF", 0),
        // Another route of the vehicle's day is untouched.
        stop("r2", 0, "C", "PICKUP", 1),
        stop("r2", 1, "D", "PICKUP", 2),
        stop("r2", 2, "C", "DROPOFF", 1),
        stop("r2", 3, "D", "DROPOFF", 0),
      ],
      "A",
    );
    expect(plan).toEqual({
      removedStopIds: ["r1-0", "r1-2"],
      loadUpdates: [{ id: "r1-1", loadAfter: 1 }],
      nowAlone: ["B"],
      stillShared: [],
    });
  });

  it("keeps sharing between the remaining co-passengers", () => {
    const plan = planDetach(
      [
        stop("r1", 0, "A", "PICKUP", 1),
        stop("r1", 1, "B", "PICKUP", 2),
        stop("r1", 2, "C", "PICKUP", 3),
        stop("r1", 3, "A", "DROPOFF", 2),
        stop("r1", 4, "B", "DROPOFF", 1),
        stop("r1", 5, "C", "DROPOFF", 0),
      ],
      "A",
    );
    expect(plan.nowAlone).toEqual([]);
    expect(plan.stillShared.sort()).toEqual(["B", "C"]);
    // Loads become 1, 2, 1, 0: B's dropoff already had 1 patient left on board.
    expect(plan.loadUpdates).toEqual([
      { id: "r1-1", loadAfter: 1 },
      { id: "r1-2", loadAfter: 2 },
    ]);
  });

  it("changes nothing else for a trip that travelled alone", () => {
    const plan = planDetach(
      [
        stop("r1", 0, "A", "PICKUP", 1),
        stop("r1", 1, "A", "DROPOFF", 0),
        stop("r1", 2, "B", "PICKUP", 1),
        stop("r1", 3, "B", "DROPOFF", 0),
      ],
      "A",
    );
    expect(plan).toEqual({ removedStopIds: ["r1-0", "r1-1"], loadUpdates: [], nowAlone: [], stillShared: [] });
  });

  it("returns an empty plan when the trip has no stop", () => {
    expect(planDetach([stop("r1", 0, "B", "PICKUP", 1), stop("r1", 1, "B", "DROPOFF", 0)], "A")).toEqual({
      removedStopIds: [],
      loadUpdates: [],
      nowAlone: [],
      stillShared: [],
    });
  });
});
