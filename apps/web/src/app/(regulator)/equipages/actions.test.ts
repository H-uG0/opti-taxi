import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_STATE } from "@/lib/forms";
import { resolveDayCrews, type DayCrewInput, type SavedCrew, type StaffPerson } from "@/lib/staff/day-crews";
import { saveDayCrews } from "./actions";

// The crew form's writes against a fake Prisma client: version checks, a
// create that collides with a colleague's, a transaction that rolls back as a
// whole, the checks run again under the lock of the date, the reset.
const fake = vi.hoisted(() => {
  const models = {
    route: { count: vi.fn() },
    vehicle: { findMany: vi.fn() },
    dayCrew: { create: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
    auditEvent: { createMany: vi.fn() },
    $executeRaw: vi.fn(),
  };
  const state = { rolledBack: false };
  return {
    ...models,
    state,
    $transaction: vi.fn(async (fn: (tx: typeof models) => unknown) => {
      try {
        return await fn(models);
      } catch (error) {
        state.rolledBack = true;
        throw error;
      }
    }),
  };
});
const loadDayCrewContext = vi.hoisted(() => vi.fn());

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "u1", name: "Régulation", role: "REGULATOR", driverId: null })),
}));
vi.mock("@/lib/db", () => ({ db: fake }));
vi.mock("@/lib/planning/run-optimization", () => ({ replanBlocker: vi.fn(async () => null), PLANNING_TX_OPTIONS: {} }));
vi.mock("@/lib/optimizer/build-request", () => ({ loadDayCrewContext }));

const DATE = "2099-01-05";
const SHOWN = "2099-01-04T10:00:00.000Z";
const LATER = new Date("2099-01-04T10:05:00.000Z");

const person = (id: string): StaffPerson => ({
  id,
  firstName: id,
  lastName: id.toUpperCase(),
  active: true,
  workDays: [1, 2, 3, 4, 5],
  qualifications: ["TAXI_CARD"],
  depotId: "dep",
  shiftStartMinute: 360,
  shiftEndMinute: 1140,
});

const INPUT: DayCrewInput = {
  date: DATE,
  vehicles: [
    { id: "taxiA", label: "Taxi A", type: "TAXI", active: true, depotId: "dep", defaultDriverId: "a", defaultCrewMateId: null },
    { id: "taxiB", label: "Taxi B", type: "TAXI", active: true, depotId: "dep", defaultDriverId: "b", defaultCrewMateId: null },
  ],
  people: ["a", "b", "x", "y"].map(person),
  absences: [],
  incompatibilities: [],
  saved: [],
};

