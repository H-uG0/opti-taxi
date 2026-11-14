/**
 * POST /api/chauffeur/roadmap — the roadmap checking for changes (DAY-04): called by the phone when the roadmap
 * opens, every 90 s while it is on screen and when it comes back to it. Each route of the crew on the date is
 * published when it changed (lib/planning/roadmap-sync.ts) and the phone is told, route by route, its fingerprint
 * (the page is stale when its own differs: it refreshes) and what changed since the crew last acknowledged it:
 * counts, times and opaque stop keys, never a name, an address or a note. The phone keeps none of it.
 *
 * With `ack` (« J'ai vu »), the version named is acknowledged first, with its audit event (roadmap.seen, on the
 * Route: details.version).
 *
 * Same rules as the other driver routes: same-site request, current driver (no redirect: a JSON 401), the page's
 * account (ownerId), and the dates a driver may read (today and tomorrow). The answer may renew the session.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { isReadableRoadmapDate } from "@/app/chauffeur/_lib/roadmap";
import { audit } from "@/lib/audit";
import { currentDriver } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/auth/same-origin";
import { renewDriverSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { logError } from "@/lib/log";
import { acknowledgeRoadmap, syncCrewRoadmaps, type CrewRoadmapState } from "@/lib/planning/roadmap-sync";
import { todayIso } from "@/lib/time";
import { jsonReply, ORIGIN_ERROR, PASSWORD_ERROR, SESSION_ERROR } from "@/app/api/chauffeur/_lib/reply";

const bodySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ack: z.object({ vehicleId: z.string().min(1).max(64), version: z.number().int().positive().max(100_000) }).nullish(),
  ownerId: z.string().max(64).nullish(),
});

export type RoadmapSyncResponse =
  | { ok: true; serverTime: number; routes: CrewRoadmapState[]; sessionExpiresAt: string | null }
  | { ok: false; code: "origin" | "session" | "password" | "invalid" | "server"; error: string; serverTime: number };

function failure(status: number, code: Extract<RoadmapSyncResponse, { ok: false }>["code"], error: string) {
  return jsonReply<RoadmapSyncResponse>(status, { ok: false, code, error, serverTime: Date.now() });
}

export async function POST(request: NextRequest) {
  const now = new Date();
  if (!isSameOriginRequest(request.headers)) return failure(403, "origin", ORIGIN_ERROR);
  const current = await currentDriver();
  if (!current.ok) return current.reason === "password" ? failure(403, "password", PASSWORD_ERROR) : failure(401, "session", SESSION_ERROR);
  const user = current.driver;
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success || !isReadableRoadmapDate(body.data.date, todayIso(now))) return failure(400, "invalid", "Date illisible\u00a0: actualisez la feuille de route.");
  if (body.data.ownerId && body.data.ownerId !== user.id) return failure(401, "session", SESSION_ERROR);
  const { date, ack } = body.data;

  try {
    if (ack) {
      await db.$transaction(async (tx) => {
        const seen = await acknowledgeRoadmap(tx, { isoDate: date, vehicleId: ack.vehicleId, version: ack.version, driverId: user.driverId, userId: user.id, now });
        if (seen) await audit(tx, user, { action: "roadmap.seen", entity: "Route", entityId: seen.routeId, serviceDate: date, details: { version: ack.version } });
      });
    }
    const routes = await syncCrewRoadmaps(db, { isoDate: date, driverId: user.driverId, userId: user.id, now });
    const sessionExpiresAt = await renewDriverSession(user, now).catch(() => null);
    return jsonReply<RoadmapSyncResponse>(200, { ok: true, serverTime: Date.now(), routes, sessionExpiresAt: sessionExpiresAt?.toISOString() ?? null });
  } catch (error) {
    logError("[chauffeur] roadmap sync failed", error, { date });
    return failure(500, "server", "Vérification impossible pour le moment.");
  }
}
