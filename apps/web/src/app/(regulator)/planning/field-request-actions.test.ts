import { beforeEach, describe, expect, it, vi } from "vitest";

// The regulator's answer to a crew's request (DAY-05) against a fake Prisma client: « Pris en compte » for a signal,
// « Refuser », « Annuler la course » (the cancellation itself is « Annuler la course » of the trips list) and
// « Créer le retour » (a trip without a vehicle, then « Où placer »), each traced, never twice.
const fake = vi.hoisted(() => {
  const models = {
    fieldRequest: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    trip: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    auditEvent: { createMany: vi.fn() },
  };
  return {
    db: { ...models, $transaction: vi.fn(async (fn: (tx: typeof models) => unknown) => fn(models)) },
    cancelTrip: vi.fn(),
    redirect: vi.fn((url: string) => {
      throw new Error(`REDIRECT ${url}`);
    }),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: fake.redirect }));
vi.mock("@/lib/log", () => ({ logError: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "reg1", name: "Régulation", role: "REGULATOR", driverId: null })) }));
vi.mock("@/lib/db", () => ({ db: fake.db }));
vi.mock("../courses/actions", () => ({ cancelTrip: fake.cancelTrip }));

const { resolveFieldRequest } = await import("./field-request-actions");

const DAY = new Date("2026-11-16T00:00:00.000Z");
const OUTBOUND = {
  id: "t_out",
  serviceDate: DAY,
  status: "DROPPED_OFF",
  direction: "OUTBOUND",
  patientId: "p1",
  recurrenceId: null,
  prescriptionId: "rx1",
  facilityId: "f1",
  payer: "CPAM",
  allowedVehicleTypes: ["TAXI", "VSL"],
  oneOffAddress: false,
  pickupAddress: "Domicile",
  pickupLat: 43.1,
  pickupLng: 5.1,
  dropoffAddress: "Centre",
  dropoffLat: 43.3,
  dropoffLng: 5.4,
  prescription: { mode: "TAP", sharing: "BOTH" },
};

function form(requestId: string, decision: string, extra: Record<string, string> = {}): FormData {
  const data = new FormData();
  data.set("requestId", requestId);
  data.set("decision", decision);
  for (const [name, value] of Object.entries(extra)) data.set(name, value);
  return data;
}

function request(kind: string, extra: Record<string, unknown> = {}) {
  fake.db.fieldRequest.findUnique.mockResolvedValue({ id: "req1", kind, status: "PENDING", tripId: "t_out", readyMinute: null, cancellationReason: null, createdBy: { name: "Julien Marchetti" }, ...extra });
}

const audited = () => fake.db.auditEvent.createMany.mock.calls.flatMap((call) => call[0].data.map((e: { action: string; entityId: string }) => `${e.action}:${e.entityId}`));

beforeEach(() => {
  vi.clearAllMocks();
  fake.db.trip.findUnique.mockResolvedValue(OUTBOUND);
  fake.db.trip.findMany.mockResolvedValue([]);
  fake.db.trip.create.mockResolvedValue({ id: "t_new" });
  fake.db.fieldRequest.updateMany.mockResolvedValue({ count: 1 });
  fake.db.auditEvent.createMany.mockResolvedValue({ count: 1 });
});

