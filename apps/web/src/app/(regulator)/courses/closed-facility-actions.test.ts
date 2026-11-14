import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_ACTION_RESULT } from "@/lib/forms";
import { cancelClosedFacilityTrips } from "./closed-facility-actions";

const fake = vi.hoisted(() => {
  const models = {
    publicHoliday: { findMany: vi.fn() },
    trip: { findMany: vi.fn(), updateMany: vi.fn() },
    routeStop: { findMany: vi.fn(async () => []) },
    auditEvent: { createMany: vi.fn() },
    $queryRaw: vi.fn(async () => []),
  };
  return { ...models, $transaction: vi.fn(async (fn: (tx: typeof models) => unknown) => fn(models)) };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "u1", name: "Régulation", role: "REGULATOR", driverId: null })),
}));
vi.mock("@/lib/db", () => ({ db: fake }));
vi.mock("@/lib/optimizer/client", () => ({ evaluate: vi.fn() }));
vi.mock("@/lib/time", async (original) => ({
  ...(await original<typeof import("@/lib/time")>()),
  todayIso: () => "2026-11-10",
}));
vi.mock("@/lib/planning/detach", async (original) => ({
  ...(await original<typeof import("@/lib/planning/detach")>()),
  lockRoutesOfTrips: vi.fn(async () => undefined),
  removeTripStops: vi.fn(async () => ({ nowAlone: [], routeIds: [] })),
}));

function form(entries: Record<string, string>, tripIds: string[] = []): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) fd.set(key, value);
  for (const id of tripIds) fd.append("tripId", id);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.auditEvent.createMany.mockResolvedValue({ count: 1 });
  fake.trip.updateMany.mockResolvedValue({ count: 1 });
  fake.publicHoliday.findMany.mockResolvedValue([{ date: new Date("2026-11-11T00:00:00.000Z"), label: "Armistice 1918" }]);
});

describe("cancelClosedFacilityTrips (« Annuler ces N courses »)", () => {
  it("reads the trips again and cancels each one as the regulator, « établissement fermé », the holiday as note", async () => {
    const radio = { id: "f1", name: "Radiothérapie", openOnHolidays: false, closures: [] };
    fake.trip.findMany.mockResolvedValue([
      { id: "t1", facility: radio },
      { id: "t2", facility: radio },
    ]);

    const result = await cancelClosedFacilityTrips(INITIAL_ACTION_RESULT, form({ date: "2026-11-11" }, ["t1", "t2"]));

    // Only the facilities closed that day: not working holidays, or under a closure.
    expect(fake.trip.findMany.mock.calls[0]![0].where.facility.OR[0]).toEqual({ openOnHolidays: false });
    expect(fake.trip.updateMany).toHaveBeenCalledTimes(2);
    expect(fake.trip.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { id: "t1", status: { in: ["PLANNED", "ASSIGNED"] } },
      data: {
        status: "CANCELLED",
        cancellationReason: "FACILITY_CLOSED",
        cancellationOrigin: "USER",
        cancellationNote: "jour férié (Armistice 1918)",
        cancelledById: "u1",
        lateCancellation: false,
      },
    });
    const events = fake.auditEvent.createMany.mock.calls.flatMap((c) => (c[0] as { data: { action: string; entityId: string }[] }).data);
    expect(events.map((e) => [e.action, e.entityId])).toEqual([
      ["trip.cancel", "t1"],
      ["trip.cancel", "t2"],
    ]);
    expect(result).toEqual({ ok: true, message: "2 courses annulées (établissement fermé)." });
  });

  it("cancels only the trips the banner showed: never one listed since, and says those no longer to cancel", async () => {
    const radio = { id: "f1", name: "Radiothérapie", openOnHolidays: false, closures: [] };
    const consult = { id: "f2", name: "Consultations", openOnHolidays: false, closures: [] };
    // t3 appeared since the page was shown (its facility unticked « ouvert les jours fériés »); t9 is gone.
    fake.trip.findMany.mockResolvedValue([
      { id: "t1", facility: radio },
      { id: "t3", facility: consult },
    ]);

    const result = await cancelClosedFacilityTrips(INITIAL_ACTION_RESULT, form({ date: "2026-11-11" }, ["t1", "t9"]));

    expect(fake.trip.updateMany.mock.calls.map(([args]) => args.where.id)).toEqual(["t1"]);
    expect(result).toEqual({ ok: true, message: "1 course annulée (établissement fermé). 1 course n'était plus à annuler." });
  });

  it("refuses a past date or no trip posted, and says when nothing is left", async () => {
    expect((await cancelClosedFacilityTrips(INITIAL_ACTION_RESULT, form({ date: "2026-11-09" }, ["t1"]))).ok).toBe(false);
    expect(await cancelClosedFacilityTrips(INITIAL_ACTION_RESULT, form({ date: "2026-11-11" }))).toEqual({
      ok: false,
      message: "Liste de courses invalide\u00a0: rechargez la page.",
    });
    fake.trip.findMany.mockResolvedValue([]);
    const none = await cancelClosedFacilityTrips(INITIAL_ACTION_RESULT, form({ date: "2026-11-11" }, ["t1"]));
    expect(none).toEqual({ ok: false, message: "Plus aucune de ces courses n'est à annuler\u00a0: rechargez la page." });
    expect(fake.trip.updateMany).not.toHaveBeenCalled();
  });
});
