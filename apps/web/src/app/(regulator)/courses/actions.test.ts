import { beforeEach, describe, expect, it, vi } from "vitest";
import { cancelTrip } from "./actions";
import { INITIAL_ACTION_RESULT } from "./trip-form";

// The trips screen actions against a fake Prisma client: which writes are
// guarded, what they write and which audit events are recorded, not the database.
const fake = vi.hoisted(() => {
  const models = {
    trip: { findUnique: vi.fn(), updateMany: vi.fn() },
    routeStop: { findMany: vi.fn() },
    appSettings: { upsert: vi.fn() },
    auditEvent: { createMany: vi.fn() },
  };
  return { ...models, $transaction: vi.fn(async (fn: (tx: typeof models) => unknown) => fn(models)) };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "u1", name: "Régulation", role: "REGULATOR", driverId: null })),
}));
vi.mock("@/lib/db", () => ({ db: fake }));
vi.mock("@/lib/optimizer/client", () => ({ evaluate: vi.fn() }));

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) fd.set(key, value);
  return fd;
}

/** A trip as cancelTrip reads it, on a far service day (never late). */
function tripRow(id: string, direction: "OUTBOUND" | "RETURN", overrides: Record<string, unknown> = {}) {
  return {
    id,
    status: "PLANNED",
    serviceDate: new Date("2099-01-05T00:00:00.000Z"),
    direction,
    patientId: "p1",
    recurrenceId: "rec1",
    facilityId: "f1",
    routeId: null,
    plannedPickupMinute: null,
    appointmentMinute: direction === "OUTBOUND" ? 450 : null,
    readyMinute: direction === "RETURN" ? 690 : null,
    route: null,
    ...overrides,
  };
}

const rows = new Map<string, ReturnType<typeof tripRow>>();

function recorded(): { action: string; entityId: string | null }[] {
  return fake.auditEvent.createMany.mock.calls.flatMap((call) =>
    (call[0] as { data: { action: string; entityId: string | null }[] }).data.map(({ action, entityId }) => ({ action, entityId })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  rows.clear();
  fake.trip.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null);
  fake.trip.updateMany.mockResolvedValue({ count: 1 });
  fake.routeStop.findMany.mockResolvedValue([]);
  fake.appSettings.upsert.mockResolvedValue({ id: 1, lateCancellationHours: 2 });
  fake.auditEvent.createMany.mockResolvedValue({ count: 1 });
});

describe("cancelTrip", () => {
  it("refuses a cancellation without a reason, writing nothing", async () => {
    rows.set("t1", tripRow("t1", "OUTBOUND"));

    const result = await cancelTrip(INITIAL_ACTION_RESULT, form({ tripId: "t1" }));

    expect(result).toEqual({ ok: false, message: "Choisissez le motif de l'annulation." });
    expect(fake.trip.updateMany).not.toHaveBeenCalled();
  });

  it("records the reason, the note, the author and the instant, as a person's cancellation", async () => {
    rows.set("t1", tripRow("t1", "OUTBOUND"));

    const result = await cancelTrip(INITIAL_ACTION_RESULT, form({ tripId: "t1", reason: "HOSPITALIZATION", note: "prévenu par sa fille" }));

    expect(fake.trip.updateMany).toHaveBeenCalledTimes(1);
    const { where, data } = fake.trip.updateMany.mock.calls[0]![0];
    expect(where).toEqual({ id: "t1", status: "PLANNED" });
    expect(data).toMatchObject({
      status: "CANCELLED",
      routeId: null,
      lockedVehicleId: null,
      cancellationReason: "HOSPITALIZATION",
      cancellationOrigin: "USER",
      cancellationNote: "prévenu par sa fille",
      cancelledById: "u1",
      lateCancellation: false,
    });
    expect(data.cancelledAt).toBeInstanceOf(Date);
    expect(recorded()).toEqual([{ action: "trip.cancel", entityId: "t1" }]);
    expect(result).toEqual({ ok: true, message: "Course annulée (hospitalisation)." });
  });

  it("cancels the return of the same care along when the box is ticked, one trace each", async () => {
    rows.set("t1", tripRow("t1", "OUTBOUND"));
    rows.set("t2", tripRow("t2", "RETURN"));

    const result = await cancelTrip(INITIAL_ACTION_RESULT, form({ tripId: "t1", reason: "FACILITY", returnTripId: "t2" }));

    expect(fake.trip.updateMany.mock.calls.map(([args]) => args.where)).toEqual([
      { id: "t1", status: "PLANNED" },
      { id: "t2", status: "PLANNED" },
    ]);
    expect(recorded()).toEqual([
      { action: "trip.cancel", entityId: "t1" },
      { action: "trip.cancel", entityId: "t2" },
    ]);
    expect(result.message).toBe("Aller et retour annulés (séance annulée ou déplacée par l'établissement).");
  });

  it("refuses a return that is not the same care (another patient), cancelling nothing", async () => {
    rows.set("t1", tripRow("t1", "OUTBOUND"));
    rows.set("t9", tripRow("t9", "RETURN", { patientId: "p2" }));

    const result = await cancelTrip(INITIAL_ACTION_RESULT, form({ tripId: "t1", reason: "PATIENT", returnTripId: "t9" }));

    expect(result.ok).toBe(false);
    expect(fake.trip.updateMany).not.toHaveBeenCalled();
  });

  it("marks a cancellation within the setting's hours of the pickup as late", async () => {
    const soon = new Date(Date.now() + 30 * 60_000);
    const paris = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .format(soon)
      .split(":")
      .map(Number) as [number, number];
    const isoDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(soon);
    rows.set(
      "t1",
      tripRow("t1", "OUTBOUND", { serviceDate: new Date(`${isoDate}T00:00:00.000Z`), plannedPickupMinute: paris[0] * 60 + paris[1] }),
    );

    const result = await cancelTrip(INITIAL_ACTION_RESULT, form({ tripId: "t1", reason: "PATIENT" }));

    expect(fake.trip.updateMany.mock.calls[0]![0].data.lateCancellation).toBe(true);
    expect(result.message).toMatch(/Annulation tardive\./);
  });

  it("cancels nothing when the trip changed meanwhile", async () => {
    rows.set("t1", tripRow("t1", "OUTBOUND"));
    fake.trip.updateMany.mockResolvedValue({ count: 0 });

    const result = await cancelTrip(INITIAL_ACTION_RESULT, form({ tripId: "t1", reason: "PATIENT" }));

    expect(result).toEqual({ ok: false, message: "La course a changé entre-temps : rechargez la page." });
    expect(recorded()).toEqual([]);
  });
});
