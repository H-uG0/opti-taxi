import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_STATE } from "@/lib/forms";
import { addFacilityClosure, deleteFacilityClosure } from "./closure-actions";

const fake = vi.hoisted(() => {
  const models = {
    facility: { findUnique: vi.fn() },
    facilityClosure: { create: vi.fn(), deleteMany: vi.fn() },
    trip: { findMany: vi.fn(), updateMany: vi.fn() },
    auditEvent: { createMany: vi.fn() },
    appSettings: { findUnique: vi.fn(async () => ({ tripHorizonDays: 14 })) },
  };
  return {
    ...models,
    $transaction: vi.fn(async (fn: (tx: typeof models) => unknown) => fn(models)),
    completeTrips: vi.fn(),
    reviveOneOffTrips: vi.fn(),
  };
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
  todayIso: () => "2026-11-14",
}));
vi.mock("@/lib/trips/completion", async (original) => ({
  ...(await original<typeof import("@/lib/trips/completion")>()),
  completeTrips: fake.completeTrips,
  reviveOneOffTrips: fake.reviveOneOffTrips,
}));

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) fd.set(key, value);
  return fd;
}

function openTripRow(id: string, serviceDate: string) {
  return {
    id,
    serviceDate: new Date(`${serviceDate}T00:00:00.000Z`),
    occurrenceDate: null,
    direction: "OUTBOUND",
    status: "PLANNED",
    payer: "CPAM",
    prescriptionId: "rx1",
    facilityId: "f1",
    allowedVehicleTypes: ["TAXI", "VSL"],
    sharingAllowed: true,
    sharingStatus: "NOT_PROPOSED",
    shared: false,
    appointmentMinute: 600,
    readyMinute: null,
    pickupAddress: "4 avenue Jean Jaurès, 04100 Manosque",
    pickupLat: 43.8297,
    pickupLng: 5.7864,
    dropoffAddress: "Hôpital de jour, 13100 Aix-en-Provence",
    dropoffLat: 43.5263,
    dropoffLng: 5.4454,
    oneOffAddress: false,
    notes: null,
    recurrenceId: null,
    routeId: null,
    lockedVehicleId: null,
    exceptionalAmbulanceAt: null,
    route: null,
    lockedVehicle: null,
    prescription: null,
  };
}

const actions = () =>
  fake.auditEvent.createMany.mock.calls.flatMap((call) => (call[0] as { data: { action: string; entityId: string | null }[] }).data.map((e) => [e.action, e.entityId]));

beforeEach(() => {
  vi.clearAllMocks();
  fake.auditEvent.createMany.mockResolvedValue({ count: 1 });
  fake.facility.findUnique.mockResolvedValue({ id: "f1" });
  fake.facilityClosure.create.mockResolvedValue({ id: "c1" });
  fake.trip.findMany.mockResolvedValue([]);
  fake.trip.updateMany.mockResolvedValue({ count: 1 });
  fake.completeTrips.mockResolvedValue({ created: 0, revived: 0, createdByDay: new Map(), skipped: [] });
  fake.reviveOneOffTrips.mockResolvedValue(0);
});

describe("facility closures (PAT-03)", () => {
  it("cancels the open trips to or from the facility on its days, as the application, « établissement fermé »", async () => {
    fake.trip.findMany.mockResolvedValue([openTripRow("t1", "2026-11-19")]);

    const state = await addFacilityClosure("f1", IDLE_STATE, form({ startDate: "2026-11-19", endDate: "2026-11-20", note: "Travaux" }));

    expect(fake.trip.findMany.mock.calls[0]![0].where.AND[0]).toEqual({
      facilityId: "f1",
      serviceDate: { gte: new Date("2026-11-19T00:00:00.000Z"), lte: new Date("2026-11-20T00:00:00.000Z") },
    });
    expect(fake.trip.updateMany.mock.calls[0]![0].data).toMatchObject({
      status: "CANCELLED",
      cancellationReason: "FACILITY_CLOSED",
      cancellationOrigin: "SYSTEM",
      cancellationNote: "fermeture du 19/11/2026 au 20/11/2026",
    });
    expect(actions()).toEqual([
      ["facility_closure.create", "c1"],
      ["trip.cancel", "t1"],
    ]);
    expect(fake.completeTrips.mock.calls[0]![3]).toEqual({ facilityId: "f1" });
    expect(state.message).toBe("Fermeture enregistrée. Courses à venir : 1 annulée.");
  });

  it("refuses an end before the start without writing", async () => {
    const state = await addFacilityClosure("f1", IDLE_STATE, form({ startDate: "2026-11-20", endDate: "2026-11-19" }));
    expect(state.status).toBe("error");
    expect(fake.facilityClosure.create).not.toHaveBeenCalled();
  });

  it("brings the trips back when the closure is removed", async () => {
    fake.facilityClosure.deleteMany.mockResolvedValue({ count: 1 });
    fake.completeTrips.mockResolvedValue({ created: 0, revived: 2, createdByDay: new Map(), skipped: [] });
    fake.reviveOneOffTrips.mockResolvedValue(1);

    const state = await deleteFacilityClosure("f1", "c1");

    expect(fake.facilityClosure.deleteMany).toHaveBeenCalledWith({ where: { id: "c1", facilityId: "f1" } });
    expect(fake.reviveOneOffTrips.mock.calls[0]![2]).toEqual({ facilityId: "f1" });
    expect(actions()).toEqual([["facility_closure.delete", "c1"]]);
    expect(state.message).toBe("Fermeture supprimée. Courses à venir : 3 rétablies.");
  });
});
