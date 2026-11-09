/**
 * The phone's side of the status and session routes (status-protocol.ts):
 * fetch with a timeout, never a redirect, and the answer read into what the
 * queue does next. Browser only.
 */
import {
  classifyStatusResponse,
  SESSION_URL,
  stopStatusUrl,
  type SendOutcome,
  type SessionRequestBody,
  type SessionResponseBody,
  type StatusRequestBody,
} from "./status-protocol";
import type { QueuedStatus } from "./status-queue";

/** A status request still unanswered after this is abandoned and the status waits in the queue. */
export const SEND_TIMEOUT_MS = 15_000;

async function postJson(url: string, body: unknown, timeoutMs: number): Promise<{ status: number; json: unknown }> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
      // A redirect (to /login…) would hand back a page, never a status: treat it as a failure.
      redirect: "error",
      signal: controller.signal,
    });
    const json: unknown = await response.json().catch(() => null);
    return { status: response.status, json };
  } finally {
    window.clearTimeout(timer);
  }
}

/** Sends one status of `ownerId`'s queue (the server keeps it waiting if the session is now another account's). */
export async function sendQueuedStatus(status: QueuedStatus, ownerId: string): Promise<SendOutcome> {
  // Not even tried: certainly not received.
  if (navigator.onLine === false) return { kind: "retry", reason: "offline" };
  const startedAt = Date.now();
  try {
    const body: StatusRequestBody = { action: status.action, observedAt: status.observedAt, sentAt: startedAt, ownerId };
    const { status: httpStatus, json } = await postJson(stopStatusUrl(status.stopId), body, SEND_TIMEOUT_MS);
    return classifyStatusResponse(httpStatus, json);
  } catch {
    // Abandoned (15 s) or cut without an answer: the server may have recorded it.
    return { kind: "retry", reason: Date.now() - startedAt >= SEND_TIMEOUT_MS ? "timeout" : "offline", maybeReceived: true };
  }
}

/** A driver session as the phone sees it: its end on the phone's clock, and whether it still prolongs itself. */
export type SessionState = { expiresAt: number; renewable: boolean };

/**
 * Asks the server to renew the session if it is close to its end. Returns the
 * session's end on the phone's clock (corrected by the server's clock) and
 * whether it can still be renewed, "lost" when the server has no current
 * session for `ownerId` (expired, or the cookie is now another account's),
 * null when it could not be asked.
 */
export async function renewSession(ownerId: string): Promise<SessionState | "lost" | null> {
  if (navigator.onLine === false) return null;
  try {
    const request: SessionRequestBody = { ownerId };
    const { status, json } = await postJson(SESSION_URL, request, SEND_TIMEOUT_MS);
    const body = json as SessionResponseBody | null;
    if (status === 401) return "lost";
    if (!body || !body.ok || !body.sessionExpiresAt) return null;
    const offset = body.serverTime - Date.now();
    return { expiresAt: Date.parse(body.sessionExpiresAt) - offset, renewable: body.renewable !== false };
  } catch {
    return null;
  }
}
