import { beforeEach, describe, expect, it, vi } from "vitest";
import { fromIsoDate } from "@/lib/time";
import { loadPatientForTrip, searchTripPatients } from "./actions";

// The patient choice of « Nouvelle course »: searched on the server, traced, never the whole list.
const fake = vi.hoisted(() => ({
  patient: { findMany: vi.fn(), findFirst: vi.fn() },
  facility: { findMany: vi.fn() },
  auditEvent: { createMany: vi.fn() },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "u1", name: "Régulation", role: "REGULATOR", driverId: null })) }));
vi.mock("@/lib/db", () => ({ db: fake }));

function traced() {
  return fake.auditEvent.createMany.mock.calls.flatMap((call) => call[0].data as { action: string; entityId: string | null; details?: unknown }[]);
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.auditEvent.createMany.mockResolvedValue({ count: 1 });
  fake.patient.findMany.mockResolvedValue([
    { id: "p1", firstName: "Chantal", lastName: "Hamidi", city: "Aix-en-Provence", postalCode: "13100", phone: "06 39 98 48 43", mobility: "SEATED" },
  ]);
});

describe("searchTripPatients", () => {
  it("reads nothing while less than 2 characters are typed", async () => {
    expect(await searchTripPatients("h")).toEqual({ status: "short", options: [], more: false });
    expect(await searchTripPatients("   ")).toEqual({ status: "short", options: [], more: false });
    expect(fake.patient.findMany).not.toHaveBeenCalled();
    expect(fake.auditEvent.createMany).not.toHaveBeenCalled();
  });

  it("searches the active patients without accents, by name words or phone digits, and traces the list shown", async () => {
    const answer = await searchTripPatients("Hélène Aix");
    const args = fake.patient.findMany.mock.calls[0]![0];
    expect(args.where).toEqual({ active: true, AND: [{ searchText: { contains: "helene" } }, { searchText: { contains: "aix" } }] });
    expect(args.take).toBe(21);
    expect(answer).toEqual({
      status: "ok",
      more: false,
      options: [{ value: "p1", label: "HAMIDI Chantal", hint: "13100 Aix-en-Provence · 06 39 98 48 43 · Assis" }],
    });
    // The text typed (a name) never goes into the trail.
    expect(traced()).toEqual([expect.objectContaining({ action: "patient_list.view", entityId: null, details: { source: "trip_search", shown: 1 } })]);
    expect(JSON.stringify(traced())).not.toMatch(/helene|aix/i);

    await searchTripPatients("+33 6 39 98");
    expect(fake.patient.findMany.mock.calls[1]![0].where.AND).toEqual([{ searchText: { contains: "063998" } }]);
  });

  it("says when more patients match than shown", async () => {
    fake.patient.findMany.mockResolvedValue(
      Array.from({ length: 21 }, (_, i) => ({ id: `p${i}`, firstName: "Marie", lastName: `Martin${i}`, city: "Gap", postalCode: "05000", phone: null, mobility: "SEATED" })),
    );
    const answer = await searchTripPatients("martin");
    expect(answer.options).toHaveLength(20);
    expect(answer.more).toBe(true);
  });
});

describe("loadPatientForTrip", () => {
  it("loads an active patient's prescriptions and usual facility, traced on the patient", async () => {
    fake.patient.findFirst.mockResolvedValue({
      id: "p1",
      firstName: "Chantal",
      lastName: "Hamidi",
      city: "Aix-en-Provence",
      mobility: "SEATED",
      prescriptions: [
        { id: "pre1", mode: "TAP", sharing: "BOTH", validFrom: fromIsoDate("2026-10-09"), validTo: fromIsoDate("2027-03-01"), prescriber: "Dr Vasseur" },
      ],
      recurrences: [{ facilityId: "f1", weekdays: [1, 3, 5], sessionMinutes: 240, createdAt: new Date("2026-10-09T08:00:00Z") }],
      trips: [],
    });
    fake.facility.findMany.mockResolvedValue([{ id: "f1" }]);

    const patient = await loadPatientForTrip("p1");

    expect(fake.patient.findFirst.mock.calls[0]![0].where).toEqual({ id: "p1", active: true });
    expect(patient).toMatchObject({
      id: "p1",
      label: "HAMIDI Chantal — Aix-en-Provence",
      mobilityLabel: "Assis",
      usualFacilityId: "f1",
      usualSessionMinutes: 240,
      prescriptions: [{ id: "pre1", validFrom: "2026-10-09", validTo: "2027-03-01" }],
    });
    expect(traced()).toEqual([expect.objectContaining({ action: "patient.view", entityId: "p1" })]);
  });

  it("returns nothing for an unknown or deactivated patient, and reads no record for a malformed id", async () => {
    fake.patient.findFirst.mockResolvedValue(null);
    expect(await loadPatientForTrip("p9")).toBeNull();
    expect(await loadPatientForTrip("x".repeat(80))).toBeNull();
    expect(fake.patient.findFirst).toHaveBeenCalledTimes(1);
    expect(fake.auditEvent.createMany).not.toHaveBeenCalled();
  });
});
