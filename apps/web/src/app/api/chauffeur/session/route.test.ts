import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

// The session route: renews a driver's session close to its end (never a revoked one: no current
// user, no renewal) and tells the phone when it ends.
const fake = vi.hoisted(() => ({ currentDriverAccount: vi.fn(), renewDriverSession: vi.fn(), driverSessionRenewable: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ currentDriverAccount: fake.currentDriverAccount }));
vi.mock("@/lib/auth/session", () => ({
  renewDriverSession: fake.renewDriverSession,
  driverSessionRenewable: fake.driverSessionRenewable,
}));

const DRIVER = { id: "u1", name: "Julien Marchetti", role: "DRIVER", driverId: "d1", mustChangePassword: false };

function post(headers: Record<string, string> = {}, body: unknown = {}) {
  return POST(
    new NextRequest("http://localhost:3100/api/chauffeur/session", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3100", host: "localhost:3100", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.renewDriverSession.mockResolvedValue(new Date("2026-11-09T19:25:00.000Z"));
  fake.driverSessionRenewable.mockResolvedValue(true);
});

describe("POST /api/chauffeur/session", () => {
  it("renews the driver's session if needed and says when it ends", async () => {
    fake.currentDriverAccount.mockResolvedValue(DRIVER);
    const response = await post({}, { ownerId: "u1" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, sessionExpiresAt: "2026-11-09T19:25:00.000Z", renewable: true });
    expect(fake.renewDriverSession).toHaveBeenCalledWith(DRIVER, expect.any(Date));
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("never renews a session that is not a current driver's (expired, revoked, a regulator's)", async () => {
    fake.currentDriverAccount.mockResolvedValue(null);
    expect((await post()).status).toBe(401);
    expect(fake.renewDriverSession).not.toHaveBeenCalled();
  });

  it("says the session is over for a page of another account (the cookie changed on a shared phone)", async () => {
    fake.currentDriverAccount.mockResolvedValue(DRIVER);
    const response = await post({}, { ownerId: "u2" });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, code: "session" });
    expect(fake.renewDriverSession).not.toHaveBeenCalled();
    // A page that does not say (loaded before the field existed) is answered as before.
    expect((await post({}, "not json")).status).toBe(200);
  });

  it("refuses a request from another site", async () => {
    fake.currentDriverAccount.mockResolvedValue(DRIVER);
    expect((await post({ origin: "https://evil.example" })).status).toBe(403);
    expect(fake.renewDriverSession).not.toHaveBeenCalled();
  });

  it("says when the session will no longer be renewed (7 days after the sign-in)", async () => {
    fake.currentDriverAccount.mockResolvedValue(DRIVER);
    fake.driverSessionRenewable.mockResolvedValue(false);
    expect(await (await post({}, { ownerId: "u1" })).json()).toMatchObject({ ok: true, renewable: false });
  });
});
