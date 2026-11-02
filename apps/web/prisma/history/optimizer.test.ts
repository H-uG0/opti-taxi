import { describe, expect, it } from "vitest";
import type { OptimizeRequest, PlanResponse } from "@/lib/optimizer/contract";
import { HistoryError } from "./errors";
import {
  createOptimizerClient,
  OptimizerCallError,
  optimizerBaseUrl,
  optimizerPort,
  unreachableMessage,
  withTimeLimit,
  type FetchLike,
} from "./optimizer";

const request: OptimizeRequest = {
  date: "2026-10-12",
  settings: {
    waitBeforeAppointmentMin: 30,
    waitAfterSessionMin: 15,
    maxTotalWaitMin: 45,
    maxDetourKmPerExtraPatient: 10,
    maxDetourKmTotal: 30,
    pickupServiceMin: 5,
    dropoffServiceMin: 5,
    unassignedPenalty: 10_000,
    timeLimitSec: 10,
  },
  vehicles: [],
  trips: [],
  tariffs: [],
};

const plan: PlanResponse = {
  status: "OK",
  routes: [],
  trips: [],
  unassigned: [],
  kpis: {
    tripsTotal: 0,
    tripsServed: 0,
    tripsUnassigned: 0,
    vehiclesUsed: 0,
    tripsPerVehicle: 0,
    totalKm: 0,
    emptyKm: 0,
    emptyKmRatio: 0,
    sharedTrips: 0,
    sharedTripRatio: 0,
    revenue: 0,
    cost: 0,
    margin: 0,
  },
  validation: { valid: true, violations: [] },
  meta: { matrixSource: "haversine", solverStatus: "ROUTING_SUCCESS", objective: 0, wallTimeMs: 1200, warnings: [] },
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("history optimizer client", () => {
  it("posts the request and returns the parsed plan", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return json(plan);
    };
    const client = createOptimizerClient("http://localhost:8100", fetchImpl);
    await expect(client.optimize(request)).resolves.toEqual(plan);
    expect(calls[0]?.url).toBe("http://localhost:8100/optimize");
    expect(calls[0]?.init.method).toBe("POST");
  });

  it("explains in French how to start an unreachable service", async () => {
    const client = createOptimizerClient("http://localhost:8100", async () => {
      throw new TypeError("fetch failed");
    });
    await expect(client.health()).rejects.toThrow(HistoryError);
    await expect(client.health()).rejects.toThrow(/ne répond pas \(http:\/\/localhost:8100\).*pnpm db:history/);
  });

  it("suggests the port of the configured URL, with no platform-specific path", () => {
    const message = unreachableMessage("http://localhost:8199");
    expect(message).toContain("(http://localhost:8199)");
    expect(message).toContain("--port 8199");
    expect(message).not.toContain("8100");
    expect(message).not.toMatch(/\.venv|Scripts|python\.exe/);
    expect(message).toContain("docker compose up -d optimizer");
    expect(optimizerPort("http://optimizer:8100")).toBe("8100");
    expect(optimizerPort("https://optimiseur.example")).toBe("443");
    expect(optimizerPort("http://optimiseur.example")).toBe("80");
    expect(optimizerPort("pas une URL")).toBe("8100");
  });

  it("reports HTTP errors and contract mismatches", async () => {
    const failing = createOptimizerClient("http://x", async () => json({ detail: "trips: champ manquant" }, 422));
    await expect(failing.optimize(request)).rejects.toThrow(/HTTP 422.*champ manquant/);
    const odd = createOptimizerClient("http://x", async () => json({ status: "OK" }));
    await expect(odd.optimize(request)).rejects.toThrow(/contrat non respecté/);
  });

  it("never throws from evaluate (route refresh contract)", async () => {
    const client = createOptimizerClient("http://x", async () => {
      throw new TypeError("fetch failed");
    });
    const outcome = await client.evaluate({ ...request, routes: [] });
    expect(outcome.ok).toBe(false);
    const ok = await createOptimizerClient("http://x", async () => json(plan)).evaluate({ ...request, routes: [] });
    expect(ok).toEqual({ ok: true, data: plan });
  });

  it("gives evaluate failures the reasons of lib/optimizer/client.ts, so refreshRoutes reports them", async () => {
    const reasonOf = async (fetchImpl: FetchLike) => {
      const outcome = await createOptimizerClient("http://x", fetchImpl).evaluate({ ...request, routes: [] });
      return outcome.ok ? null : outcome.reason;
    };
    expect(
      await reasonOf(async () => {
        throw new TypeError("fetch failed");
      }),
    ).toBe("unreachable");
    expect(
      await reasonOf(async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }),
    ).toBe("timeout");
    expect(await reasonOf(async () => json({ detail: "boom" }, 500))).toBe("error");
    expect(await reasonOf(async () => json({ status: "OK" }))).toBe("error");
  });

  it("throws optimizer failures as HistoryError carrying their reason", async () => {
    const client = createOptimizerClient("http://x", async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    const error = await client.optimize(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HistoryError);
    expect(error).toBeInstanceOf(OptimizerCallError);
    expect((error as OptimizerCallError).reason).toBe("timeout");
    expect((error as Error).message).toMatch(/n'a pas répondu en 70 s/);
  });

  it("overrides the solver time limit only when asked", () => {
    expect(withTimeLimit(request, null)).toBe(request);
    expect(withTimeLimit(request, 3).settings.timeLimitSec).toBe(3);
    expect(request.settings.timeLimitSec).toBe(10);
  });

  it("reads OPTIMIZER_URL without its trailing slash", () => {
    expect(optimizerBaseUrl({ OPTIMIZER_URL: "http://localhost:8100/" })).toBe("http://localhost:8100");
    expect(optimizerBaseUrl({})).toBe("http://localhost:8100");
  });
});
