import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setPatientActive, setRecurrenceActive, updatePatient } from "./actions";
import { INITIAL_ACTION_RESULT, INITIAL_FORM_STATE } from "./_lib/form-state";

// The server actions run against a fake Prisma client: these tests check which
// writes are guarded and which audit events are recorded, not the database.
// (vi.hoisted and vi.mock run before the imports above.)
const fake = vi.hoisted(() => {
  const models = {
    patient: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    recurrence: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    trip: { findMany: vi.fn(), updateMany: vi.fn() },
    auditEvent: { createMany: vi.fn() },
  };
  // Interactive transaction: the callback receives the same models.
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

/** An open trip not yet in a route, as loadOpenTrips (trip-sync-db.ts) selects it. */
function openTripRow(id: string, serviceDate: string) {
  return {
    id,
    serviceDate: new Date(`${serviceDate}T00:00:00.000Z`),
    direction: "OUTBOUND",
    status: "PLANNED",
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
    routeId: null,
    lockedVehicleId: null,
    route: null,
    lockedVehicle: null,
    prescription: { validFrom: new Date("2098-10-01T00:00:00.000Z"), validTo: new Date("2099-12-31T00:00:00.000Z") },
  };
}

type AuditRow = { userId: string; action: string; entityId: string | null };

/** Action and record of every event written by auditEvent.createMany, all by the session user. */
function recorded(): { action: string; entityId: string | null }[] {
  return fake.auditEvent.createMany.mock.calls.flatMap((call) =>
    (call[0] as { data: AuditRow[] }).data.map(({ userId, action, entityId }) => {
      expect(userId).toBe("u1");
      return { action, entityId };
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.auditEvent.createMany.mockResolvedValue({ count: 1 });
  fake.trip.findMany.mockResolvedValue([]);
});

describe("setPatientActive", () => {
  it("deactivates an active patient with no open trip and traces it", async () => {
    fake.patient.updateMany.mockResolvedValue({ count: 1 });

    const result = await setPatientActive(INITIAL_ACTION_RESULT, form({ patientId: "p1", active: "false" }));

    expect(fake.patient.updateMany).toHaveBeenCalledWith({ where: { id: "p1", active: true }, data: { active: false } });
    expect(recorded()).toEqual([{ action: "patient.deactivate", entityId: "p1" }]);
    expect(fake.trip.findMany).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, message: "Patient désactivé." });
  });

  // The fake hands the same models to db and tx: this checks the writes and events, not which client made them.
  it("cancels the open trips of a deactivated patient within its transaction call, one trip.cancel each", async () => {
    fake.patient.updateMany.mockResolvedValue({ count: 1 });
    fake.trip.findMany.mockResolvedValue([openTripRow("t1", "2099-01-05")]);
    fake.trip.updateMany.mockResolvedValue({ count: 1 });

    const result = await setPatientActive(INITIAL_ACTION_RESULT, form({ patientId: "p1", active: "false" }));

    expect(fake.$transaction).toHaveBeenCalledTimes(1);
    expect(fake.trip.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "t1", status: "PLANNED", routeId: null } }));
    expect(recorded()).toEqual([
      { action: "patient.deactivate", entityId: "p1" },
      { action: "trip.cancel", entityId: "t1" },
    ]);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/1 annulée/);
  });

  it("writes and traces nothing when the patient was already deactivated (stale page)", async () => {
    fake.patient.updateMany.mockResolvedValue({ count: 0 });
    fake.patient.findUnique.mockResolvedValue({ id: "p1" });

    const result = await setPatientActive(INITIAL_ACTION_RESULT, form({ patientId: "p1", active: "false" }));

    expect(recorded()).toEqual([]);
    expect(fake.trip.findMany).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, message: "Ce patient était déjà désactivé : rien n'a été modifié." });
  });

  it("reports a patient that no longer exists", async () => {
    fake.patient.updateMany.mockResolvedValue({ count: 0 });
    fake.patient.findUnique.mockResolvedValue(null);

    const result = await setPatientActive(INITIAL_ACTION_RESULT, form({ patientId: "p1", active: "true" }));

    expect(fake.patient.updateMany).toHaveBeenCalledWith({ where: { id: "p1", active: false }, data: { active: true } });
    expect(recorded()).toEqual([]);
    expect(result.ok).toBe(false);
  });
});

describe("setRecurrenceActive", () => {
  beforeEach(() => {
    fake.recurrence.findFirst.mockResolvedValue({ id: "rc1", facility: { name: "Centre de dialyse", active: true } });
  });

  it("deactivates an active recurrence and traces it", async () => {
    fake.recurrence.updateMany.mockResolvedValue({ count: 1 });

    const result = await setRecurrenceActive(
      INITIAL_ACTION_RESULT,
      form({ patientId: "p1", recurrenceId: "rc1", active: "false" }),
    );

    expect(fake.recurrence.updateMany).toHaveBeenCalledWith({ where: { id: "rc1", active: true }, data: { active: false } });
    expect(recorded()).toEqual([{ action: "recurrence.deactivate", entityId: "rc1" }]);
    expect(result).toEqual({ ok: true, message: "Récurrence désactivée." });
  });

  it("writes and traces nothing when it was already active (double click on « Réactiver »)", async () => {
    fake.recurrence.updateMany.mockResolvedValue({ count: 0 });
    fake.recurrence.findUnique.mockResolvedValue({ id: "rc1" });

    const result = await setRecurrenceActive(
      INITIAL_ACTION_RESULT,
      form({ patientId: "p1", recurrenceId: "rc1", active: "true" }),
    );

    expect(recorded()).toEqual([]);
    expect(result).toEqual({ ok: true, message: "Cette récurrence était déjà active : rien n'a été modifié." });
  });
});

describe("updatePatient", () => {
  const home = { address: "4 avenue Jean Jaurès", postalCode: "04100", city: "Manosque", lat: 43.8297, lng: 5.7864 };
  // The form as submitted with « actif » unticked, home unchanged.
  const fields = {
    lastName: "Durand",
    firstName: "Marie",
    phone: "",
    address: home.address,
    postalCode: home.postalCode,
    city: home.city,
    lat: "43.8297",
    lng: "5.7864",
    mobility: "SEATED",
    accessNotes: "",
  };

  beforeEach(() => {
    fake.patient.findUnique.mockResolvedValue({ id: "p1", ...home });
    fake.patient.update.mockResolvedValue({});
  });

  it("traces the deactivation and cancels the trips when this save switches « actif »", async () => {
    fake.patient.updateMany.mockResolvedValue({ count: 1 });

    await updatePatient("p1", INITIAL_FORM_STATE, form(fields));

    expect(fake.patient.updateMany).toHaveBeenCalledWith({ where: { id: "p1", active: true }, data: { active: false } });
    expect(recorded()).toEqual([
      { action: "patient.update", entityId: "p1" },
      { action: "patient.deactivate", entityId: "p1" },
    ]);
    expect(fake.trip.findMany).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith("/patients/p1");
  });

  it("traces the update only when the patient was deactivated meanwhile by someone else", async () => {
    fake.patient.updateMany.mockResolvedValue({ count: 0 });

    await updatePatient("p1", INITIAL_FORM_STATE, form(fields));

    expect(recorded()).toEqual([{ action: "patient.update", entityId: "p1" }]);
    // The other save already cancelled the trips; the home did not move.
    expect(fake.trip.findMany).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith("/patients/p1");
  });
});
