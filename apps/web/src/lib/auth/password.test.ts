import { describe, expect, it } from "vitest";
import { hashPassword, lockedPasswordHash, verifyPassword } from "./password";
import { passwordVersion } from "./session-check";

describe("lockedPasswordHash", () => {
  it("is a bcrypt hash that the previous password no longer matches, and changes the session fingerprint", async () => {
    const previous = await hashPassword("ancien-mot-de-passe");
    const locked = await lockedPasswordHash();
    expect(locked).toMatch(/^\$2[aby]\$10\$/);
    expect(await verifyPassword("ancien-mot-de-passe", previous)).toBe(true);
    expect(await verifyPassword("ancien-mot-de-passe", locked)).toBe(false);
    expect(await verifyPassword("", locked)).toBe(false);
    expect(passwordVersion(locked)).not.toBe(passwordVersion(previous));
  });

  it("draws a new secret every time", async () => {
    const [a, b] = await Promise.all([lockedPasswordHash(), lockedPasswordHash()]);
    expect(a).not.toBe(b);
    expect(passwordVersion(a)).not.toBe(passwordVersion(b));
  });
});
