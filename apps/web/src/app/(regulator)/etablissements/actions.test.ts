import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_ACTION_RESULT } from "@/app/(regulator)/patients/_lib/form-state";
import { setFacilityActive } from "./actions";

// The server action runs against a fake Prisma client: these tests check the
// guarded write and the audit events, not the database.
// (vi.hoisted and vi.mock run before the imports above.)
const fake = vi.hoisted(() => {
  const models = {
    facility: { findUnique: vi.fn(), updateMany: vi.fn() },
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

function request(active: boolean): FormData {
  const fd = new FormData();
  fd.set("facilityId", "f1");
  fd.set("active", String(active));
  return fd;
}

function recorded(): { action: string; entityId: string | null }[] {
  return fake.auditEvent.createMany.mock.calls.flatMap((call) =>
    (call[0] as { data: { action: string; entityId: string | null }[] }).data.map(({ action, entityId }) => ({
      action,
      entityId,
    })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.auditEvent.createMany.mockResolvedValue({ count: 1 });
});

describe("setFacilityActive", () => {
  it("reactivates an inactive facility and traces it", async () => {
    fake.facility.updateMany.mockResolvedValue({ count: 1 });

    const result = await setFacilityActive(INITIAL_ACTION_RESULT, request(true));

    expect(fake.facility.updateMany).toHaveBeenCalledWith({ where: { id: "f1", active: false }, data: { active: true } });
    expect(recorded()).toEqual([{ action: "facility.reactivate", entityId: "f1" }]);
    expect(result).toEqual({ ok: true, message: "Établissement réactivé." });
  });

  it("deactivates only an active facility no active recurrence leads to", async () => {
    fake.facility.updateMany.mockResolvedValue({ count: 1 });

    await setFacilityActive(INITIAL_ACTION_RESULT, request(false));

    expect(fake.facility.updateMany).toHaveBeenCalledWith({
      where: { id: "f1", active: true, recurrences: { none: { active: true } } },
      data: { active: false },
    });
    expect(recorded()).toEqual([{ action: "facility.deactivate", entityId: "f1" }]);
  });

  it("writes and traces nothing when the facility was already in that state (stale page, double click)", async () => {
    fake.facility.updateMany.mockResolvedValue({ count: 0 });
    fake.facility.findUnique.mockResolvedValue({ active: true, _count: { recurrences: 0 } });

    const result = await setFacilityActive(INITIAL_ACTION_RESULT, request(true));

    expect(recorded()).toEqual([]);
    expect(result).toEqual({ ok: true, message: "Cet établissement était déjà actif : rien n'a été modifié." });
  });

  it("refuses the deactivation while active recurrences lead to the facility", async () => {
    fake.facility.updateMany.mockResolvedValue({ count: 0 });
    fake.facility.findUnique.mockResolvedValue({ active: true, _count: { recurrences: 2 } });

    const result = await setFacilityActive(INITIAL_ACTION_RESULT, request(false));

    expect(recorded()).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^Désactivation impossible : 2 récurrences actives mènent à cet établissement\./);
  });

  it("reports a facility that no longer exists", async () => {
    fake.facility.updateMany.mockResolvedValue({ count: 0 });
    fake.facility.findUnique.mockResolvedValue(null);

    const result = await setFacilityActive(INITIAL_ACTION_RESULT, request(false));

    expect(recorded()).toEqual([]);
    expect(result).toEqual({ ok: false, message: expect.stringMatching(/^Établissement introuvable/) });
  });
});
