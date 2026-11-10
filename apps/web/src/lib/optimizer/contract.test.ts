import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateRequestSchema, insertRequestSchema, insertResponseSchema, optimizeRequestSchema, planResponseSchema } from "./contract";

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

  it("accepts insert-request.json, a trip off every route", () => {
    const parsed = insertRequestSchema.parse(load("insert-request.json"));
    expect(parsed.tripId).toBe("trip_1");
    expect(parsed.routes.flatMap((r) => r.stops).some((s) => s.tripId === parsed.tripId)).toBe(false);
  });

  it("refuses an insertion of an unknown trip, or with the routes of /optimize", () => {
    const request = load("insert-request.json") as Record<string, unknown>;
    expect(insertRequestSchema.safeParse({ ...request, tripId: "trip_404" }).success).toBe(false);
    expect(insertRequestSchema.safeParse({ ...request, initialRoutes: request.routes }).success).toBe(false);
    expect(insertRequestSchema.safeParse({ ...request, vehicleIds: ["veh_vsl_1"] }).success).toBe(true);
  });

  it("accepts insert-response.json", () => {
    const parsed = insertResponseSchema.parse(load("insert-response.json"));
    expect(parsed.options[0]?.vehicleId).toBe("veh_taxi_1");
    expect(parsed.rejected[0]?.kind).toBe("SHIFT");
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
