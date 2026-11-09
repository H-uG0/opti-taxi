/**
 * POST /api/chauffeur/session — called by the roadmap when it opens, comes
 * back to the screen or gets the network back: renews a driver's session close
 * to its end (lib/auth/session-renewal.ts) and tells the phone when it ends,
 * for « Session valable jusqu'à HH:MM » and the warning 30 min before. Page
 * renders cannot set cookies, hence this small route. Reads nothing but the
 * account (currentDriverAccount, lib/auth: the rules of requireDriverAccount,
 * so a driver still on a provisional password is renewed too; a revoked
 * session gets a 401, never a renewal). It also says whether the session can
 * still be renewed later (renewals stop 7 days after the sign-in).
 *
 * The phone says which account its page belongs to (ownerId): when the cookie
 * is now another account's (shared phone, two tabs), the answer is 401, so the
 * page shows « Session expirée » and its waiting statuses stay on the phone.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import type { SessionResponseBody } from "@/app/chauffeur/_lib/status-protocol";
import { currentDriverAccount } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/auth/same-origin";
import { driverSessionRenewable, renewDriverSession } from "@/lib/auth/session";
import { jsonReply, ORIGIN_ERROR, SESSION_ERROR } from "@/app/api/chauffeur/_lib/reply";

const bodySchema = z.object({ ownerId: z.string().max(64).nullish() });

export async function POST(request: NextRequest) {
  const now = new Date();
  if (!isSameOriginRequest(request.headers)) {
    return jsonReply<SessionResponseBody>(403, { ok: false, code: "origin", error: ORIGIN_ERROR, serverTime: now.getTime() });
  }
  const user = await currentDriverAccount();
  // An unreadable body is read as no owner (a page loaded before the field existed).
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  const ownerId = body.success ? (body.data.ownerId ?? null) : null;
  if (!user || (ownerId !== null && ownerId !== user.id)) {
    return jsonReply<SessionResponseBody>(401, { ok: false, code: "session", error: SESSION_ERROR, serverTime: now.getTime() });
  }
  const expiresAt = await renewDriverSession(user, now);
  return jsonReply<SessionResponseBody>(200, {
    ok: true,
    sessionExpiresAt: expiresAt?.toISOString() ?? null,
    // Past the cap of renewals (lib/auth/session-renewal.ts): the roadmap says to sign in again before the end.
    renewable: await driverSessionRenewable(user, now),
    serverTime: now.getTime(),
  });
}
