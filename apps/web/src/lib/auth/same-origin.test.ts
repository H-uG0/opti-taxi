import { describe, expect, it } from "vitest";
import { isSameOriginRequest } from "./same-origin";

const request = (headers: Record<string, string>) => new Headers(headers);

describe("isSameOriginRequest", () => {
  it("accepts a fetch from the app's own pages", () => {
    expect(isSameOriginRequest(request({ origin: "https://opti-taxi.example", host: "opti-taxi.example", "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameOriginRequest(request({ origin: "http://localhost:3100", host: "localhost:3100" }))).toBe(true);
  });

  it("compares with the forwarded host behind a reverse proxy", () => {
    const headers = { origin: "https://opti-taxi.example", host: "web:3100", "x-forwarded-host": "opti-taxi.example" };
    expect(isSameOriginRequest(request(headers))).toBe(true);
    expect(isSameOriginRequest(request({ ...headers, "x-forwarded-host": "evil.example" }))).toBe(false);
  });

  it("refuses another site, a sibling subdomain and an opaque origin", () => {
    expect(isSameOriginRequest(request({ origin: "https://evil.example", host: "opti-taxi.example" }))).toBe(false);
    expect(isSameOriginRequest(request({ origin: "https://opti-taxi.example", host: "opti-taxi.example", "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isSameOriginRequest(request({ origin: "https://demo.opti-taxi.example", host: "opti-taxi.example", "sec-fetch-site": "same-site" }))).toBe(false);
    expect(isSameOriginRequest(request({ origin: "null", host: "opti-taxi.example" }))).toBe(false);
  });

  it("lets a request without Origin through, as Next.js does for server actions", () => {
    expect(isSameOriginRequest(request({ host: "opti-taxi.example" }))).toBe(true);
  });
});
