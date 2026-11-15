import { describe, expect, it } from "vitest";
import { classifyStatusResponse, odometerKey, odometerUrl, parseOdometerKey, stopStatusUrl } from "./status-protocol";

describe("stopStatusUrl", () => {
  it("puts the stop id in the path, encoded", () => {
    expect(stopStatusUrl("cmh1abc")).toBe("/api/chauffeur/stops/cmh1abc/status");
    expect(stopStatusUrl("a/b")).toBe("/api/chauffeur/stops/a%2Fb/status");
  });
});

describe("classifyStatusResponse", () => {
  it("removes a recorded (or already recorded) status from the queue", () => {
    const body = { ok: true, outcome: "noop", message: "Prise en charge déjà enregistrée.", serverTime: 42, sessionExpiresAt: "2026-11-10T17:00:00.000Z" };
    expect(classifyStatusResponse(200, body)).toEqual({
      kind: "ok",
      message: "Prise en charge déjà enregistrée.",
      serverTime: 42,
      sessionExpiresAt: "2026-11-10T17:00:00.000Z",
    });
  });

  it("keeps the status for after the sign-in on an expired session or a password to change", () => {
    expect(classifyStatusResponse(401, { ok: false, code: "session", error: "…" })).toEqual({ kind: "session", reason: "expired" });
    expect(classifyStatusResponse(401, null)).toEqual({ kind: "session", reason: "expired" });
    expect(classifyStatusResponse(403, { ok: false, code: "password", error: "…" })).toEqual({ kind: "session", reason: "password" });
  });

  it("keeps the status for a later try on a server failure or an answer that is not the route's", () => {
    // An answer from a server failure or a proxy: the status may be recorded all the same.
    const maybe = { kind: "retry", reason: "server", maybeReceived: true };
    expect(classifyStatusResponse(500, { ok: false, code: "server", error: "…" })).toEqual(maybe);
    expect(classifyStatusResponse(502, null)).toEqual(maybe);
    expect(classifyStatusResponse(404, null)).toEqual(maybe);
    // Throttled before anything was read: certainly not recorded.
    expect(classifyStatusResponse(429, { ok: false, code: "refused", error: "…" })).toEqual({ kind: "retry", reason: "server" });
  });

  it("drops a status refused for good, with the reason for the crew", () => {
    for (const [status, code] of [
      [409, "refused"],
      [409, "conflict"],
      [403, "not-yours"],
      [403, "wrong-day"],
      [422, "too-old"],
      [400, "invalid"],
      [403, "origin"],
    ] as const) {
      expect(classifyStatusResponse(status, { ok: false, code, error: `Refus ${code}`, serverTime: 7 })).toEqual({
        kind: "refused",
        error: `Refus ${code}`,
        serverTime: 7,
        code,
      });
    }
  });
});

describe("odometer readings in the queue (FLD-03)", () => {
  it("keys a reading by its route and moment, and reads the key back", () => {
    expect(odometerKey("route_1", "START")).toBe("odometer:route_1:START");
    expect(parseOdometerKey("odometer:route_1:END")).toEqual({ routeId: "route_1", moment: "END" });
    expect(parseOdometerKey("stop_1")).toBeNull();
    expect(parseOdometerKey("odometer:../x:START")).toBeNull();
    expect(odometerUrl("route_1")).toBe("/api/chauffeur/routes/route_1/odometer");
  });

  it("keeps the code of a refusal, so the phone can offer to confirm an unusual jump", () => {
    expect(classifyStatusResponse(422, { ok: false, code: "confirm", error: "Saut inhabituel", serverTime: 5 })).toEqual({
      kind: "refused",
      error: "Saut inhabituel",
      serverTime: 5,
      code: "confirm",
    });
  });
});

