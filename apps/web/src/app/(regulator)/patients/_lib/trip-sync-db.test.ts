import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { fromIsoDate } from "@/lib/time";
import { CANCEL, EMPTY_SYNC } from "./trip-sync";
import { syncOpenTrips } from "./trip-sync-db";

// trip-sync-db.ts and lib/audit.ts are server modules: the transaction client
// is faked below and the shared Prisma client is never used.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));

const TODAY = "2026-11-03";
const ACTOR = { id: "u1", role: "REGULATOR" as const };

type Stop = { id: string; routeId: string; tripId: string; kind: "PICKUP" | "DROPOFF"; sequence: number; loadAfter: number };

/** A trip row as loadOpenTrips selects it. */
function tripRow(id: string, serviceDate: string, routeId: string | null = null) {
  return {
    id,
    serviceDate: fromIsoDate(serviceDate),
    direction: "OUTBOUND",
    status: routeId ? "ASSIGNED" : "PLANNED",
    payer: "CPAM",
    prescriptionId: "rx1",
    facilityId: "f1",
    allowedVehicleTypes: ["TAXI", "VSL"],
    sharingAllowed: true,
    sharingStatus: "NOT_PROPOSED",
    shared: false,
    appointmentMinute: 540,
    readyMinute: null,
    pickupAddress: "4 avenue Jean Jaurès, 04100 Manosque",
    pickupLat: 43.8297,
    pickupLng: 5.7864,
    dropoffAddress: "Centre de dialyse, 13100 Aix-en-Provence",
    dropoffLat: 43.5263,
    dropoffLng: 5.4454,
    routeId,
    lockedVehicleId: null,
    route: routeId ? { vehicle: { type: "TAXI" } } : null,
    lockedVehicle: null,
    prescription: { validFrom: fromIsoDate("2026-10-01"), validTo: fromIsoDate("2026-12-31") },
  };
}

/** Each trip served alone by its route: a pickup then a dropoff. */
function ownStops(tripId: string, routeId: string): Stop[] {
  return [
    { id: `${tripId}-p`, routeId, tripId, kind: "PICKUP", sequence: 0, loadAfter: 1 },
    { id: `${tripId}-d`, routeId, tripId, kind: "DROPOFF", sequence: 1, loadAfter: 0 },
  ];
}

/**
 * Transaction client faking the calls of syncTrips and removeTripStops. The
 * guarded trip write of the trips in `lostWrites` applies to no row (the trip
 * changed meanwhile).
 */
function fakeTx(rows: ReturnType<typeof tripRow>[], { lostWrites = [] as string[], stops = [] as Stop[] } = {}) {
  const createMany = vi.fn(async (args: { data: unknown[] }) => ({ count: args.data.length }));
  const tripUpdateMany = vi.fn(async (args: { where: { id: unknown } }) => ({
    count: typeof args.where.id === "string" && lostWrites.includes(args.where.id) ? 0 : 1,
  }));
  const tx = {
    trip: { findMany: vi.fn(async () => rows), updateMany: tripUpdateMany },
    routeStop: {
      findMany: vi.fn(async (args: { where: { tripId?: string; routeId?: { in: string[] } } }) => {
        const { tripId, routeId } = args.where;
        if (tripId !== undefined) return stops.filter((s) => s.tripId === tripId).map((s) => ({ routeId: s.routeId }));
        return stops.filter((s) => routeId?.in.includes(s.routeId));
      }),
      deleteMany: vi.fn(async () => ({ count: 2 })),
      update: vi.fn(async () => ({})),
    },
    // Route lock of removeTripStops: every route asked for still exists.
    $queryRaw: vi.fn(async (_sql: TemplateStringsArray, ids: string[]) => ids.map((id) => ({ id }))),
    auditEvent: { createMany },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, createMany, tripUpdateMany };
}

function tripEvent(action: "trip.cancel" | "trip.detach", tripId: string, serviceDate: string) {
  return {
    userId: "u1",
    role: "REGULATOR",
    action,
    entity: "Trip",
    entityId: tripId,
    serviceDate: fromIsoDate(serviceDate),
  };
}

function cancelEvent(tripId: string, serviceDate: string) {
  return tripEvent("trip.cancel", tripId, serviceDate);
}

describe("syncOpenTrips: trace of the trips cancelled", () => {
  it("writes one trip.cancel per cancellation actually applied, in a single createMany", async () => {
    const rows = [tripRow("t1", "2026-11-04"), tripRow("t2", "2026-11-04"), tripRow("t3", "2026-11-05", "r3")];
    const { tx, createMany, tripUpdateMany } = fakeTx(rows, { lostWrites: ["t2"], stops: ownStops("t3", "r3") });
    const leftRoutes = new Set<string>();

    const summary = await syncOpenTrips(tx, { patientId: "p1" }, () => CANCEL, TODAY, leftRoutes, ACTOR);

    expect(summary).toEqual({ updated: 0, cancelled: 2, detached: 1, deferred: 0 });
    expect(leftRoutes).toEqual(new Set(["r3"]));
    // Each write is guarded on what was read.
    expect(tripUpdateMany.mock.calls.map(([args]) => args.where)).toEqual([
      { id: "t1", status: "PLANNED", routeId: null },
      { id: "t2", status: "PLANNED", routeId: null },
      { id: "t3", status: "ASSIGNED", routeId: "r3" },
    ]);
    // t2 changed meanwhile: not cancelled, not traced. Ids and dates only.
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany).toHaveBeenCalledWith({
      data: [cancelEvent("t1", "2026-11-04"), cancelEvent("t3", "2026-11-05")],
    });
  });

  it("writes no event when every guarded write was lost", async () => {
    const { tx, createMany } = fakeTx([tripRow("t1", "2026-11-04")], { lostWrites: ["t1"] });

    const summary = await syncOpenTrips(tx, { patientId: "p1" }, () => CANCEL, TODAY, new Set(), ACTOR);

    expect(summary).toEqual(EMPTY_SYNC);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("traces trip.detach for an updated trip taken off its route, nothing for one only updated", async () => {
    const rows = [tripRow("t1", "2026-11-04"), tripRow("t2", "2026-11-05", "r2")];
    const { tx, createMany } = fakeTx(rows, { stops: ownStops("t2", "r2") });
    const leftRoutes = new Set<string>();
    const home = { address: "12 rue Grande, 04200 Sisteron", lat: 44.195, lng: 5.943 };

    const summary = await syncOpenTrips(tx, { patientId: "p1" }, () => ({ kind: "update", home }), TODAY, leftRoutes, ACTOR);

    expect(summary).toEqual({ updated: 2, cancelled: 0, detached: 1, deferred: 0 });
    expect(leftRoutes).toEqual(new Set(["r2"]));
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany).toHaveBeenCalledWith({ data: [tripEvent("trip.detach", "t2", "2026-11-05")] });
  });

  it("neither writes nor traces a trip of today already in a route (deferred)", async () => {
    const { tx, createMany, tripUpdateMany } = fakeTx([tripRow("t1", TODAY, "r1")], { stops: ownStops("t1", "r1") });

    const summary = await syncOpenTrips(tx, { recurrenceId: "rc1" }, () => CANCEL, TODAY, new Set(), ACTOR);

    expect(summary).toEqual({ ...EMPTY_SYNC, deferred: 1 });
    expect(tripUpdateMany).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });
});
