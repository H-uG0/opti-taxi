import { describe, expect, it, vi } from "vitest";
import { checkSessionSecretAtStartup } from "./startup";

const GOOD = "q3J9vX2mL8pR4tY7wZ1cB6nH0kD5fG2sA9eU3iO8lQ4"; // 43 characters

describe("checkSessionSecretAtStartup", () => {
  it("lets a fit secret through without exiting", () => {
    const exit = vi.fn();
    expect(() => checkSessionSecretAtStartup({ SESSION_SECRET: GOOD, NODE_ENV: "production" }, exit)).not.toThrow();
    expect(exit).not.toHaveBeenCalled();
  });

  it("stops the process in production, logging the rule but never the secret", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.fn();
    const placeholder = "change-me-dev-only-secret-at-least-32-chars";
    expect(() => checkSessionSecretAtStartup({ SESSION_SECRET: placeholder, NODE_ENV: "production" }, exit)).toThrow(/change-me/);
    expect(exit).toHaveBeenCalledWith(1);
    expect(spy.mock.calls.flat().join(" ")).not.toContain(placeholder);
    spy.mockRestore();
  });

  it("throws without exiting in development (next dev awaits the check)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.fn();
    expect(() => checkSessionSecretAtStartup({ SESSION_SECRET: "short", NODE_ENV: "development" }, exit)).toThrow(/at least 32/);
    expect(exit).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
