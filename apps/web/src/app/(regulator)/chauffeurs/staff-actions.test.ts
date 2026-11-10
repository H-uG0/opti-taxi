import { beforeEach, describe, expect, it, vi } from "vitest";
import { addAbsence, deleteAbsence } from "./staff-actions";
import { IDLE_STATE } from "@/lib/forms";

// Staff actions against a fake Prisma client: the absence and its audit event
// are written together, and the event carries ids only (never the reason).
const fake = vi.hoisted(() => {
  const models = {
    driver: { findUnique: vi.fn() },
    staffAbsence: { create: vi.fn(), deleteMany: vi.fn() },
    route: { findMany: vi.fn() },
    dayCrew: { findMany: vi.fn() },
    trip: { findMany: vi.fn() },
    routeStop: { findMany: vi.fn() },
    auditEvent: { createMany: vi.fn() },
  };
  return { ...models, $transaction: vi.fn(async (fn: (tx: typeof models) => unknown) => fn(models)) };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "u1", name: "Régulation", role: "REGULATOR", driverId: null })),
}));
vi.mock("@/lib/db", () => ({ db: fake }));

const DRIVER = "cmdriver000000000000000001";
const ABSENCE = "cmabsence00000000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  fake.driver.findUnique.mockResolvedValue({ id: DRIVER });
  fake.staffAbsence.create.mockResolvedValue({ id: ABSENCE });
  fake.route.findMany.mockResolvedValue([]);
  fake.dayCrew.findMany.mockResolvedValue([]);
  fake.trip.findMany.mockResolvedValue([]);
  fake.routeStop.findMany.mockResolvedValue([]);
  fake.auditEvent.createMany.mockResolvedValue({ count: 1 });
});

function absenceForm(): FormData {
  const fd = new FormData();
  fd.set("kind", "SICK");
  fd.set("startDate", "2099-01-05");
  fd.set("endDate", "2099-01-09");
  fd.set("note", "Opération du genou");
  return fd;
}

describe("staff actions: audit trail", () => {
  it("traces a new absence in its transaction, without its reason or note", async () => {
    const result = await addAbsence(DRIVER, IDLE_STATE, absenceForm());
    expect(result.status).toBe("success");
    expect(fake.$transaction).toHaveBeenCalledTimes(1);
    const rows = fake.auditEvent.createMany.mock.calls[0]![0].data;
    expect(rows).toEqual([
      expect.objectContaining({
        action: "staff_absence.create",
        entity: "StaffAbsence",
        entityId: ABSENCE,
        details: { driverId: DRIVER },
      }),
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/SICK|genou/);
  });

  it("names the crews fixed with the absent person and the planned days by state", async () => {
    fake.dayCrew.findMany.mockResolvedValue([{ serviceDate: new Date("2099-01-06T00:00:00Z"), vehicle: { label: "VSL 2" } }]);
    fake.route.findMany
      // Routes of the person in the absence.
      .mockResolvedValueOnce([{ serviceDate: new Date("2099-01-05T00:00:00Z") }, { serviceDate: new Date("2099-01-07T00:00:00Z") }])
      // Validated days among them.
      .mockResolvedValueOnce([{ serviceDate: new Date("2099-01-07T00:00:00Z") }]);
    const result = await addAbsence(DRIVER, IDLE_STATE, absenceForm());
    expect(result.message).toBe(
      "Absence enregistrée. Tournées déjà calculées avec cette personne le 05/01/2099\u00a0: relancez l'optimisation de ce jour depuis le planning." +
        " Planning déjà validé le 07/01/2099\u00a0: changez l'équipage de la tournée (planning, panneau du véhicule, «\u202fChanger l'équipage\u202f») ou rouvrez le planning puis relancez l'optimisation." +
        " Équipage fixé avec cette personne\u00a0: VSL 2 le 06/01/2099\u202f; son poste est à remplacer, voir la page Équipages.",
    );
  });

  it("traces a deletion only when a row was deleted", async () => {
    fake.staffAbsence.deleteMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await deleteAbsence(DRIVER, ABSENCE);
    await deleteAbsence(DRIVER, ABSENCE);
    expect(fake.auditEvent.createMany).toHaveBeenCalledTimes(1);
    const [row] = fake.auditEvent.createMany.mock.calls[0]![0].data;
    expect(row).toMatchObject({ action: "staff_absence.delete", entityId: ABSENCE });
  });
});
