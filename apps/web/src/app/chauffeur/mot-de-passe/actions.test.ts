import { beforeEach, describe, expect, it, vi } from "vitest";
import { changeOwnPassword } from "./actions";
import { IDLE_STATE } from "@/lib/forms";
import { REVOKE_SESSIONS } from "@/lib/auth/revoke";
import { PASSWORD_CHANGED, PASSWORD_SET, WRONG_CURRENT_PASSWORD, WRONG_PROVISIONAL_PASSWORD } from "../_lib/password";

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
const session = vi.hoisted(() => ({ mustChangePassword: true }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "Test/1.0" }) }));
vi.mock("@/lib/auth", () => ({
  requireDriverAccount: vi.fn(async () => ({
    id: "u1",
    name: "Julien Marchetti",
    role: "DRIVER",
    driverId: "d1",
    mustChangePassword: session.mustChangePassword,
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

function events(): Record<string, unknown>[] {
  return fake.auditEvent.createMany.mock.calls.flatMap((call) => call[0].data as Record<string, unknown>[]);
}

beforeEach(() => {
  vi.clearAllMocks();
  session.mustChangePassword = true;
  fake.user.findUnique.mockResolvedValue({ email: "julien.marchetti@opti-taxi.test", passwordHash: "hash(prov)" });
  fake.user.update.mockResolvedValue({ passwordHash: "hash(mon-propre-mdp)", sessionVersion: 4 });
  fake.auditEvent.createMany.mockResolvedValue({ count: 1 });
  fake.throttle.mockResolvedValue(null);
});

describe("changeOwnPassword", () => {
  it("replaces the provisional password, ends every session and opens a new one here", async () => {
    fake.verify.mockResolvedValue(true);
    const state = await changeOwnPassword(IDLE_STATE, form("prov-isoire-1"));
    expect(state).toMatchObject({ status: "success", message: PASSWORD_SET, values: null });
    expect(fake.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { passwordHash: "hash(mon-propre-mdp)", mustChangePassword: false, ...REVOKE_SESSIONS },
      select: { passwordHash: true, sessionVersion: true },
    });
    expect(events()).toEqual([
      expect.objectContaining({ userId: "u1", action: "account.password_change", entity: "User", entityId: "u1" }),
    ]);
    expect(fake.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "u1", mustChangePassword: false }),
      { passwordHash: "hash(mon-propre-mdp)", sessionVersion: 4 },
    );
    expect(fake.succeeded).toHaveBeenCalledWith("julien.marchetti@opti-taxi.test");
  });

  it("speaks of the other devices only when the password was already the driver's own", async () => {
    session.mustChangePassword = false;
    fake.verify.mockResolvedValue(true);
    const state = await changeOwnPassword(IDLE_STATE, form("mon-ancien-mdp"));
    expect(state).toMatchObject({ status: "success", message: PASSWORD_CHANGED });
    expect(PASSWORD_CHANGED).toMatch(/autres appareils/);
    expect(PASSWORD_SET).not.toMatch(/autres appareils/);
  });

  it("refuses a wrong current password without changing anything or echoing it, and traces the attempt", async () => {
    fake.verify.mockResolvedValue(false);
    const state = await changeOwnPassword(IDLE_STATE, form("devine"));
    expect(state).toMatchObject({ status: "error", fieldErrors: { current: WRONG_PROVISIONAL_PASSWORD }, values: null });
    expect(fake.user.update).not.toHaveBeenCalled();
    expect(fake.createSession).not.toHaveBeenCalled();
    expect(fake.throttle).toHaveBeenCalledWith("julien.marchetti@opti-taxi.test");
    expect(events()).toEqual([
      expect.objectContaining({
        userId: "u1",
        action: "account.password_change_failed",
        entity: "User",
        entityId: "u1",
        details: { reason: "wrong_current_password" },
      }),
    ]);
    expect(JSON.stringify(events())).not.toContain("devine");

    session.mustChangePassword = false;
    const voluntary = await changeOwnPassword(IDLE_STATE, form("devine"));
    expect(voluntary.fieldErrors.current).toBe(WRONG_CURRENT_PASSWORD);
  });

  it("is throttled like a sign-in, with a message that sends the driver to the regulation", async () => {
    fake.throttle.mockResolvedValue({ retryInMin: 9 });
    const state = await changeOwnPassword(IDLE_STATE, form("prov-isoire-1"));
    expect(state.message).toMatch(/9 min ou appelez la régulation/);
    expect(fake.verify).not.toHaveBeenCalled();
  });

  it("checks the form before anything else", async () => {
    const state = await changeOwnPassword(IDLE_STATE, form("prov-isoire-1", "court"));
    expect(state.fieldErrors.next).toBe("10 caractères minimum.");
    expect(fake.user.findUnique).not.toHaveBeenCalled();
  });
});
