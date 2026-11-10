import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  coPassengersFromStops,
  isConcurrentWriteError,
  lockRoutesOfTrips,
  NOTHING_DETACHED,
  planDetach,
  removeTripStops,
  type RouteStopForDetach,
} from "./detach";

function stop(routeId: string, sequence: number, tripId: string, kind: "PICKUP" | "DROPOFF", loadAfter: number): RouteStopForDetach {
  return { id: `${routeId}-${sequence}`, routeId, sequence, tripId, kind, loadAfter };
}

describe("planDetach", () => {
  it("removes the trip's stops, renumbers and reloads the others and unshares the co-passenger left alone", () => {
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
      stopUpdates: [
        { id: "r1-1", sequence: 0, loadAfter: 1 },
        { id: "r1-3", sequence: 1, loadAfter: 0 },
      ],
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
    // Positions 0..3, loads 1, 2, 1, 0: C's dropoff keeps its load but moves up.
    expect(plan.stopUpdates).toEqual([
      { id: "r1-1", sequence: 0, loadAfter: 1 },
      { id: "r1-2", sequence: 1, loadAfter: 2 },
      { id: "r1-4", sequence: 2, loadAfter: 1 },
      { id: "r1-5", sequence: 3, loadAfter: 0 },
    ]);
  });

  it("only renumbers the stops after a trip that travelled alone", () => {
    const plan = planDetach(
      [
        stop("r1", 0, "A", "PICKUP", 1),
        stop("r1", 1, "A", "DROPOFF", 0),
        stop("r1", 2, "B", "PICKUP", 1),
        stop("r1", 3, "B", "DROPOFF", 0),
      ],
      "A",
    );
    expect(plan).toEqual({
      removedStopIds: ["r1-0", "r1-1"],
      stopUpdates: [
        { id: "r1-2", sequence: 0, loadAfter: 1 },
        { id: "r1-3", sequence: 1, loadAfter: 0 },
      ],
      nowAlone: [],
      stillShared: [],
    });
  });

  it("changes nothing when the trip was last in its route", () => {
    const plan = planDetach(
      [
        stop("r1", 0, "B", "PICKUP", 1),
        stop("r1", 1, "B", "DROPOFF", 0),
        stop("r1", 2, "A", "PICKUP", 1),
        stop("r1", 3, "A", "DROPOFF", 0),
      ],
      "A",
    );
    expect(plan).toEqual({ removedStopIds: ["r1-2", "r1-3"], stopUpdates: [], nowAlone: [], stillShared: [] });
  });

  it("closes gaps left by earlier removals, in increasing order so positions never collide", () => {
    const plan = planDetach(
      [stop("r1", 2, "B", "PICKUP", 1), stop("r1", 5, "A", "PICKUP", 2), stop("r1", 7, "B", "DROPOFF", 1), stop("r1", 9, "A", "DROPOFF", 0)],
      "A",
    );
    expect(plan.stopUpdates).toEqual([
      { id: "r1-2", sequence: 0, loadAfter: 1 },
      { id: "r1-7", sequence: 1, loadAfter: 0 },
    ]);
    for (const update of plan.stopUpdates) {
      expect(update.sequence).toBeLessThanOrEqual(Number(update.id.split("-")[1]));
    }
    expect(plan.nowAlone).toEqual(["B"]);
  });

  it("returns an empty plan when the trip has no stop", () => {
    expect(planDetach([stop("r1", 0, "B", "PICKUP", 1), stop("r1", 1, "B", "DROPOFF", 0)], "A")).toEqual({
      removedStopIds: [],
      stopUpdates: [],
      nowAlone: [],
      stillShared: [],
    });
  });
});

describe("coPassengersFromStops", () => {
  it("links the trips on board at the same time, route by route, whatever the input order", () => {
    const map = coPassengersFromStops([
      stop("r1", 3, "B", "DROPOFF", 0),
      stop("r1", 0, "A", "PICKUP", 1),
      stop("r1", 2, "A", "DROPOFF", 1),
      stop("r1", 1, "B", "PICKUP", 2),
      stop("r1", 4, "C", "PICKUP", 1),
      stop("r1", 5, "C", "DROPOFF", 0),
      // Same trips on another route are not co-passengers of r1's.
      stop("r2", 0, "D", "PICKUP", 1),
      stop("r2", 1, "D", "DROPOFF", 0),
    ]);
    expect(Object.fromEntries(map)).toEqual({ A: ["B"], B: ["A"] });
  });
});

// ---------------------------------------------------------------------------
// removeTripStops, against an in-memory stand-in of the transaction client
// ---------------------------------------------------------------------------