/** The crews of the date with these fixed crews (and their version, author). */
function context(saved: (SavedCrew & { updatedAt?: Date; by?: string })[] = []) {
  const input = { ...INPUT, saved: saved.map(({ vehicleId, driverId, crewMateId }) => ({ vehicleId, driverId, crewMateId })) };
  return {
    input,
    plan: resolveDayCrews(input),
    savedMeta: new Map(
      saved.map((s) => [s.vehicleId, { id: `dc_${s.vehicleId}`, updatedAt: s.updatedAt ?? new Date(SHOWN), updatedBy: s.by ?? null }]),
    ),
    people: new Map(input.people.map((p) => [p.id, p])),
    fleetAlerts: new Map(),
  };
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  fd.set("date", DATE);
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

/** Both taxis as shown with their default drivers; `changes` on top. */
const shownForm = (changes: Record<string, string>, extra: Record<string, string> = {}) =>
  form({ intent: "save", "driver:taxiA": "a", "was-driver:taxiA": "a", "driver:taxiB": "b", "was-driver:taxiB": "b", ...extra, ...changes });

beforeEach(() => {
  vi.clearAllMocks();
  fake.state.rolledBack = false;
  fake.route.count.mockResolvedValue(0);
  fake.vehicle.findMany.mockResolvedValue([{ id: "taxiA" }, { id: "taxiB" }]);
  fake.dayCrew.create.mockImplementation(async ({ data }: { data: { vehicleId: string } }) => ({ id: `dc_${data.vehicleId}` }));
  fake.dayCrew.updateMany.mockResolvedValue({ count: 1 });
  fake.dayCrew.findUnique.mockResolvedValue(null);
  fake.dayCrew.findMany.mockResolvedValue([]);
  fake.dayCrew.deleteMany.mockResolvedValue({ count: 0 });
  fake.auditEvent.createMany.mockResolvedValue({ count: 1 });
  fake.$executeRaw.mockResolvedValue(1);
  loadDayCrewContext.mockResolvedValue(context());
});

describe("saveDayCrews", () => {
  it("fixes the changed row only, under the lock of the date, with its author and an audit event", async () => {
    const result = await saveDayCrews(IDLE_STATE, shownForm({ "driver:taxiA": "x" }));
    expect(result).toMatchObject({ status: "success", message: "Équipage fixé pour ce jour\u202f; les autres véhicules gardent la proposition automatique." });
    expect(fake.$executeRaw).toHaveBeenCalledTimes(1);
    expect(fake.dayCrew.create).toHaveBeenCalledTimes(1);
    expect(fake.dayCrew.create.mock.calls[0]![0].data).toMatchObject({ vehicleId: "taxiA", driverId: "x", crewMateId: null, updatedById: "u1" });
    expect(fake.auditEvent.createMany.mock.calls[0]![0].data).toEqual([
      expect.objectContaining({ action: "day_crew.save", entityId: "dc_taxiA", details: { vehicleId: "taxiA", driverId: "x", crewMateId: null } }),
    ]);
  });

  it("refuses a row a colleague changed since the page was shown, and says who", async () => {
    loadDayCrewContext.mockResolvedValue(context([{ vehicleId: "taxiA", driverId: "y", crewMateId: null, updatedAt: LATER, by: "Marie Dupont" }]));
    const result = await saveDayCrews(
      IDLE_STATE,
      shownForm({ "driver:taxiA": "x" }, { "was-driver:taxiA": "y", "version:taxiA": SHOWN }),
    );
    expect(result.status).toBe("error");
    expect(result.message).toBe("Équipages non enregistrés\u00a0: un collègue a modifié ces véhicules entre-temps.");
    expect(result.fieldErrors["driver:taxiA"]).toMatch(/^Modifié par Marie Dupont le /);
    expect(fake.dayCrew.updateMany).not.toHaveBeenCalled();
  });

  it("reports a colleague who fixed the same proposal at the same moment (unique violation on create)", async () => {
    fake.dayCrew.create.mockRejectedValue(Object.assign(new Error("Unique constraint"), { code: "P2002", meta: { target: ["serviceDate", "vehicleId"] } }));
    fake.dayCrew.findUnique.mockResolvedValue({ updatedAt: LATER, updatedBy: { name: "Paul Martin" } });
    const result = await saveDayCrews(IDLE_STATE, shownForm({ "driver:taxiA": "x" }));
    expect(result.status).toBe("error");
    expect(result.fieldErrors["driver:taxiA"]).toMatch(/^Modifié par Paul Martin le /);
    expect(fake.state.rolledBack).toBe(true);
  });

  it("writes nothing when one of several rows was changed meanwhile (the transaction rolls back)", async () => {
    loadDayCrewContext.mockResolvedValue(
      context([
        { vehicleId: "taxiA", driverId: "a", crewMateId: null },
        { vehicleId: "taxiB", driverId: "b", crewMateId: null },
      ]),
    );
    // Taxi A is written; Taxi B's version is no longer the one shown when the update runs.
    fake.dayCrew.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const result = await saveDayCrews(
      IDLE_STATE,
      shownForm({ "driver:taxiA": "x", "driver:taxiB": "y" }, { "version:taxiA": SHOWN, "version:taxiB": SHOWN }),
    );
    expect(result.status).toBe("error");
    expect(Object.keys(result.fieldErrors)).toEqual(["driver:taxiB"]);
    expect(fake.dayCrew.updateMany).toHaveBeenCalledTimes(2);
    expect(fake.state.rolledBack).toBe(true);
  });

  it("checks again under the lock: a person a colleague fixed elsewhere meanwhile is refused", async () => {
    // The page and the first read: x is free. Under the lock: a colleague has just fixed x on Taxi B.
    loadDayCrewContext.mockResolvedValueOnce(context()).mockResolvedValueOnce(context([{ vehicleId: "taxiB", driverId: "x", crewMateId: null }]));
    const result = await saveDayCrews(IDLE_STATE, shownForm({ "driver:taxiA": "x" }));
    expect(result.status).toBe("error");
    expect(result.fieldErrors).toEqual({
      "driver:taxiA":
        "X x fait déjà partie de l'équipage fixé de Taxi B ce jour\u00a0: revenez d'abord à la proposition sur Taxi B, ou choisissez quelqu'un d'autre.",
    });
    expect(fake.dayCrew.create).not.toHaveBeenCalled();
  });

  it("fixes a proposal as it was shown («\u202fFixer cette proposition\u202f»), whatever the selects say", async () => {
    const result = await saveDayCrews(IDLE_STATE, shownForm({ intent: "fix:taxiB", "driver:taxiA": "x" }));
    expect(result).toMatchObject({ status: "success", message: "Proposition fixée pour ce véhicule\u00a0: elle ne suit plus les absences." });
    expect(fake.dayCrew.create).toHaveBeenCalledTimes(1);
    expect(fake.dayCrew.create.mock.calls[0]![0].data).toMatchObject({ vehicleId: "taxiB", driverId: "b" });
  });
});

describe("«\u202fRevenir aux propositions (tout le jour)\u202f»", () => {
  it("removes only the fixed crews at the version the page showed, and names those kept", async () => {
    fake.dayCrew.deleteMany.mockResolvedValue({ count: 1 });
    // Taxi B was fixed by a colleague after the page was shown: kept.
    fake.dayCrew.findMany.mockResolvedValue([{ vehicleId: "taxiB", updatedAt: LATER, updatedBy: { name: "Marie Dupont" } }]);
    const result = await saveDayCrews(IDLE_STATE, form({ intent: "reset", "version:taxiA": SHOWN, "version:taxiB": "" }));
    expect(fake.dayCrew.deleteMany).toHaveBeenCalledWith({
      where: { serviceDate: new Date(`${DATE}T00:00:00.000Z`), OR: [{ vehicleId: "taxiA", updatedAt: new Date(SHOWN) }] },
    });
    expect(result.status).toBe("error");
    expect(result.message).toBe(
      "1 équipage remis aux propositions automatiques\u202f; 1 équipage fixé gardé\u00a0: un collègue l'a fixé ou modifié depuis l'affichage de la page.",
    );
    expect(result.fieldErrors["driver:taxiB"]).toMatch(/^Modifié par Marie Dupont le /);
  });
});
