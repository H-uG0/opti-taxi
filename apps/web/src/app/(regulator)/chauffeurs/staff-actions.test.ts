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

  it("traces a deletion only when a row was deleted", async () => {
    fake.staffAbsence.deleteMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await deleteAbsence(DRIVER, ABSENCE);
    await deleteAbsence(DRIVER, ABSENCE);
    expect(fake.auditEvent.createMany).toHaveBeenCalledTimes(1);
    const [row] = fake.auditEvent.createMany.mock.calls[0]![0].data;
    expect(row).toMatchObject({ action: "staff_absence.delete", entityId: ABSENCE });
  });
});
