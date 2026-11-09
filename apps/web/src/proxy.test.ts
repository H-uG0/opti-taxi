import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config, proxy } from "./proxy";

function matches(url: string, headers: Record<string, string> = {}): boolean {
  return unstable_doesMiddlewareMatch({ config, url, headers });
}

describe("proxy matcher", () => {
  it("runs on pages, their RSC requests and server actions", () => {
    for (const url of [
      "/",
      "/login",
      "/planning",
      "/planning?date=2026-11-04",
      "/patients/abc",
      "/chauffeur",
      "/arrivees-partagees",
      "/api/chauffeur/stops/abc/status",
    ]) {
      expect(matches(url), url).toBe(true);
    }
    // A server action is a POST to the page path with a Next-Action header.
    expect(matches("/login", { "next-action": "7f00aa", "content-type": "multipart/form-data" })).toBe(true);
    expect(matches("/planning", { rsc: "1" })).toBe(true);
  });

  it("skips build assets, icons, the manifest, the service worker and router prefetches", () => {
    for (const url of [
      "/_next/static/chunks/main.js",
      "/_next/static/css/app.css",
      "/_next/image?url=%2Ficons%2Ficon-192.png&w=64&q=75",
      "/icons/icon-192.png",
      "/icons/icon-maskable.svg",
      "/icon.svg",
      "/apple-touch-icon.png",
      "/favicon.ico",
      "/manifest.webmanifest",
      "/sw.js",
    ]) {
      expect(matches(url), url).toBe(false);
    }
    expect(matches("/planning", { "next-router-prefetch": "1" })).toBe(false);
    expect(matches("/planning", { purpose: "prefetch" })).toBe(false);
  });
});

describe("proxy", () => {
  it("sets the same nonce-based policy on the request (for the render) and on the response", () => {
    const response = proxy(new NextRequest("http://localhost:3100/planning", { headers: { "content-security-policy": "script-src 'nonce-attacker'" } }));
    const sent = response.headers.get("content-security-policy") ?? "";
    expect(sent).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/]{22}==' 'strict-dynamic'/);
    expect(sent).toContain("frame-ancestors 'none'");
    // NextResponse.next({ request: { headers } }) forwards request headers as x-middleware-request-*.
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(sent);
    const nonce = /'nonce-([^']+)'/.exec(sent)?.[1];
    expect(response.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    expect(sent).not.toContain("attacker");
  });

  it("draws a new nonce for every request", () => {
    const a = proxy(new NextRequest("http://localhost:3100/login")).headers.get("content-security-policy");
    const b = proxy(new NextRequest("http://localhost:3100/login")).headers.get("content-security-policy");
    expect(a).not.toBe(b);
  });
});
