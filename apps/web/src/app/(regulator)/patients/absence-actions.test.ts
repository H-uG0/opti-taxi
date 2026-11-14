import { beforeEach, describe, expect, it, vi } from "vitest";
import { redirect } from "next/navigation";
import { IDLE_STATE } from "@/lib/forms";
import { addPatientAbsence, deletePatientAbsence, updatePatientAbsence } from "./absence-actions";

// The actions run against a fake Prisma client: these tests check the writes, the cancellations and the trail.
const fake = vi.hoisted(() => {
  const models = {
    patient: { findUnique: vi.fn() },
    patientAbsence: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
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
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
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

/** An open trip of the patient, not in a route, as loadOpenTrips selects it. */
function openTripRow(id: string, serviceDate: string) {
  return {
    id,
    serviceDate: new Date(`${serviceDate}T00:00:00.000Z`),
    occurrenceDate: new Date(`${serviceDate}T00:00:00.000Z`),
    direction: "OUTBOUND",
    status: "PLANNED",
    payer: "CPAM",
    prescriptionId: "rx1",
    facilityId: "f1",
    allowedVehicleTypes: ["TAXI", "VSL"],
    sharingAllowed: true,
    sharingStatus: "NOT_PROPOSED",
    shared: false,
    appointmentMinute: 450,
    readyMinute: null,
    pickupAddress: "4 avenue Jean Jaurès, 04100 Manosque",
    pickupLat: 43.8297,
    pickupLng: 5.7864,
    dropoffAddress: "Centre de dialyse, 13100 Aix-en-Provence",
    dropoffLat: 43.5263,
    dropoffLng: 5.4454,
    oneOffAddress: false,
    notes: null,
    recurrenceId: "r1",
    routeId: null,
    lockedVehicleId: null,
    exceptionalAmbulanceAt: null,
    route: null,
    lockedVehicle: null,
    prescription: { validFrom: new Date("2026-10-01T00:00:00.000Z"), validTo: new Date("2027-03-31T00:00:00.000Z") },
  };
}

function recorded(): { action: string; entityId: string | null; details?: unknown }[] {
  return fake.auditEvent.createMany.mock.calls.flatMap((call) =>
    (call[0] as { data: { action: string; entityId: string | null; details?: unknown }[] }).data.map(({ action, entityId, details }) => ({
      action,
      entityId,
      details,
    })),
  );
}

const ABSENCE = { kind: "HOSPITALIZATION", startDate: "2026-11-16", endDate: "2026-11-18", note: "Service de cardiologie" };

beforeEach(() => {
  vi.clearAllMocks();
  fake.auditEvent.createMany.mockResolvedValue({ count: 1 });
  fake.patient.findUnique.mockResolvedValue({ id: "p1" });
  fake.patientAbsence.findFirst.mockResolvedValue(null);
  fake.patientAbsence.create.mockResolvedValue({ id: "abs1" });
  fake.trip.findMany.mockResolvedValue([]);
  fake.trip.updateMany.mockResolvedValue({ count: 1 });
  fake.completeTrips.mockResolvedValue({ created: 0, revived: 0, createdByDay: new Map(), skipped: [] });
  fake.reviveOneOffTrips.mockResolvedValue(0);
});

describe("addPatientAbsence", () => {
  it("cancels the patient's open trips of those days as the application, with the reason and the dates only", async () => {
    fake.trip.findMany.mockResolvedValueOnce([openTripRow("t1", "2026-11-16"), openTripRow("t2", "2026-11-18")]);

    const state = await addPatientAbsence("p1", IDLE_STATE, form(ABSENCE));

    expect(fake.patientAbsence.create).toHaveBeenCalledWith({
      data: {
        patientId: "p1",
        kind: "HOSPITALIZATION",
        startDate: new Date("2026-11-16T00:00:00.000Z"),
        endDate: new Date("2026-11-18T00:00:00.000Z"),
        note: "Service de cardiologie",
      },
      select: { id: true },
    });
    const loaded = fake.trip.findMany.mock.calls[0]![0].where.AND[0];
    expect(loaded).toEqual({
      patientId: "p1",
      serviceDate: { gte: new Date("2026-11-16T00:00:00.000Z"), lte: new Date("2026-11-18T00:00:00.000Z") },
    });
    const cancel = fake.trip.updateMany.mock.calls[0]![0];
    expect(cancel.where).toEqual({ id: "t1", status: "PLANNED", routeId: null });
    expect(cancel.data).toMatchObject({
      status: "CANCELLED",
      cancellationReason: "HOSPITALIZATION",
      cancellationOrigin: "SYSTEM",
      cancellationNote: "du 16/11/2026 au 18/11/2026",
      cancelledById: "u1",
      lateCancellation: false,
    });
    // The free text never reaches a trip nor the trail.
    expect(JSON.stringify(fake.trip.updateMany.mock.calls)).not.toContain("cardiologie");
    expect(recorded()).toEqual([
      { action: "patient_absence.create", entityId: "abs1", details: { patientId: "p1" } },
      { action: "trip.cancel", entityId: "t1", details: undefined },
      { action: "trip.cancel", entityId: "t2", details: undefined },
    ]);
    expect(fake.completeTrips.mock.calls[0]![3]).toEqual({ patientId: "p1" });
    expect(state).toMatchObject({ status: "success", message: "Absence enregistrée. Courses à venir : 2 annulées." });
  });

  it("gives a holiday the reason « absence du patient », and cancels from today on only", async () => {
    // No open trip; one the application had cancelled for an absence, under another reason.
    fake.trip.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "t7", serviceDate: new Date("2026-11-16T00:00:00.000Z") }]);
    await addPatientAbsence("p1", IDLE_STATE, form({ ...ABSENCE, kind: "HOLIDAY", startDate: "2026-11-10" }));
    const loaded = fake.trip.findMany.mock.calls[0]![0].where.AND[0];
    expect(loaded.serviceDate.gte).toEqual(new Date("2026-11-14T00:00:00.000Z"));
    const stale = fake.trip.findMany.mock.calls[1]![0].where;
    expect(stale).toMatchObject({
      status: "CANCELLED",
      cancellationOrigin: "SYSTEM",
      NOT: { cancellationReason: "PATIENT_ABSENCE", cancellationNote: "du 10/11/2026 au 18/11/2026" },
    });
    const relabel = fake.trip.updateMany.mock.calls.at(-1)![0];
    expect(relabel.data).toEqual({ cancellationReason: "PATIENT_ABSENCE", cancellationNote: "du 10/11/2026 au 18/11/2026" });
    expect(relabel.where).toEqual({ id: { in: ["t7"] }, status: "CANCELLED", cancellationOrigin: "SYSTEM" });
    // Each trip relabelled is traced, with the field names only.
    expect(recorded().at(-1)).toEqual({
      action: "trip.update",
      entityId: "t7",
      details: { fields: ["cancellation_reason", "cancellation_note"], cause: "patient_absence" },
    });
  });

  it("refuses an absence over another one of the patient, without writing", async () => {
    fake.patientAbsence.findFirst.mockResolvedValue({ startDate: new Date("2026-11-17T00:00:00.000Z"), endDate: new Date("2026-11-20T00:00:00.000Z") });
    const state = await addPatientAbsence("p1", IDLE_STATE, form(ABSENCE));
    expect(state.status).toBe("error");
    expect(state.fieldErrors.startDate).toBe("Le patient a déjà une absence du 17/11/2026 au 20/11/2026 : modifiez-la plutôt.");
    expect(fake.patientAbsence.create).not.toHaveBeenCalled();
    expect(recorded()).toEqual([]);
  });
});

