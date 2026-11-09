import { describe, expect, it, vi } from "vitest";
import { emailTag } from "./rate-limit";

// The glue of the login throttle: one session.throttled event per block, the
// e-mail only as its tag, however many attempts are refused.
const auditAnonymous = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/audit", () => ({ auditAnonymous }));

describe("throttleLogin", () => {
  it("traces the first refusal of a block only", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    (globalThis as { optiTaxiLoginLimiters?: unknown }).optiTaxiLoginLimiters = undefined;
    const { throttleLogin } = await import("./login-throttle");
    const email = "cible@opti-taxi.test";
    for (let i = 0; i < 5; i++) expect(await throttleLogin(email)).toBeNull();
    for (let i = 0; i < 20; i++) expect(await throttleLogin(email)).toEqual({ retryInMin: 15 });
    expect(auditAnonymous).toHaveBeenCalledTimes(1);
    expect(auditAnonymous).toHaveBeenCalledWith({
      action: "session.throttled",
      entity: "User",
      details: { emailTag: emailTag(email), by: "email", retryInMin: 15 },
    });
    expect(JSON.stringify(auditAnonymous.mock.calls)).not.toContain(email);
  });
});
