import { beforeEach, describe, expect, it, vi } from "vitest";
import { passwordVersion } from "./session-check";

// requireDriver / requireDriverAccount against a fake session and account:
// a driver with a provisional password is sent to choose their own before any
// roadmap request, and the pages that frame that change still let them in.
const fake = vi.hoisted(() => ({ findUnique: vi.fn(), readSession: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
}));
vi.mock("@/lib/db", () => ({ db: { user: { findUnique: fake.findUnique } } }));
vi.mock("./session", () => ({ readSession: fake.readSession }));

const HASH = "$2b$10$abcdefghijklmnopqrstuuJ0nM2l5f3oXg1yq0p2n7n8j9k0l1m2";

function signedIn(mustChangePassword: boolean) {
  fake.readSession.mockResolvedValue({
    id: "u1",
    name: "Julien Marchetti",
    role: "DRIVER",
    driverId: "d1",
    passwordVersion: passwordVersion(HASH),
    sessionVersion: 2,
  });
  fake.findUnique.mockResolvedValue({
    name: "Julien Marchetti",
    role: "DRIVER",
    active: true,
    driverId: "d1",
    passwordHash: HASH,
    sessionVersion: 2,
    mustChangePassword,
    driver: { active: true },
  });
}

beforeEach(() => vi.clearAllMocks());

describe("driver access with a provisional password", () => {
  it("sends the driver to the password page instead of the roadmap", async () => {
    signedIn(true);
    const { requireDriver } = await import("./index");
    await expect(requireDriver()).rejects.toThrow("redirect:/chauffeur/mot-de-passe");
  });

  it("still lets the layout and the password page through", async () => {
    signedIn(true);
    const { requireDriverAccount } = await import("./index");
    await expect(requireDriverAccount()).resolves.toMatchObject({ id: "u1", driverId: "d1", mustChangePassword: true });
  });

  it("opens the roadmap once the driver has chosen their password", async () => {
    signedIn(false);
    const { requireDriver } = await import("./index");
    await expect(requireDriver()).resolves.toMatchObject({ id: "u1", mustChangePassword: false });
  });
});
