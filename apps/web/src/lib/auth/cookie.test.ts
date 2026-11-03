import { describe, expect, it } from "vitest";
import { sessionCookie } from "./cookie";

describe("sessionCookie", () => {
  it("uses a __Host- cookie in production: Secure, Path=/, no Domain", () => {
    const { name, attributes } = sessionCookie("production");
    expect(name).toBe("__Host-ot_session");
    expect(attributes).toEqual({ httpOnly: true, sameSite: "lax", secure: true, path: "/" });
    expect(attributes).not.toHaveProperty("domain");
  });

  it("keeps a plain cookie for http://localhost in development and tests", () => {
    for (const env of ["development", "test", undefined]) {
      const { name, attributes } = sessionCookie(env);
      expect(name).toBe("ot_session");
      expect(attributes.secure).toBe(false);
      expect(attributes.path).toBe("/");
      expect(attributes.httpOnly).toBe(true);
    }
  });
});