describe("resolveFieldRequest", () => {
  it("takes note of an end of session or a next session, traced", async () => {
    request("NEXT_SESSION");
    expect(await resolveFieldRequest({ ok: true, message: null }, form("req1", "note"))).toEqual({ ok: true, message: "Prochaine séance : pris en compte." });
    expect(fake.db.fieldRequest.updateMany).toHaveBeenCalledWith({ where: { id: "req1", status: "PENDING" }, data: expect.objectContaining({ status: "NOTED", resolvedById: "reg1" }) });
    expect(audited()).toEqual(["field_request.note:t_out"]);
    // A request asking for an answer is not « noted ».
    request("CANCEL");
    expect((await resolveFieldRequest({ ok: true, message: null }, form("req1", "note"))).ok).toBe(false);
  });

  it("cancels the trip as « Annuler la course » does, with the crew's reason, then accepts the request", async () => {
    request("CANCEL", { tripId: "t_back", cancellationReason: "HOSPITALIZATION" });
    fake.db.trip.findUnique.mockResolvedValue({ ...OUTBOUND, id: "t_back", direction: "RETURN" });
    fake.cancelTrip.mockResolvedValue({ ok: true, message: "Course annulée et retirée de sa tournée (hospitalisation)." });
    const result = await resolveFieldRequest({ ok: true, message: null }, form("req1", "accept"));
    expect(result).toEqual({ ok: true, message: "Course annulée et retirée de sa tournée (hospitalisation). Demande de l'équipage acceptée." });
    const sent = fake.cancelTrip.mock.calls[0]![1] as FormData;
    expect(Object.fromEntries(sent.entries())).toEqual({ tripId: "t_back", reason: "HOSPITALIZATION", note: "Demandée par l'équipage (Julien Marchetti)." });
    expect(audited()).toEqual(["field_request.accept:t_back"]);
  });

  it("cancels an outbound with its planned return when the regulator was asked so", async () => {
    request("CANCEL", { cancellationReason: "HOSPITALIZATION" });
    fake.db.trip.findUnique.mockResolvedValue({ ...OUTBOUND, status: "ASSIGNED" });
    fake.db.trip.findMany.mockResolvedValue([
      { id: "t_other", status: "ASSIGNED", patientId: "p1", recurrenceId: null, facilityId: "f9" },
      { id: "t_back", status: "ASSIGNED", patientId: "p1", recurrenceId: null, facilityId: "f1" },
    ]);
    fake.cancelTrip.mockResolvedValue({ ok: true, message: "Aller et retour annulés et retirés de leur tournée (hospitalisation)." });
    const result = await resolveFieldRequest({ ok: true, message: null }, form("req1", "accept", { withReturn: "1" }));
    expect(result.ok).toBe(true);
    expect((fake.cancelTrip.mock.calls[0]![1] as FormData).get("returnTripId")).toBe("t_back");
    // Without the question saying so, the return stays.
    fake.cancelTrip.mockClear();
    await resolveFieldRequest({ ok: true, message: null }, form("req1", "accept"));
    expect((fake.cancelTrip.mock.calls[0]![1] as FormData).get("returnTripId")).toBeNull();
  });

  it("gives the request back when the cancellation is refused, and cancels nothing when another regulator answered", async () => {
    request("CANCEL", { cancellationReason: "PATIENT" });
    fake.cancelTrip.mockResolvedValue({ ok: false, message: "Seule une course pas encore commencée peut être annulée." });
    expect(await resolveFieldRequest({ ok: true, message: null }, form("req1", "accept"))).toEqual({ ok: false, message: "Seule une course pas encore commencée peut être annulée." });
    expect(fake.db.fieldRequest.updateMany.mock.calls.map((call) => call[0].data.status)).toEqual(["ACCEPTED", "PENDING"]);
    expect(audited()).toEqual([]);
    // « Refuser » from another regulator first: the request is no longer pending, the trip is left as it is.
    fake.cancelTrip.mockClear();
    fake.db.fieldRequest.updateMany.mockResolvedValue({ count: 0 });
    expect(await resolveFieldRequest({ ok: true, message: null }, form("req1", "accept"))).toEqual({ ok: false, message: "Demande déjà traitée\u00a0: rechargez la page." });
    expect(fake.cancelTrip).not.toHaveBeenCalled();
  });

  it("closes as accepted a request done otherwise meanwhile: the trip cancelled, a return already planned", async () => {
    request("CANCEL", { cancellationReason: "PATIENT" });
    fake.db.trip.findUnique.mockResolvedValue({ ...OUTBOUND, status: "CANCELLED" });
    expect(await resolveFieldRequest({ ok: true, message: null }, form("req1", "accept"))).toEqual({ ok: true, message: "Course déjà annulée\u00a0: demande de l'équipage close." });
    expect(fake.cancelTrip).not.toHaveBeenCalled();
    expect(fake.db.fieldRequest.updateMany).toHaveBeenCalledWith({ where: { id: "req1", status: "PENDING" }, data: expect.objectContaining({ status: "ACCEPTED" }) });
    request("RETURN", { readyMinute: 930 });
    fake.db.trip.findUnique.mockResolvedValue(OUTBOUND);
    fake.db.trip.findMany.mockResolvedValue([{ id: "t_back", status: "ASSIGNED", patientId: "p1", recurrenceId: null, facilityId: "f1" }]);
    expect((await resolveFieldRequest({ ok: true, message: null }, form("req1", "accept"))).message).toBe("Un retour est déjà prévu pour ce patient aujourd'hui\u00a0: demande de l'équipage close.");
    expect(fake.db.trip.create).not.toHaveBeenCalled();
  });

  it("creates the return asked for, without a vehicle, and opens « Où placer » on it", async () => {
    request("RETURN", { readyMinute: 930 });
    await expect(resolveFieldRequest({ ok: true, message: null }, form("req1", "accept"))).rejects.toThrow("REDIRECT /planning?date=2026-11-16&trip=t_new&placer=1");
    expect(fake.db.trip.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ direction: "RETURN", pickupAddress: "Centre", dropoffAddress: "Domicile", readyMinute: 930, sharingAllowed: true, notes: "Retour demandé par l'équipage (Julien Marchetti)." }),
      select: { id: true },
    });
    expect(audited()).toEqual(["trip.create:t_new", "field_request.accept:t_out"]);
  });

  it("answers a request already handled", async () => {
    request("RETURN", { status: "REFUSED" });
    expect(await resolveFieldRequest({ ok: true, message: null }, form("req1", "refuse"))).toEqual({ ok: false, message: "Demande déjà traitée : rechargez la page." });
  });
});