describe("updatePatientAbsence and deletePatientAbsence", () => {
  it("cancels only the open trips of the days a change adds: a trip kept on a day already covered stays", async () => {
    fake.patientAbsence.findFirst.mockResolvedValueOnce({
      id: "abs1",
      patientId: "p1",
      startDate: new Date("2026-11-16T00:00:00.000Z"),
      endDate: new Date("2026-11-18T00:00:00.000Z"),
    });
    fake.patientAbsence.updateMany.mockResolvedValue({ count: 1 });

    await updatePatientAbsence("p1", "abs1", IDLE_STATE, form({ ...ABSENCE, endDate: "2026-11-19", note: "Autre service" }));

    const loaded = fake.trip.findMany.mock.calls[0]![0].where.AND[0];
    expect(loaded).toEqual({
      patientId: "p1",
      serviceDate: { gte: new Date("2026-11-16T00:00:00.000Z"), lte: new Date("2026-11-19T00:00:00.000Z") },
      NOT: { serviceDate: { gte: new Date("2026-11-16T00:00:00.000Z"), lte: new Date("2026-11-18T00:00:00.000Z") } },
    });
  });

  it("brings back the trips of the days no longer covered (completion of the horizon, one-off trips)", async () => {
    fake.patientAbsence.findFirst.mockResolvedValueOnce({
      id: "abs1",
      patientId: "p1",
      startDate: new Date("2026-11-16T00:00:00.000Z"),
      endDate: new Date("2026-11-18T00:00:00.000Z"),
    });
    fake.patientAbsence.updateMany.mockResolvedValue({ count: 1 });
    fake.completeTrips.mockResolvedValue({ created: 0, revived: 2, createdByDay: new Map(), skipped: [] });
    fake.reviveOneOffTrips.mockResolvedValue(1);

    const state = await updatePatientAbsence("p1", "abs1", IDLE_STATE, form({ ...ABSENCE, endDate: "2026-11-16" }));

    expect(fake.patientAbsence.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "abs1", patientId: "p1" } }));
    expect(fake.reviveOneOffTrips.mock.calls[0]![2]).toEqual({ patientId: "p1" });
    expect(recorded()[0]).toEqual({ action: "patient_absence.update", entityId: "abs1", details: { patientId: "p1" } });
    expect(state.message).toBe("Absence modifiée. Courses à venir : 3 rétablies.");
  });

  it("deletes the absence and brings its trips back; a second delete changes nothing", async () => {
    fake.patientAbsence.deleteMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    fake.completeTrips.mockResolvedValue({ created: 0, revived: 4, createdByDay: new Map(), skipped: [] });

    await deletePatientAbsence("p1", "abs1");
    // Back to the record, which says what came back (?courses=…).
    expect(redirect).toHaveBeenCalledWith("/patients/p1?enregistre=1&courses=0-0-0-0-0-4#absences");
    expect(recorded()).toEqual([{ action: "patient_absence.delete", entityId: "abs1", details: { patientId: "p1" } }]);

    const again = await deletePatientAbsence("p1", "abs1");
    expect(again.message).toBe("Cette absence était déjà supprimée.");
    expect(fake.completeTrips).toHaveBeenCalledTimes(1);
  });
});
