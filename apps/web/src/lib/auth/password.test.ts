import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";

describe("hashPassword / verifyPassword", () => {
  it("stores a salted bcrypt hash that only the same password matches", async () => {
    const [a, b] = await Promise.all([hashPassword("mot-de-passe-du-chauffeur"), hashPassword("mot-de-passe-du-chauffeur")]);
    expect(a).toMatch(/^\$2[aby]\$10\$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword("mot-de-passe-du-chauffeur", a)).toBe(true);
    expect(await verifyPassword("mot-de-passe-du-chauffeuR", a)).toBe(false);
    expect(await verifyPassword("", a)).toBe(false);
  });
});
