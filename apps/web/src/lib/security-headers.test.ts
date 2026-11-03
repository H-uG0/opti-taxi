import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, createNonce, MAP_HOSTS, mapOrigins, securityHeaders } from "./security-headers";

const NONCE = "cmFuZG9tLW5vbmNlLTEyMw==";
const OPENFREEMAP = "https://tiles.openfreemap.org/styles/liberty";

/** CSP string -> { directive: sources }. */
function parse(csp: string): Record<string, string[]> {
  return Object.fromEntries(
    csp.split(";").map((directive) => {
      const [name = "", ...sources] = directive.trim().split(/\s+/);
      return [name, sources] as const;
    }),
  );
}

function headerMap(nodeEnv: string | undefined): Record<string, string> {
  return Object.fromEntries(securityHeaders(nodeEnv).map(({ key, value }) => [key, value]));
}

describe("securityHeaders", () => {
  it("sends HSTS, Permissions-Policy and COOP in production, with the baseline headers", () => {
    expect(headerMap("production")).toEqual({
      "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Frame-Options": "DENY",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      "Cross-Origin-Opener-Policy": "same-origin",
    });
  });

  it("leaves HSTS out in development (plain http://localhost)", () => {
    const headers = headerMap("development");
    expect(headers).not.toHaveProperty("Strict-Transport-Security");
    expect(headers["Permissions-Policy"]).toContain("geolocation=()");
    expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
  });

  it("never sends a Content-Security-Policy without a nonce (the proxy does)", () => {
    expect(headerMap("production")).not.toHaveProperty("Content-Security-Policy");
  });
});

describe("mapOrigins", () => {
  it("always allows the documented map hosts", () => {
    expect(mapOrigins(null)).toEqual([...MAP_HOSTS]);
    expect(mapOrigins(undefined)).toEqual([...MAP_HOSTS]);
    expect(mapOrigins("  ")).toEqual([...MAP_HOSTS]);
  });

  it("adds the origin of the configured style once", () => {
    expect(mapOrigins(OPENFREEMAP)).toEqual([...MAP_HOSTS]);
    expect(mapOrigins("https://maps.example.fr/styles/v1/style.json?key=abc")).toEqual([...MAP_HOSTS, "https://maps.example.fr"]);
    expect(mapOrigins("http://localhost:8080/style.json")).toEqual([...MAP_HOSTS, "http://localhost:8080"]);
  });

  it("ignores a value that is not an http(s) URL", () => {
    expect(mapOrigins("not a url")).toEqual([...MAP_HOSTS]);
    expect(mapOrigins("javascript:alert(1)")).toEqual([...MAP_HOSTS]);
    expect(mapOrigins("data:application/json,{}")).toEqual([...MAP_HOSTS]);
  });
});

describe("contentSecurityPolicy", () => {
  it("builds the production policy", () => {
    const csp = contentSecurityPolicy({ nonce: NONCE, nodeEnv: "production", mapStyleUrl: OPENFREEMAP });
    expect(csp).toBe(
      [
        "default-src 'self'",
        `script-src 'self' 'nonce-${NONCE}' 'strict-dynamic'`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https://tiles.openfreemap.org https://tile.openstreetmap.org",
        "font-src 'self' data:",
        "connect-src 'self' https://tiles.openfreemap.org https://tile.openstreetmap.org",
        "worker-src 'self' blob:",
        "child-src blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "upgrade-insecure-requests",
      ].join("; "),
    );
  });

  it("allows eval only in development, and upgrades requests only in production", () => {
    const dev = parse(contentSecurityPolicy({ nonce: NONCE, nodeEnv: "development" }));
    expect(dev["script-src"]).toContain("'unsafe-eval'");
    expect(dev).not.toHaveProperty("upgrade-insecure-requests");
    const prod = parse(contentSecurityPolicy({ nonce: NONCE, nodeEnv: "production" }));
    expect(prod["script-src"]).not.toContain("'unsafe-eval'");
    expect(prod).toHaveProperty("upgrade-insecure-requests");
    const test = parse(contentSecurityPolicy({ nonce: NONCE, nodeEnv: "test" }));
    expect(test["script-src"]).not.toContain("'unsafe-eval'");
    expect(test).not.toHaveProperty("upgrade-insecure-requests");
  });

  it("never puts the nonce in style-src, where it would disable 'unsafe-inline'", () => {
    const csp = parse(contentSecurityPolicy({ nonce: NONCE, nodeEnv: "production" }));
    expect(csp["style-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    expect(csp["script-src"]).not.toContain("'unsafe-inline'");
  });

  it("allows the configured map style in img-src and connect-src", () => {
    const csp = parse(contentSecurityPolicy({ nonce: NONCE, nodeEnv: "production", mapStyleUrl: "https://maps.example.fr/style.json" }));
    expect(csp["connect-src"]).toContain("https://maps.example.fr");
    expect(csp["img-src"]).toContain("https://maps.example.fr");
    expect(csp["script-src"]).not.toContain("https://maps.example.fr");
  });

  it("puts the nonce where Next.js looks for it (first 'nonce-…' source of script-src)", () => {
    // Same pattern as node_modules/next/dist/server/app-render/get-script-nonce-from-header.js.
    const csp = contentSecurityPolicy({ nonce: NONCE, nodeEnv: "production" });
    const scriptSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src")) ?? "";
    const nonce = scriptSrc
      .split(/\s+/)
      .slice(1)
      .map((source) => /^'nonce-([A-Za-z0-9+/_-]+={0,2})'$/.exec(source)?.[1])
      .find(Boolean);
    expect(nonce).toBe(NONCE);
  });
});

describe("createNonce", () => {
  it("draws 128 random bits, base64-encoded, different every time", () => {
    const nonces = new Set(Array.from({ length: 50 }, () => createNonce()));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      expect(Buffer.from(nonce, "base64")).toHaveLength(16);
    }
  });
});