function fakeTx(rows: RouteStopForDetach[], existingRoutes: string[]) {
  const calls: string[] = [];
  let stops = [...rows];
  const tx = {
    routeStop: {
      findMany: async ({ where }: { where: { tripId?: string | { in: string[] }; routeId?: { in: string[] } } }) => {
        const { tripId } = where;
        if (typeof tripId === "object") {
          calls.push(`read stops of trips ${tripId.in.join(",")}`);
          return stops.filter((s) => tripId.in.includes(s.tripId));
        }
        calls.push(tripId !== undefined ? `read own stops ${tripId}` : `read stops ${where.routeId?.in.join(",")}`);
        return stops.filter((s) => (tripId !== undefined ? s.tripId === tripId : where.routeId?.in.includes(s.routeId)));
      },
      deleteMany: async ({ where }: { where: { tripId: string } }) => {
        calls.push(`delete ${where.tripId}`);
        stops = stops.filter((s) => s.tripId !== where.tripId);
        return { count: 2 };
      },
      update: async ({ where, data }: { where: { id: string }; data: { sequence: number; loadAfter: number } }) => {
        calls.push(`update ${where.id} -> ${data.sequence}/${data.loadAfter}`);
        return {};
      },
    },
    trip: {
      updateMany: async ({ where, data }: { where: { id: { in: string[] } }; data: Record<string, unknown> }) => {
        calls.push(`trips ${where.id.in.join(",")} shared=${String(data.shared ?? "kept")}`);
        return { count: where.id.in.length };
      },
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(`lock ${strings.join("?").replace(/\s+/g, " ").trim()} [${(values[0] as string[]).join(",")}]`);
      return existingRoutes.filter((id) => (values[0] as string[]).includes(id)).map((id) => ({ id }));
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, calls };
}

describe("removeTripStops", () => {
  const rows = [
    stop("r1", 0, "A", "PICKUP", 1),
    stop("r1", 1, "B", "PICKUP", 2),
    stop("r1", 2, "A", "DROPOFF", 1),
    stop("r1", 3, "B", "DROPOFF", 0),
  ];

  it("locks the routes before reading their stops, then deletes, renumbers and unshares", async () => {
    const { tx, calls } = fakeTx(rows, ["r1"]);
    expect(await removeTripStops(tx, "A")).toEqual({ nowAlone: ["B"], routeIds: ["r1"] });
    expect(calls).toEqual([
      "read own stops A",
      `lock SELECT "id" FROM "Route" WHERE "id" = ANY(?) ORDER BY "id" FOR UPDATE [r1]`,
      "read stops r1",
      "delete A",
      "update r1-1 -> 0/1",
      "update r1-3 -> 1/0",
      "trips B shared=false",
    ]);
  });

  it("does nothing for a trip without stops, or whose route was replaced meanwhile", async () => {
    const empty = fakeTx(rows, ["r1"]);
    expect(await removeTripStops(empty.tx, "Z")).toEqual(NOTHING_DETACHED);
    expect(empty.calls).toEqual(["read own stops Z"]);

    const replaced = fakeTx(rows, []);
    expect(await removeTripStops(replaced.tx, "A")).toEqual(NOTHING_DETACHED);
    expect(replaced.calls).toHaveLength(2);
  });
});

describe("lockRoutesOfTrips", () => {
  it("locks every route of a batch in one statement, in id order", async () => {
    const rows = [stop("r2", 0, "A", "PICKUP", 1), stop("r2", 1, "A", "DROPOFF", 0), stop("r1", 0, "B", "PICKUP", 1), stop("r1", 1, "B", "DROPOFF", 0)];
    const { tx, calls } = fakeTx(rows, ["r1", "r2"]);
    await lockRoutesOfTrips(tx, ["A", "B", "C"]);
    expect(calls).toEqual([
      "read stops of trips A,B,C",
      `lock SELECT "id" FROM "Route" WHERE "id" = ANY(?) ORDER BY "id" FOR UPDATE [r2,r1]`,
    ]);
  });

  it("locks nothing for trips outside any route", async () => {
    const { tx, calls } = fakeTx([], []);
    await lockRoutesOfTrips(tx, ["A"]);
    await lockRoutesOfTrips(tx, []);
    expect(calls).toEqual(["read stops of trips A"]);
  });
});

describe("isConcurrentWriteError", () => {
  const known = (code: string, meta?: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError("conflict", { code, clientVersion: "6.19.3", meta });

  it("recognizes a lost race (taken key, missing row, write conflict or deadlock)", () => {
    for (const code of ["P2002", "P2025", "P2034"]) expect(isConcurrentWriteError(known(code))).toBe(true);
    // A deadlock or a serialization failure on a row lock taken with $queryRaw.
    expect(isConcurrentWriteError(known("P2010", { code: "40P01", message: "ERROR: deadlock detected" }))).toBe(true);
    expect(isConcurrentWriteError(known("P2010", { code: "40001", message: "ERROR: could not serialize access" }))).toBe(true);
  });

  it("lets every other error through", () => {
    expect(isConcurrentWriteError(known("P2010", { code: "22012", message: "ERROR: division by zero" }))).toBe(false);
    expect(isConcurrentWriteError(known("P2010"))).toBe(false);
    expect(isConcurrentWriteError(known("P2003"))).toBe(false);
    expect(isConcurrentWriteError(new Error("P2034"))).toBe(false);
    expect(isConcurrentWriteError(null)).toBe(false);
    expect(isConcurrentWriteError("P2025")).toBe(false);
  });
});
