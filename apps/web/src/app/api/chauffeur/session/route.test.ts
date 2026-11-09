import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

// The session route: renews a driver's session close to its end (never a revoked one: no current
// user, no renewal) and tells the phone when it ends.
const fake = vi.hoisted(() => ({ getCurrentUser: vi.fn(), renewDriverSession: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ getCurrentUser: fake.getCurrentUser }));
vi.mock("@/lib/auth/session", () => ({ renewDriverSession: fake.renewDriverSession }));

const DRIVER = { id: "u1", name: "Julien Marchetti", role: "DRIVER", driverId: "d1", mustChangePassword: false };

function post(headers: Record<string, string> = {}) {
  return POST(
    new NextRequest("http://localhost:3100/api/chauffeur/session", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3100", host: "localhost:3100", ...headers },
      body: "{}",
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.renewDriverSession.mockResolvedValue(new Date("2026-11-09T19:25:00.000Z"));
});

describe("POST /api/chauffeur/session", () => {
  it("renews the driver's session if needed and says when it ends", async () => {
    fake.getCurrentUser.mockResolvedValue(DRIVER);
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, sessionExpiresAt: "2026-11-09T19:25:00.000Z" });
    expect(fake.renewDriverSession).toHaveBeenCalledWith(DRIVER, expect.any(Date));
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("never renews a session that is not current (expired, revoked) nor a regulator's", async () => {
    fake.getCurrentUser.mockResolvedValue(null);
    expect((await post()).status).toBe(401);
    fake.getCurrentUser.mockResolvedValue({ ...DRIVER, role: "REGULATOR", driverId: null });
    expect((await post()).status).toBe(401);
    expect(fake.renewDriverSession).not.toHaveBeenCalled();
  });

  it("refuses a request from another site", async () => {
    fake.getCurrentUser.mockResolvedValue(DRIVER);
    expect((await post({ origin: "https://evil.example" })).status).toBe(403);
    expect(fake.renewDriverSession).not.toHaveBeenCalled();
  });
});
