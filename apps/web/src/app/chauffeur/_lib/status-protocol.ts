/**
 * JSON exchanged between the roadmap and its route handlers:
 * - POST /api/chauffeur/stops/:id/status records a status (one per request,
 *   sent from the phone's queue: see status-queue.ts);
 * - POST /api/chauffeur/session renews a driver's session close to its end.
 * Types, URLs and the reading of a response by the phone. Pure module, safe
 * in the browser (no zod: the server validates requests itself).
 */
import type { NoShowReason } from "@prisma/client";
import type { StopAction } from "./transitions";

export const STOP_ACTIONS = ["PICKUP", "DROPOFF", "NO_SHOW", "UNDO", "ARRIVE", "UNDO_ARRIVE"] as const satisfies readonly StopAction[];

export function stopStatusUrl(stopId: string): string {
  return `/api/chauffeur/stops/${encodeURIComponent(stopId)}/status`;
}

export const SESSION_URL = "/api/chauffeur/session";

/** POST /api/chauffeur/routes/:id/odometer: a reading of the odometer (FLD-03), sent from the queue like a status. */
export function odometerUrl(routeId: string): string {
  return `/api/chauffeur/routes/${encodeURIComponent(routeId)}/odometer`;
}

/** POST /api/chauffeur/routes/:id/fuel: a fill-up or a charge of the day's vehicle (FLD-03), online only. */
export function fuelUrl(routeId: string): string {
  return `/api/chauffeur/routes/${encodeURIComponent(routeId)}/fuel`;
}

/**
 * The queue's key of an odometer reading (FLD-03): a route and a moment, kept in the place of a stop id (« odometer:
 * <route>:START »), so a reading waits, is withdrawn and is sent like a status. Never a patient's anything.
 */
export function odometerKey(routeId: string, moment: "START" | "END"): string {
  return `odometer:${routeId}:${moment}`;
}

/** The route and moment of an odometer reading's key, null for a stop's id. */
export function parseOdometerKey(key: string): { routeId: string; moment: "START" | "END" } | null {
  const match = /^odometer:([A-Za-z0-9_-]{1,40}):(START|END)$/.exec(key);
  return match ? { routeId: match[1]!, moment: match[2] as "START" | "END" } : null;
}

/** Body of an odometer request. Times are the phone's clock, epoch milliseconds. */
export type OdometerRequestBody = {
  moment: "START" | "END";
  km: number;
  /** The crew confirmed an unusual jump. */
  confirmed: boolean;
  observedAt: number;
  sentAt: number;
  ownerId: string;
};

/** Body of a status request. Times are the phone's clock, epoch milliseconds. */
export type StatusRequestBody = {
  action: StopAction;
  /** When the crew tapped the status. */
  observedAt: number;
  /** When this request left the phone (the server cancels the phone's clock offset with it). */
  sentAt: number;
  /** Account whose queue holds the status: refused (401, kept) when the session is now another account's. */
  ownerId: string;
  /** « Patient absent »: the reason chosen in the list (lib/domain/field-wait.ts). */
  reason?: NoShowReason;
  /** « Fin de tournée » (FLD-02): the real time typed, minute of the service day. */
  declaredMinute?: number;
};

/** Body of a session request: the account the page belongs to (401 when the cookie is now another's). */
export type SessionRequestBody = { ownerId: string };

/** Why a status was not recorded. */
export type StatusErrorCode =
  /** No current session (expired, signed out, revoked): sign in again, the status waits. */
  | "session"
  /** Provisional password to change first: the status waits. */
  | "password"
  | "origin"
  | "invalid"
  | "not-yours"
  | "wrong-day"
  | "too-old"
  /** « Patient absent » before the minimum wait set in Paramètres. */
  | "wait"
  /** « Fin de tournée »: a time in the future, or out of the order of the route's statuses. */
  | "declared"
  /** An odometer reading below the last one known (FLD-03). */
  | "odometer"
  /** An odometer reading with an unusual jump: recorded once the crew confirms it. */
  | "confirm"
  /** The transition rules refuse it (already picked up, cancelled trip…). */
  | "refused"
  /** The other crew member changed the stop meanwhile. */
  | "conflict"
  /** Server or database failure: try again later. */
  | "server";

export type StatusResponseBody =
  | {
      ok: true;
      outcome: "applied" | "noop";
      message: string;
      /** Server clock once the status is saved (epoch ms): a page rendered after it shows the status. */
      serverTime: number;
      sessionExpiresAt: string | null;
    }
  | { ok: false; code: StatusErrorCode; error: string; serverTime: number; sessionExpiresAt?: string | null };

export type SessionResponseBody =
  /** renewable: the session is still renewed when the app reaches the server (false 7 days after the sign-in). */
  | { ok: true; sessionExpiresAt: string | null; renewable: boolean; serverTime: number }
  | { ok: false; code: "session" | "origin"; error: string; serverTime: number };

/** Codes for which the status stays in the queue and is sent again later. */
const KEEP_CODES: ReadonlySet<StatusErrorCode> = new Set(["session", "password", "server"]);

/** What the phone does with the answer to one queued status. */
export type SendOutcome =
  | { kind: "ok"; message: string; serverTime: number; sessionExpiresAt: string | null }
  /** Not recorded and never will be: drop it from the queue and tell the crew (code: why, when the server said). */
  | { kind: "refused"; error: string; serverTime: number | null; code?: StatusErrorCode }
  /**
   * Not recorded yet as far as the phone knows (network, timeout, server): keep it, try again later.
   * maybeReceived: the request left the phone and got no final answer (timeout, cut, 5xx), so the
   * server may have recorded it all the same (a replay is then a no-op).
   */
  | { kind: "retry"; reason: "offline" | "timeout" | "server"; maybeReceived?: boolean }
  /** Session to open again: keep it, wait for the sign-in. */
  | { kind: "session"; reason: "expired" | "password" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Reads a status response (HTTP status and parsed JSON body, null when it was not JSON). */
export function classifyStatusResponse(httpStatus: number, body: unknown): SendOutcome {
  if (isRecord(body) && body.ok === true && httpStatus >= 200 && httpStatus < 300) {
    return {
      kind: "ok",
      message: typeof body.message === "string" ? body.message : "Statut enregistré.",
      serverTime: typeof body.serverTime === "number" ? body.serverTime : Date.now(),
      sessionExpiresAt: typeof body.sessionExpiresAt === "string" ? body.sessionExpiresAt : null,
    };
  }
  const code = isRecord(body) && typeof body.code === "string" ? (body.code as StatusErrorCode) : null;
  if (httpStatus === 401 || code === "session") return { kind: "session", reason: "expired" };
  if (code === "password") return { kind: "session", reason: "password" };
  if (httpStatus >= 500 || code === null) return { kind: "retry", reason: "server", maybeReceived: true };
  if (httpStatus === 429 || KEEP_CODES.has(code)) return { kind: "retry", reason: "server" };
  return {
    kind: "refused",
    error: isRecord(body) && typeof body.error === "string" ? body.error : "Statut refusé par le serveur.",
    serverTime: isRecord(body) && typeof body.serverTime === "number" ? body.serverTime : null,
    code,
  };
}
