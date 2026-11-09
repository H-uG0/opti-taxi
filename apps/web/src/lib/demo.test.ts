import { afterEach, describe, expect, it, vi } from "vitest";
import { checkDemoAccountsAtStartup, DEMO_EMAIL_DOMAIN, demoAccountsProblem, isDemoMode } from "./demo";
import { SEED_EMAIL_DOMAIN } from "../../prisma/seed/identity";

afterEach(() => vi.restoreAllMocks());

describe("isDemoMode", () => {
  it("is on for DEMO_MODE=1 only", () => {
    expect(isDemoMode({ DEMO_MODE: "1" })).toBe(true);
    expect(isDemoMode({ DEMO_MODE: " 1 " })).toBe(true);
    expect(isDemoMode({})).toBe(false);
    expect(isDemoMode({ DEMO_MODE: "0" })).toBe(false);
    expect(isDemoMode({ DEMO_MODE: "true" })).toBe(false);
    expect(isDemoMode({ DEMO_MODE: "" })).toBe(false);
  });

  it("guards the seed's own e-mail domain", () => {
    expect(SEED_EMAIL_DOMAIN).toBe(DEMO_EMAIL_DOMAIN);
  });
});

describe("demoAccountsProblem", () => {
  it("refuses demo accounts in production outside demo mode, without naming them", () => {
    const problem = demoAccountsProblem({ NODE_ENV: "production" }, 4);
    expect(problem).toContain("4 accounts");
    expect(problem).toContain("@opti-taxi.test");
    expect(problem).toContain("DEMO_MODE=1");
    expect(demoAccountsProblem({ NODE_ENV: "production", DEMO_MODE: "0" }, 1)).toContain("1 account ");
  });

  it("lets production start without demo accounts, the demo with them, and development always", () => {
    expect(demoAccountsProblem({ NODE_ENV: "production" }, 0)).toBeNull();
    expect(demoAccountsProblem({ NODE_ENV: "production", DEMO_MODE: "1" }, 30)).toBeNull();
    expect(demoAccountsProblem({ NODE_ENV: "development" }, 30)).toBeNull();
    expect(demoAccountsProblem({}, 30)).toBeNull();
  });
});

describe("checkDemoAccountsAtStartup", () => {
  it("stops a production server that holds demo accounts", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.fn();
    await checkDemoAccountsAtStartup(async () => 2, { NODE_ENV: "production" }, exit);
    expect(exit).toHaveBeenCalledWith(1);
    expect(error.mock.calls.flat().join(" ")).toContain("2 accounts");
  });

  it("does not even query the database in demo mode or in development", async () => {
    const count = vi.fn(async () => 5);
    const exit = vi.fn();
    await checkDemoAccountsAtStartup(count, { NODE_ENV: "production", DEMO_MODE: "1" }, exit);
    await checkDemoAccountsAtStartup(count, { NODE_ENV: "development" }, exit);
    expect(count).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("lets a clean production database start", async () => {
    const exit = vi.fn();
    await checkDemoAccountsAtStartup(async () => 0, { NODE_ENV: "production" }, exit);
    expect(exit).not.toHaveBeenCalled();
  });

  it("stops rather than skip the check when the database cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.fn();
    await checkDemoAccountsAtStartup(async () => Promise.reject(new Error("ECONNREFUSED")), { NODE_ENV: "production" }, exit);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
