import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Signing, reading and renewing the session cookie against a fake cookie store: a driver's token
// is re-signed close to its end with the same revocation claims; a regulator's never is.
const jar = vi.hoisted(() => new Map<string, string>());

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (options: { name: string }) => void jar.delete(options.name),
  }),
}));
vi.mock("./secret", () => ({ assertSessionSecret: () => "test-secret-0123456789-abcdefghijklmnopqrstuvwxyz" }));

const { createSession, readSession, renewDriverSession, sessionExpiresAt } = await import("./session");

const HOUR = 3_600_000;
const SIGN_IN = new Date("2026-11-08T18:00:00.000Z"); // 19:00 in Paris, the evening before.
const DRIVER = { id: "u1", name: "Julien Marchetti", role: "DRIVER" as const, driverId: "d1", mustChangePassword: false };
const ACCOUNT = { passwordHash: "$2b$10$hash-of-the-password", sessionVersion: 3 };

beforeEach(() => {
  jar.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SIGN_IN);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("driver session renewal", () => {
  it("signs a token for 12 h", async () => {
    await createSession(DRIVER, ACCOUNT);
    expect(await sessionExpiresAt()).toEqual(new Date(SIGN_IN.getTime() + 12 * HOUR));
  });

  it("leaves a session with more than 5 h left as it is", async () => {
    await createSession(DRIVER, ACCOUNT);
    const token = [...jar.values()][0];
    vi.setSystemTime(new Date(SIGN_IN.getTime() + 6 * HOUR));
    expect(await renewDriverSession(DRIVER)).toEqual(new Date(SIGN_IN.getTime() + 12 * HOUR));
    expect([...jar.values()][0]).toBe(token);
  });

  it("re-signs a driver's session close to its end, keeping its revocation claims", async () => {
    await createSession(DRIVER, ACCOUNT);
    const before = await readSession();
    // 05:30 the next morning: 1 h 30 left.
    const morning = new Date(SIGN_IN.getTime() + 10.5 * HOUR);
    vi.setSystemTime(morning);
    expect(await renewDriverSession(DRIVER)).toEqual(new Date(morning.getTime() + 12 * HOUR));
    expect(await sessionExpiresAt()).toEqual(new Date(morning.getTime() + 12 * HOUR));
    const after = await readSession();
    expect(after).toEqual(before);
    expect(after).toMatchObject({ sessionVersion: 3, passwordVersion: expect.any(String) });
  });

  it("never renews a regulator's session, another account's token, or an expired one", async () => {
    const regulator = { ...DRIVER, id: "u9", role: "REGULATOR" as const, driverId: null };
    await createSession(regulator, ACCOUNT);
    vi.setSystemTime(new Date(SIGN_IN.getTime() + 11 * HOUR));
    expect(await renewDriverSession(regulator)).toEqual(new Date(SIGN_IN.getTime() + 12 * HOUR));

    vi.setSystemTime(SIGN_IN);
    await createSession(DRIVER, ACCOUNT);
    vi.setSystemTime(new Date(SIGN_IN.getTime() + 11 * HOUR));
    expect(await renewDriverSession({ ...DRIVER, id: "u2" })).toBeNull();

    vi.setSystemTime(new Date(SIGN_IN.getTime() + 13 * HOUR));
    expect(await renewDriverSession(DRIVER)).toBeNull();
    expect(await readSession()).toBeNull();
  });
});
