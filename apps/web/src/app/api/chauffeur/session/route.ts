/**
 * POST /api/chauffeur/session — called by the roadmap when it opens, comes
 * back to the screen or gets the network back: renews a driver's session close
 * to its end (lib/auth/session-renewal.ts) and tells the phone when it ends,
 * for « Session valable jusqu'à HH:MM » and the warning 30 min before. Page
 * renders cannot set cookies, hence this small route. Reads nothing but the
 * account (getCurrentUser: a revoked session gets a 401, never a renewal).
 */
import type { NextRequest } from "next/server";
import type { SessionResponseBody } from "@/app/chauffeur/_lib/status-protocol";
import { getCurrentUser } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/auth/same-origin";
import { renewDriverSession } from "@/lib/auth/session";
import { jsonReply, ORIGIN_ERROR, SESSION_ERROR } from "@/app/api/chauffeur/_lib/reply";

export async function POST(request: NextRequest) {
  const now = new Date();
  if (!isSameOriginRequest(request.headers)) {
    return jsonReply<SessionResponseBody>(403, { ok: false, code: "origin", error: ORIGIN_ERROR, serverTime: now.getTime() });
  }
  const user = await getCurrentUser();
  if (!user || user.role !== "DRIVER") {
    return jsonReply<SessionResponseBody>(401, { ok: false, code: "session", error: SESSION_ERROR, serverTime: now.getTime() });
  }
  const expiresAt = await renewDriverSession(user, now);
  return jsonReply<SessionResponseBody>(200, {
    ok: true,
    sessionExpiresAt: expiresAt?.toISOString() ?? null,
    serverTime: now.getTime(),
  });
}
