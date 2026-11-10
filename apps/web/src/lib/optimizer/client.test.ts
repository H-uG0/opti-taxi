import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { health, insert, INSERT_UNKNOWN_ERROR, optimize, timeoutMessage, unreachableMessage } from "./client";
import { MAX_TRIPS, MAX_VEHICLES, type InsertRequest, type OptimizeRequest } from "./contract";
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
    expect(optimizerHttpErrorMessage(500, "boom")).toBe("Le service d'optimisation a renvoyé une erreur (HTTP 500)\u00a0: boom");
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
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/trips\u00a0: 3000 courses au plus par calcul/) });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(MAX_VEHICLES).toBe(300);
  });
});

describe("optimizer client: routes in place sent to an older optimizer", () => {
  const inPlace = [{ vehicleId: "veh_1", stops: [{ tripId: "t", kind: "PICKUP" as const }] }];
  const refused = () =>
    json({ detail: [{ type: "extra_forbidden", loc: ["body", "initialRoutes"], msg: "Extra inputs are not permitted" }] }, 422);
  const sentBody = (call: number) => JSON.parse(String(fetchMock.mock.calls[call]?.[1].body)) as Record<string, unknown>;

  it("computes from scratch when the optimizer refuses initialRoutes (422)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(refused()).mockResolvedValueOnce(json({ detail: "after" }, 500));
    const result = await optimize({ ...request, initialRoutes: inPlace });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(0)).toHaveProperty("initialRoutes");
    expect(sentBody(1)).not.toHaveProperty("initialRoutes");
    expect(sentBody(1).date).toBe(request.date);
    // The answer of the second call is the result.
    expect(result).toMatchObject({ ok: false, status: 500 });
  });

  it("does not retry another 422, nor a request without routes in place", async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: [{ loc: ["body", "trips", 0, "appointmentMin"] }] }, 422));
    expect(await optimize({ ...request, initialRoutes: inPlace })).toMatchObject({ ok: false, status: 422 });
    fetchMock.mockResolvedValueOnce(refused());
    expect(await optimize(request)).toMatchObject({ ok: false, status: 422 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("optimizer client: POST /insert", () => {
  const fixtures = path.resolve(__dirname, "../../../../../contract/fixtures");
  const load = (name: string): unknown => JSON.parse(readFileSync(path.join(fixtures, name), "utf8"));

  it("posts the request and reads the places of the trip", async () => {
    fetchMock.mockResolvedValue(json(load("insert-response.json")));
    const result = await insert(load("insert-request.json") as InsertRequest);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://optimizer.test/insert");
    expect(result.ok && result.data.options[0]?.vehicleId).toBe("veh_taxi_1");
  });

  it("says when the optimizer predates /insert (404), and never sends an unknown trip", async () => {
    fetchMock.mockResolvedValue(json({ detail: "Not Found" }, 404));
    const result = await insert(load("insert-request.json") as InsertRequest);
    expect(result).toMatchObject({ ok: false, error: INSERT_UNKNOWN_ERROR, status: 404 });
    fetchMock.mockClear();
    const unknown = await insert({ ...(load("insert-request.json") as InsertRequest), tripId: "trip_404" });
    expect(unknown.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
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

describe("timeoutMessage", () => {
  it("gives the service's address in development only", () => {
    expect(timeoutMessage(120_000, "http://optimizer:8100", "development")).toContain("120\u00a0s (http://optimizer:8100).");
    const production = timeoutMessage(120_000, "http://optimizer:8100", "production");
    expect(production).toBe("Le service d'optimisation n'a pas répondu en 120\u00a0s. Réessayez ou réduisez le temps de calcul dans les paramètres.");
    expect(production).not.toContain("8100");
  });
});

describe("unreachableMessage", () => {
  it("tells a developer how to start the service, never a dispatcher", () => {
    expect(unreachableMessage("http://127.0.0.1:8100", "development")).toContain("Lancez-le avec\u00a0: cd services/optimizer");
    const production = unreachableMessage("http://optimizer:8100", "production");
    expect(production).toBe(
      "Le service d'optimisation ne répond pas. Réessayez dans quelques minutes\u202f; si cela dure, prévenez la personne qui gère l'application.",
    );
    expect(production).not.toContain("optimizer:8100");
  });
});
