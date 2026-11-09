import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, fromIsoDate, todayIso } from "@/lib/time";
import { completeTrips, reviveOneOffTrips } from "./completion";

// completion.ts against a fake transaction client: what is created, brought
// back and traced, not the database.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));

const ACTOR = { id: "u1", role: "REGULATOR" as const };
const PLACE = { address: "1 rue A", postalCode: "13001", city: "Marseille", lat: 43.3, lng: 5.4 };
const TOMORROW = addDays(todayIso(), 1);

/** A daily recurrence (every weekday), with a prescription valid for a year. */
function recurrence(id = "rec1") {
  return {
    id,
    patientId: "p1",
    facilityId: "f1",
    prescriptionId: "rx1",
    label: "Dialyse",
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    appointmentMinute: 450,
    sessionMinutes: 240,
    legs: "OUTBOUND" as const,
    startDate: fromIsoDate("2020-01-01"),
    endDate: null,
    active: true,
    patient: { ...PLACE, active: true, firstName: "Jean", lastName: "Martin", prescriptions: [] },
    facility: { ...PLACE, name: "Centre" },
    prescription: {
      id: "rx1",
      mode: "TAP" as const,
      sharing: "BOTH" as const,
      validFrom: fromIsoDate("2020-01-01"),
      validTo: fromIsoDate(addDays(todayIso(), 365)),
    },
  };
}

function fakeTx() {
  const tx = {
    recurrence: { findMany: vi.fn() },
    trip: { createManyAndReturn: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    auditEvent: { createMany: vi.fn() },
  };
  tx.recurrence.findMany.mockResolvedValue([recurrence()]);
  tx.trip.createManyAndReturn.mockImplementation(async ({ data }: { data: { serviceDate: Date }[] }) =>
    data.map((t) => ({ serviceDate: t.serviceDate })),
  );
  tx.trip.findMany.mockResolvedValue([]);
  tx.trip.updateMany.mockResolvedValue({ count: 1 });
  tx.auditEvent.createMany.mockResolvedValue({ count: 1 });
  return tx;
}

function events(tx: ReturnType<typeof fakeTx>) {
  return tx.auditEvent.createMany.mock.calls.flatMap(([args]) =>
    (args as { data: { action: string; entityId: string | null; details?: unknown }[] }).data.map(({ action, entityId, details }) => ({
      action,
      entityId,
      details,
    })),
  );
}

let tx: ReturnType<typeof fakeTx>;
beforeEach(() => {
  tx = fakeTx();
});

describe("completeTrips", () => {
  it("creates the missing trips of the range, never before tomorrow, and traces one trip.generate per day", async () => {
    const range = { from: addDays(todayIso(), -3), to: addDays(TOMORROW, 1) };

    const result = await completeTrips(tx as unknown as Prisma.TransactionClient, ACTOR, range, { patientId: "p1" });

    const created = tx.trip.createManyAndReturn.mock.calls[0]![0] as { data: { serviceDate: Date }[]; skipDuplicates: boolean };
    expect(created.skipDuplicates).toBe(true);
    expect(created.data.map((t) => t.serviceDate)).toEqual([fromIsoDate(TOMORROW), fromIsoDate(addDays(TOMORROW, 1))]);
    expect(result.created).toBe(2);
    expect(events(tx)).toEqual([
      { action: "trip.generate", entityId: null, details: { created: 1 } },
      { action: "trip.generate", entityId: null, details: { created: 1 } },
    ]);
    // The caller's filter narrows the recurrences.
    expect(tx.recurrence.findMany.mock.calls[0]![0].where.AND[1]).toEqual({ patientId: "p1" });
  });

  it("does nothing for a range entirely before tomorrow", async () => {
    const result = await completeTrips(tx as unknown as Prisma.TransactionClient, ACTOR, { from: "2020-01-01", to: todayIso() });
    expect(result.created).toBe(0);
    expect(tx.recurrence.findMany).not.toHaveBeenCalled();
  });

  it("names the recurrences whose sessions have no valid prescription", async () => {
    const expired = recurrence();
    expired.prescription.validTo = fromIsoDate("2021-01-01");
    tx.recurrence.findMany.mockResolvedValue([expired]);

    const result = await completeTrips(tx as unknown as Prisma.TransactionClient, ACTOR, { from: TOMORROW, to: TOMORROW });

    expect(result.created).toBe(0);
    expect(result.skipped).toEqual([
      { recurrenceId: "rec1", patientId: "p1", patientName: "MARTIN Jean", label: "Dialyse", dates: [TOMORROW] },
    ]);
  });

  it("brings back a trip the application cancelled once the recurrence plans it again, traced trip.revive", async () => {
    tx.trip.findMany.mockResolvedValue([
      { id: "t-sys", recurrenceId: "rec1", serviceDate: fromIsoDate(TOMORROW), direction: "OUTBOUND", sharingStatus: "REFUSED" },
      // The recurrence has no return leg: this one stays cancelled.
      { id: "t-back", recurrenceId: "rec1", serviceDate: fromIsoDate(TOMORROW), direction: "RETURN", sharingStatus: "NOT_PROPOSED" },
    ]);

    const result = await completeTrips(tx as unknown as Prisma.TransactionClient, ACTOR, { from: TOMORROW, to: TOMORROW });

    // Only the application's cancellations from tomorrow on are looked at.
    const where = tx.trip.findMany.mock.calls[0]![0].where.AND[1];
    expect(where).toMatchObject({ status: "CANCELLED", cancellationOrigin: "SYSTEM", serviceDate: { gte: fromIsoDate(TOMORROW) } });
    expect(tx.trip.updateMany).toHaveBeenCalledTimes(1);
    const { where: guarded, data } = tx.trip.updateMany.mock.calls[0]![0];
    expect(guarded).toEqual({ id: "t-sys", status: "CANCELLED", cancellationOrigin: "SYSTEM" });
    expect(data).toMatchObject({ status: "PLANNED", cancellationOrigin: null, sharingStatus: "REFUSED" });
    expect(result.revived).toBe(1);
    expect(events(tx)).toContainEqual({ action: "trip.revive", entityId: "t-sys", details: undefined });
  });
});

describe("reviveOneOffTrips", () => {
  it("brings back the one-off trips whose cause is gone, and only those", async () => {
    const base = {
      serviceDate: fromIsoDate(TOMORROW),
      direction: "OUTBOUND",
      payer: "PRIVATE",
      sharingStatus: "NOT_ELIGIBLE",
      pickupAddress: "x",
      pickupLat: 1,
      pickupLng: 1,
      dropoffAddress: "Gare",
      dropoffLat: 2,
      dropoffLng: 2,
      prescription: null,
      facility: null,
    };
    tx.trip.findMany.mockResolvedValue([
      { ...base, id: "back", patient: { ...PLACE, active: true } },
      { ...base, id: "still", patient: { ...PLACE, active: false } },
    ]);

    const revived = await reviveOneOffTrips(tx as unknown as Prisma.TransactionClient, ACTOR, { patientId: "p1" });

    expect(revived).toBe(1);
    expect(tx.trip.updateMany.mock.calls.map(([args]) => args.where.id)).toEqual(["back"]);
    expect(tx.trip.findMany.mock.calls[0]![0].where.AND[1]).toMatchObject({ recurrenceId: null, cancellationOrigin: "SYSTEM" });
  });
});
