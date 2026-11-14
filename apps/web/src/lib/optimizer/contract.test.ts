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

  it("accepts optimize-request-started.json, a day under way, and the same progress on /evaluate and /insert", () => {
    const raw = load("optimize-request-started.json") as Record<string, unknown>;
    const parsed = optimizeRequestSchema.parse(raw);
    expect(parsed.progress?.nowMin).toBe(500);
    expect(parsed.progress?.routes[0]?.done.length).toBe(2);
    expect(parsed.settings.changePenalty).toBe(15);
    const { initialRoutes, ...day } = raw;
    expect(evaluateRequestSchema.safeParse({ ...day, routes: initialRoutes }).success).toBe(true);
    expect(insertRequestSchema.safeParse({ ...day, routes: initialRoutes, tripId: "trip_7" }).success).toBe(true);
    // A trip already picked up is not placed again.
    expect(insertRequestSchema.safeParse({ ...day, routes: initialRoutes, tripId: "trip_5" }).success).toBe(false);
  });

  it("refuses a progress that does not match the request (same rules as schemas.py)", () => {
    const raw = load("optimize-request-started.json") as { progress: { nowMin: number; routes: Array<{ vehicleId: string; done: unknown[] }> } };
    const withRoutes = (routes: unknown) => ({ ...raw, progress: { nowMin: 500, routes } });
    const stop = (tripId: string, kind: string, startMin = 400, departureMin = 405) => ({ tripId, kind, startMin, departureMin });
    expect(optimizeRequestSchema.safeParse(withRoutes([{ vehicleId: "veh_404", done: [] }])).success).toBe(false);
    expect(optimizeRequestSchema.safeParse(withRoutes([{ vehicleId: "veh_taxi_1", done: [stop("trip_404", "PICKUP")] }])).success).toBe(false);
    expect(optimizeRequestSchema.safeParse(withRoutes([{ vehicleId: "veh_taxi_1", done: [stop("trip_1", "DROPOFF")] }])).success).toBe(false);
    expect(optimizeRequestSchema.safeParse(withRoutes([{ vehicleId: "veh_taxi_1", done: [stop("trip_1", "PICKUP", 405, 400)] }])).success).toBe(false);
    expect(
      optimizeRequestSchema.safeParse(withRoutes([{ vehicleId: "veh_taxi_1", done: [] }, { vehicleId: "veh_taxi_1", done: [] }])).success,
    ).toBe(false);
    expect(optimizeRequestSchema.safeParse({ ...raw, progress: null }).success).toBe(true);
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

  it("takes the facility's hours of a trip as optional, closing after opening (PAT-04)", () => {
    const request = optimizeRequestSchema.parse(load("optimize-request.json"));
    expect(request.trips[0]).toMatchObject({ facilityOpenMin: 425, facilityCloseMin: 1200 });
    const raw = load("optimize-request.json") as { trips: Array<Record<string, unknown>> };
    raw.trips[0] = { ...raw.trips[0], facilityCloseMin: 400 };
    expect(optimizeRequestSchema.safeParse(raw).success).toBe(false);
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
