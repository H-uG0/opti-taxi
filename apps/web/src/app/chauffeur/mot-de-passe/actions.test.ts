import { beforeEach, describe, expect, it, vi } from "vitest";
import { changeOwnPassword } from "./actions";
import { IDLE_STATE } from "@/lib/forms";
import { REVOKE_SESSIONS } from "@/lib/auth/revoke";
import { PASSWORD_CHANGED, WRONG_CURRENT_PASSWORD } from "../_lib/password";

// The driver's password change against fakes: the current password is checked
// under the sign-in throttle, the new one ends every session (the provisional
// flag is cleared), the change is traced and this phone gets a fresh session.
const fake = vi.hoisted(() => {
  const models = { user: { findUnique: vi.fn(), update: vi.fn() }, auditEvent: { createMany: vi.fn() } };
  return {
    ...models,
    $transaction: vi.fn(async (fn: (tx: typeof models) => unknown) => fn(models)),
    throttle: vi.fn(),
    succeeded: vi.fn(),
    verify: vi.fn(),
    createSession: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: fake }));
vi.mock("@/lib/auth", () => ({
  requireDriverAccount: vi.fn(async () => ({
    id: "u1",
    name: "Julien Marchetti",
    role: "DRIVER",
    driverId: "d1",
    mustChangePassword: true,
  })),
}));
vi.mock("@/lib/auth/login-throttle", () => ({ throttleLogin: fake.throttle, loginSucceeded: fake.succeeded }));
vi.mock("@/lib/auth/password", () => ({ verifyPassword: fake.verify, hashPassword: async (p: string) => `hash(${p})` }));
vi.mock("@/lib/auth/session", () => ({ createSession: fake.createSession }));

function form(current: string, next = "mon-propre-mdp", confirm = next): FormData {
  const fd = new FormData();
  fd.set("current", current);
  fd.set("next", next);
  fd.set("confirm", confirm);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.user.findUnique.mockResolvedValue({ email: "julien.marchetti@opti-taxi.test", passwordHash: "hash(prov)" });
  fake.user.update.mockResolvedValue({ passwordHash: "hash(mon-propre-mdp)", sessionVersion: 4 });
  fake.auditEvent.createMany.mockResolvedValue({ count: 1 });
  fake.throttle.mockResolvedValue(null);
});

describe("changeOwnPassword", () => {
  it("replaces the provisional password, ends every session and opens a new one here", async () => {
    fake.verify.mockResolvedValue(true);
    const state = await changeOwnPassword(IDLE_STATE, form("prov-isoire-1"));
    expect(state).toMatchObject({ status: "success", message: PASSWORD_CHANGED, values: null });
    expect(fake.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { passwordHash: "hash(mon-propre-mdp)", mustChangePassword: false, ...REVOKE_SESSIONS },
      select: { passwordHash: true, sessionVersion: true },
    });
    expect(fake.auditEvent.createMany.mock.calls[0]![0].data).toEqual([
      expect.objectContaining({ userId: "u1", action: "account.password_change", entity: "User", entityId: "u1" }),
    ]);
    expect(fake.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "u1", mustChangePassword: false }),
      { passwordHash: "hash(mon-propre-mdp)", sessionVersion: 4 },
    );
    expect(fake.succeeded).toHaveBeenCalledWith("julien.marchetti@opti-taxi.test");
  });

  it("refuses a wrong current password without changing anything or echoing it", async () => {
    fake.verify.mockResolvedValue(false);
    const state = await changeOwnPassword(IDLE_STATE, form("devine"));
    expect(state).toMatchObject({ status: "error", fieldErrors: { current: WRONG_CURRENT_PASSWORD }, values: null });
    expect(fake.user.update).not.toHaveBeenCalled();
    expect(fake.createSession).not.toHaveBeenCalled();
    expect(fake.throttle).toHaveBeenCalledWith("julien.marchetti@opti-taxi.test");
  });

  it("is throttled like a sign-in", async () => {
    fake.throttle.mockResolvedValue({ retryInMin: 9 });
    const state = await changeOwnPassword(IDLE_STATE, form("prov-isoire-1"));
    expect(state.message).toMatch(/9 min/);
    expect(fake.verify).not.toHaveBeenCalled();
  });

  it("checks the form before anything else", async () => {
    const state = await changeOwnPassword(IDLE_STATE, form("prov-isoire-1", "court"));
    expect(state.fieldErrors.next).toBe("10 caractères minimum.");
    expect(fake.user.findUnique).not.toHaveBeenCalled();
  });
});
