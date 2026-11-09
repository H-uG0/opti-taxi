import { describe, expect, it, vi } from "vitest";
import { emailTag } from "./rate-limit";

// The glue of the login throttle: one session.throttled event per block,
// however many attempts are refused; a known account by its id, an unknown
// e-mail by its tag only.
const auditAnonymous = vi.hoisted(() => vi.fn());
const findUnique = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/audit", () => ({ auditAnonymous }));
vi.mock("@/lib/db", () => ({ db: { user: { findUnique } } }));

async function freshThrottle() {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  (globalThis as { optiTaxiLoginLimiters?: unknown }).optiTaxiLoginLimiters = undefined;
  vi.resetModules();
  auditAnonymous.mockClear();
  return (await import("./login-throttle")).throttleLogin;
}

describe("throttleLogin", () => {
  it("traces the first refusal of a block only, a known account by its id and nothing about its e-mail", async () => {
    const throttleLogin = await freshThrottle();
    findUnique.mockResolvedValue({ id: "u-cible" });
    const email = "cible@opti-taxi.test";
    for (let i = 0; i < 5; i++) expect(await throttleLogin(email)).toBeNull();
    for (let i = 0; i < 20; i++) expect(await throttleLogin(email)).toEqual({ retryInMin: 15 });
    expect(auditAnonymous).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(auditAnonymous).toHaveBeenCalledWith({
      action: "session.throttled",
      entity: "User",
      entityId: "u-cible",
      details: { by: "email", retryInMin: 15 },
    });
    expect(JSON.stringify(auditAnonymous.mock.calls)).not.toContain(email);
  });

  it("tags an e-mail that is no account", async () => {
    const throttleLogin = await freshThrottle();
    findUnique.mockResolvedValue(null);
    const email = "inconnu@example.fr";
    for (let i = 0; i < 6; i++) await throttleLogin(email);
    expect(auditAnonymous).toHaveBeenCalledWith({
      action: "session.throttled",
      entity: "User",
      entityId: null,
      details: { emailTag: emailTag(email), by: "email", retryInMin: 15 },
    });
  });
});
