import { describe, expect, it } from "vitest";
import { assertSessionSecret, MIN_PRODUCTION_SECRET_LENGTH, sessionSecretProblem } from "./secret";

/** The placeholder shipped in .env.example (43 characters). */
const PLACEHOLDER = "change-me-dev-only-secret-at-least-32-chars";
/** What `openssl rand -base64 48` prints (64 characters). */
const GENERATED = "q0b6yQ8tV1m2XvB3c4N5d6M7e8L9f0K1g2J3h4H5i6G7j8F9k0E1l2D3m4C5n6B7";

describe("sessionSecretProblem", () => {
  it("refuses a missing or short secret everywhere", () => {
    for (const env of ["development", "test", "production"]) {
      expect(sessionSecretProblem(undefined, env)).toMatch(/not set/);
      expect(sessionSecretProblem("", env)).toMatch(/not set/);
      expect(sessionSecretProblem("x".repeat(31), env)).toMatch(/at least 32/);
    }
  });

  it("accepts the .env.example placeholder outside production", () => {
    expect(PLACEHOLDER.length).toBe(43);
    expect(sessionSecretProblem(PLACEHOLDER, "development")).toBeNull();
    expect(sessionSecretProblem(PLACEHOLDER, "test")).toBeNull();
    expect(sessionSecretProblem(PLACEHOLDER, undefined)).toBeNull();
  });

  it("refuses the placeholder in production, whatever its case or length", () => {
    expect(sessionSecretProblem(PLACEHOLDER, "production")).toMatch(/placeholder/);
    expect(sessionSecretProblem(`CHANGE-ME-${GENERATED}`, "production")).toMatch(/placeholder/);
  });

  it("refuses a production secret shorter than 43 characters", () => {
    expect(MIN_PRODUCTION_SECRET_LENGTH).toBe(43);
    expect(sessionSecretProblem(GENERATED.slice(0, 42), "production")).toMatch(/too short for production: 42 characters, at least 43/);
    expect(sessionSecretProblem(GENERATED.slice(0, 43), "production")).toBeNull();
    expect(sessionSecretProblem(GENERATED, "production")).toBeNull();
  });

  it("never repeats the secret in the message", () => {
    const short = "s3cr3t-value-that-is-too-short-for-prod";
    expect(sessionSecretProblem(short, "production")).not.toContain(short);
    expect(sessionSecretProblem(PLACEHOLDER, "production")).not.toContain(PLACEHOLDER);
  });
});

describe("assertSessionSecret", () => {
  it("throws the problem as an Error, and passes a good secret", () => {
    expect(() => assertSessionSecret({ SESSION_SECRET: PLACEHOLDER, NODE_ENV: "production" })).toThrow(/openssl rand -base64 48/);
    expect(assertSessionSecret({ SESSION_SECRET: GENERATED, NODE_ENV: "production" })).toBe(GENERATED);
    expect(() => assertSessionSecret({ NODE_ENV: "development" })).toThrow(/not set/);
    expect(() => assertSessionSecret({ SESSION_SECRET: PLACEHOLDER, NODE_ENV: "development" })).not.toThrow();
  });
});
