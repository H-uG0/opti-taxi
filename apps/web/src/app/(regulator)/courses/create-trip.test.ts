import { beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, fromIsoDate, todayIso } from "@/lib/time";
import { IDLE_STATE } from "@/lib/forms";
import { createTrip } from "./actions";

// « Nouvelle course » against a fake Prisma client: one leg or both, traced one by one.
const fake = vi.hoisted(() => {
  const models = {
    patient: { findFirst: vi.fn() },
    prescription: { findUnique: vi.fn() },
    facility: { findFirst: vi.fn() },
    trip: { create: vi.fn() },
    auditEvent: { createMany: vi.fn() },
  };
  return {
    ...models,
    $transaction: vi.fn(async (fn: (tx: typeof models) => unknown) => fn(models)),
    redirect: vi.fn((href: string) => {
      throw new Error(`REDIRECT ${href}`);
    }),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: fake.redirect }));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "u1", name: "Régulation", role: "REGULATOR", driverId: null })) }));
vi.mock("@/lib/db", () => ({ db: fake }));
vi.mock("@/lib/optimizer/client", () => ({ evaluate: vi.fn() }));

const DAY = addDays(todayIso(), 2);

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  const base = { patientId: "p1", payer: "CPAM", prescriptionId: "pre1", facilityId: "f1", serviceDate: DAY, time: "14:00", notes: "" };
  for (const [key, value] of Object.entries({ ...base, ...entries })) fd.set(key, value);
  return fd;
}

async function submit(entries: Record<string, string>) {
  try {
    return { state: await createTrip(IDLE_STATE, form(entries)), href: null };
  } catch (error) {
    const match = /^REDIRECT (.*)$/.exec((error as Error).message);
    if (!match) throw error;
    return { state: null, href: match[1]! };
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.patient.findFirst.mockResolvedValue({ id: "p1", address: "4 avenue Jean Jaurès", postalCode: "04100", city: "Manosque", lat: 43.83, lng: 5.79 });
  fake.prescription.findUnique.mockResolvedValue({
    id: "pre1",
    patientId: "p1",
    mode: "TAP",
    sharing: "OUTBOUND",
    validFrom: fromIsoDate("2026-01-01"),
    validTo: fromIsoDate("2099-12-31"),
  });
  fake.facility.findFirst.mockResolvedValue({ id: "f1", address: "1 rue de l'Hôpital", postalCode: "04100", city: "Manosque", lat: 43.84, lng: 5.8 });
  let n = 0;
  fake.trip.create.mockImplementation(async () => ({ id: `t${++n}` }));
  fake.auditEvent.createMany.mockResolvedValue({ count: 1 });
});

describe("createTrip (« Nouvelle course »)", () => {
  it("creates the outbound and the return trips of « Aller et retour », each traced, and opens the list on both", async () => {
    const { href } = await submit({ direction: "BOTH", returnTime: "16:30" });

    const created = fake.trip.create.mock.calls.map((call) => call[0].data);
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({ direction: "OUTBOUND", appointmentMinute: 840, readyMinute: null, sharingAllowed: true });
    expect(created[1]).toMatchObject({
      direction: "RETURN",
      appointmentMinute: null,
      readyMinute: 990,
      sharingAllowed: false,
      pickupAddress: "1 rue de l'Hôpital, 04100 Manosque",
      dropoffAddress: "4 avenue Jean Jaurès, 04100 Manosque",
    });
    const events = fake.auditEvent.createMany.mock.calls.flatMap((call) => call[0].data);
    expect(events.map((e: { action: string; entityId: string }) => [e.action, e.entityId])).toEqual([
      ["trip.create", "t1"],
      ["trip.create", "t2"],
    ]);
    expect(href).toBe(`/courses?date=${DAY}&notice=created&course=t1&retour=t2`);
  });

  it("asks for the end of session of « Aller et retour », after the appointment", async () => {
    const missing = await submit({ direction: "BOTH" });
    expect(missing.state?.fieldErrors.returnTime).toMatch(/fin de séance/);
    const before = await submit({ direction: "BOTH", returnTime: "13:00" });
    expect(before.state?.fieldErrors.returnTime).toMatch(/suivre l'heure du rendez-vous/);
    expect(fake.trip.create).not.toHaveBeenCalled();
  });

  it("still creates one leg", async () => {
    const { href } = await submit({ direction: "RETURN", time: "16:30" });
    expect(fake.trip.create).toHaveBeenCalledTimes(1);
    expect(href).toBe(`/courses?date=${DAY}&notice=created&course=t1`);
  });
});
