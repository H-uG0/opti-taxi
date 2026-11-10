import { beforeEach, describe, expect, it, vi } from "vitest";
import { login } from "./actions";
import { emailTag } from "@/lib/auth/rate-limit";
import { WRONG_CREDENTIALS } from "./messages";

// The login action against fakes: which audit events a sign-in leaves, never
// with the e-mail itself. Throttling and sessions are stubbed.
const fake = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  auditEvent: { createMany: vi.fn() },
  throttle: vi.fn(),
  createSession: vi.fn(),
  verifyPassword: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7", "user-agent": "Test/1.0" }),
}));
vi.mock("@/lib/db", () => ({ db: { user: fake.user, auditEvent: fake.auditEvent } }));
vi.mock("@/lib/auth", () => ({
  getCurrentUser: vi.fn(),
  PASSWORD_PAGE: "/chauffeur/mot-de-passe",
  ROLE_HOME: { REGULATOR: "/planning", DRIVER: "/chauffeur" },
}));
vi.mock("@/lib/auth/login-throttle", () => ({ throttleLogin: fake.throttle, loginSucceeded: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ createSession: fake.createSession, deleteSession: vi.fn() }));
vi.mock("@/lib/auth/password", () => ({ hashPassword: async () => "dummy", verifyPassword: fake.verifyPassword }));

const EMAIL = "julien.marchetti@opti-taxi.test";

function credentials(email = EMAIL, password = "mauvais-mot-de-passe"): FormData {
  const fd = new FormData();
  fd.set("email", email);
  fd.set("password", password);
  return fd;
}

const account = {
  id: "u-driver",
  name: "Julien Marchetti",
  role: "DRIVER" as const,
  active: true,
  driverId: "d1",
  passwordHash: "hash",
  sessionVersion: 0,
  mustChangePassword: false,
  driver: { active: true },
};

function events() {
  return fake.auditEvent.createMany.mock.calls.flatMap((call) => call[0].data as Record<string, unknown>[]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
  fake.throttle.mockResolvedValue(null);
  fake.auditEvent.createMany.mockResolvedValue({ count: 1 });
});

describe("login: audit trail of failures", () => {
  it("records a failed sign-in on an unknown e-mail with its tag, the address and no author", async () => {
    fake.user.findUnique.mockResolvedValue(null);
    fake.verifyPassword.mockResolvedValue(false);
    const state = await login({ error: null, email: "" }, credentials());
    expect(state.error).toBe(WRONG_CREDENTIALS);
    expect(events()).toEqual([
      expect.objectContaining({
        userId: null,
        role: null,
        action: "session.login_failed",
        entity: "User",
        entityId: null,
        ip: "203.0.113.7",
        details: { emailTag: emailTag(EMAIL), reason: "unknown_account" },
      }),
    ]);
    expect(JSON.stringify(events())).not.toContain(EMAIL);
  });

  it("records a wrong password on a known account, and a disabled account, with the same answer", async () => {
    fake.user.findUnique.mockResolvedValue(account);
    fake.verifyPassword.mockResolvedValue(false);
    expect((await login({ error: null, email: "" }, credentials())).error).toBe(WRONG_CREDENTIALS);
    fake.user.findUnique.mockResolvedValue({ ...account, active: false });
    fake.verifyPassword.mockResolvedValue(true);
    expect((await login({ error: null, email: "" }, credentials())).error).toBe(WRONG_CREDENTIALS);
    expect(events().map((e) => [e.action, e.entityId, e.details])).toEqual([
      ["session.login_failed", "u-driver", { reason: "wrong_password" }],
      ["session.login_failed", "u-driver", { reason: "inactive" }],
    ]);
    expect(fake.createSession).not.toHaveBeenCalled();
  });

  it("records a successful sign-in under the account, not as a failure", async () => {
    fake.user.findUnique.mockResolvedValue(account);
    fake.verifyPassword.mockResolvedValue(true);
    await expect(login({ error: null, email: "" }, credentials())).rejects.toThrow("redirect:/chauffeur");
    expect(events()).toEqual([
      expect.objectContaining({ userId: "u-driver", actorLabel: "Julien Marchetti", action: "session.login" }),
    ]);
  });

  it("sends a driver with a provisional password to choose their own first", async () => {
    fake.user.findUnique.mockResolvedValue({ ...account, mustChangePassword: true });
    fake.verifyPassword.mockResolvedValue(true);
    await expect(login({ error: null, email: "" }, credentials())).rejects.toThrow("redirect:/chauffeur/mot-de-passe");
    expect(fake.createSession).toHaveBeenCalledWith(expect.objectContaining({ mustChangePassword: true }), expect.anything());
  });

  it("answers a throttled attempt without looking the account up (the throttle traces it)", async () => {
    fake.throttle.mockResolvedValue({ retryInMin: 12 });
    const state = await login({ error: null, email: "" }, credentials());
    expect(state.error).toMatch(/12\u00a0min/);
    expect(fake.user.findUnique).not.toHaveBeenCalled();
  });
});
