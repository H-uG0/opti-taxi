import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { health, optimize } from "./client";
import { MAX_TRIPS, MAX_VEHICLES, type OptimizeRequest } from "./contract";
import { optimizerHttpErrorMessage } from "./http-errors";
import { optimizerAuthHeaders, optimizerToken, optimizerTokenWarning } from "./token";

vi.mock("server-only", () => ({}));

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

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("OPTIMIZER_URL", "http://optimizer.test");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function sentHeaders(call = 0): Record<string, string> {
  return fetchMock.mock.calls[call]?.[1].headers as Record<string, string>;
}

describe("optimizer client: OPTIMIZER_TOKEN", () => {
  it("sends the token as a bearer header on every call when it is set", async () => {
    vi.stubEnv("OPTIMIZER_TOKEN", "  jeton-de-test  ");
    fetchMock.mockResolvedValue(json({ status: "ok", matrixSource: "haversine" }));
    await health();
    fetchMock.mockResolvedValue(json({ detail: "x" }, 500));
    await optimize(request);
    expect(sentHeaders(0).authorization).toBe("Bearer jeton-de-test");
    expect(sentHeaders(1).authorization).toBe("Bearer jeton-de-test");
    expect(sentHeaders(1)["content-type"]).toBe("application/json");
  });

  it("sends no authorization header without a token (development)", async () => {
    vi.stubEnv("OPTIMIZER_TOKEN", "");
    fetchMock.mockResolvedValue(json({ status: "ok", matrixSource: "haversine" }));
    await health();
    expect(sentHeaders()).not.toHaveProperty("authorization");
  });

  it("turns a refused token, a busy service and an oversized body into clear French messages", async () => {
    for (const [status, pattern] of [
      [401, /OPTIMIZER_TOKEN/],
      [429, /Réessayez dans une minute/],
      [413, /trop volumineuse/],
    ] as const) {
      fetchMock.mockResolvedValueOnce(json({ detail: "detail" }, status));
      const result = await optimize(request);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(pattern);
    }
    expect(optimizerHttpErrorMessage(500, "boom")).toBe("Le service d'optimisation a renvoyé une erreur (HTTP 500) : boom");
  });

  it("refuses to send more trips than the contract allows (the optimizer would answer 422)", async () => {
    const trip = {
      id: "t",
      patientId: "p",
      direction: "OUTBOUND" as const,
      pickup: { lat: 43.5, lng: 5.4 },
      dropoff: { lat: 43.3, lng: 5.4 },
      appointmentMin: 540,
      allowedVehicleTypes: ["TAXI" as const],
      shareable: false,
    };
    const result = await optimize({ ...request, trips: Array.from({ length: MAX_TRIPS + 1 }, () => trip) });
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/trips : 3000 courses au plus par calcul/) });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(MAX_VEHICLES).toBe(300);
  });
});

describe("token helpers", () => {
  it("reads a trimmed token, blank meaning none", () => {
    expect(optimizerToken({ OPTIMIZER_TOKEN: " abc " })).toBe("abc");
    expect(optimizerToken({ OPTIMIZER_TOKEN: "   " })).toBeNull();
    expect(optimizerAuthHeaders({})).toEqual({});
  });

  it("warns in production only, without echoing a value", () => {
    expect(optimizerTokenWarning({ NODE_ENV: "production" })).toMatch(/OPTIMIZER_TOKEN is not set/);
    expect(optimizerTokenWarning({ NODE_ENV: "production", OPTIMIZER_TOKEN: "abc" })).toBeNull();
    expect(optimizerTokenWarning({ NODE_ENV: "development" })).toBeNull();
  });
});
