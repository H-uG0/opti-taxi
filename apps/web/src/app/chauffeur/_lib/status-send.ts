/**
 * The phone's side of the status and session routes (status-protocol.ts):
 * fetch with a timeout, never a redirect, and the answer read into what the
 * queue does next. Browser only.
 */
import { classifyStatusResponse, SESSION_URL, stopStatusUrl, type SendOutcome, type SessionResponseBody } from "./status-protocol";
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

export async function sendQueuedStatus(status: QueuedStatus): Promise<SendOutcome> {
  if (navigator.onLine === false) return { kind: "retry", reason: "offline" };
  const startedAt = Date.now();
  try {
    const { status: httpStatus, json } = await postJson(
      stopStatusUrl(status.stopId),
      { action: status.action, observedAt: status.observedAt, sentAt: startedAt },
      SEND_TIMEOUT_MS,
    );
    return classifyStatusResponse(httpStatus, json);
  } catch {
    return { kind: "retry", reason: Date.now() - startedAt >= SEND_TIMEOUT_MS ? "timeout" : "offline" };
  }
}

/**
 * Asks the server to renew the session if it is close to its end. Returns the
 * session's end on the phone's clock (corrected by the server's clock), "lost"
 * when the server has no current session, null when it could not be asked.
 */
export async function renewSession(): Promise<number | "lost" | null> {
  if (navigator.onLine === false) return null;
  try {
    const { status, json } = await postJson(SESSION_URL, {}, SEND_TIMEOUT_MS);
    const body = json as SessionResponseBody | null;
    if (status === 401) return "lost";
    if (!body || !body.ok || !body.sessionExpiresAt) return null;
    const offset = body.serverTime - Date.now();
    return Date.parse(body.sessionExpiresAt) - offset;
  } catch {
    return null;
  }
}
