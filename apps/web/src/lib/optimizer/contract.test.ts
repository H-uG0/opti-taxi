import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateRequestSchema, optimizeRequestSchema, planResponseSchema } from "./contract";

const fixtures = path.resolve(__dirname, "../../../../../contract/fixtures");
const load = (name: string): unknown => JSON.parse(readFileSync(path.join(fixtures, name), "utf8"));

describe("optimizer contract fixtures", () => {
  it("accepts optimize-request.json", () => {
    const parsed = optimizeRequestSchema.parse(load("optimize-request.json"));
    expect(parsed.trips.length).toBeGreaterThan(0);
    expect(parsed.initialRoutes?.[0]?.stops.length).toBeGreaterThan(0);
  });

  it("takes the routes in place on /optimize only, and as an optional field", () => {
    const { initialRoutes, ...request } = load("optimize-request.json") as Record<string, unknown>;
    expect(optimizeRequestSchema.safeParse(request).success).toBe(true);
    expect(optimizeRequestSchema.safeParse({ ...request, initialRoutes: null }).success).toBe(true);
    const evaluate = load("evaluate-request.json") as Record<string, unknown>;
    expect(evaluateRequestSchema.safeParse({ ...evaluate, initialRoutes }).success).toBe(false);
  });

  it("accepts evaluate-request.json", () => {
    const parsed = evaluateRequestSchema.parse(load("evaluate-request.json"));
    expect(parsed.routes.length).toBeGreaterThan(0);
  });

  it("accepts plan-response.json", () => {
    const parsed = planResponseSchema.parse(load("plan-response.json"));
    expect(parsed.status).toBe("OK");
  });

  it("rejects an OUTBOUND trip without appointmentMin", () => {
    const request = load("optimize-request.json") as { trips: Array<Record<string, unknown>> };
    request.trips[0] = { ...request.trips[0], appointmentMin: null };
    expect(optimizeRequestSchema.safeParse(request).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    const request = load("optimize-request.json") as Record<string, unknown>;
    expect(optimizeRequestSchema.safeParse({ ...request, extra: 1 }).success).toBe(false);
  });
});
