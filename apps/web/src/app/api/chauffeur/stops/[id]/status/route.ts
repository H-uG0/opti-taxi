/**
 * POST /api/chauffeur/stops/:id/status — records one status of the driver
 * roadmap (« Pris en charge », « Déposé », « Patient absent », « Annuler »),
 * sent with fetch from the phone's queue (chauffeur/_lib/status-queue.ts)
 * instead of a server action: no page render in the answer, no roadmap.view
 * audit event per tap, and a stuck request does not hold the others (Next.js
 * sends server actions one at a time).
 *
 * Steps:
 * 1. same-site request (lib/auth/same-origin) and a current driver session
 *    (getCurrentUser: the session version and password fingerprint are
 *    checked as for every page). No redirect: a JSON 401 keeps the status in
 *    the phone's queue until the driver signs in again;
 * 2. the stop and its route, checked against the session's driver (route's
 *    driver or crew mate; a stop id from the phone is never trusted);
 * 3. the time of the gesture, bounded (observed-time.ts), and the service day
 *    of that time (Europe/Paris): see ./_lib/access;
 * 4. the pure rules of chauffeur/_lib/transitions (idempotent: a replay after
 *    a lost answer succeeds without writing twice);
 * 5. guarded updates in one transaction, so a concurrent change by the other
 *    crew member is detected instead of overwritten. The stop keeps who
 *    recorded it and when the server received it, and the same transaction
 *    writes the audit event on the trip (stop.pickup, stop.dropoff,
 *    stop.no_show, stop.undo_pickup, stop.undo_dropoff; details.observedAt
 *    for a status sent later from the queue).
 * Nothing is revalidated: the phone shows the status at once and refreshes
 * the roadmap a moment later. The answer may renew a driver's session close
 * to its end (lib/auth/session-renewal.ts).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { STOP_ACCESS_ERRORS, stopAccess } from "@/app/chauffeur/_lib/access";
import { boundObservedAt, TOO_OLD_ERROR } from "@/app/chauffeur/_lib/observed-time";
import { latestCompletedStopId } from "@/app/chauffeur/_lib/roadmap";
import { STOP_ACTIONS, type StatusErrorCode, type StatusResponseBody } from "@/app/chauffeur/_lib/status-protocol";
import { decideStopAction, stopAuditAction, stopWrite } from "@/app/chauffeur/_lib/transitions";
import { audit } from "@/lib/audit";
import { getCurrentUser, type SessionUser } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/auth/same-origin";
import { renewDriverSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { logError } from "@/lib/log";
import { todayIso, toIsoDate } from "@/lib/time";
import { jsonReply, ORIGIN_ERROR, PASSWORD_ERROR, SESSION_ERROR } from "@/app/api/chauffeur/_lib/reply";

const stopIdSchema = z.string().trim().min(1).max(64);
const epochMs = z.number().int().nonnegative().max(8.64e15);
const bodySchema = z.object({
  action: z.enum(STOP_ACTIONS),
  observedAt: epochMs.nullish(),
  sentAt: epochMs.nullish(),
});
type StatusBody = z.infer<typeof bodySchema>;

const CONFLICT_ERROR = "Le statut a changé entre-temps (autre membre de l'équipage ?). La feuille de route est actualisée.";
const SERVER_ERROR = "Enregistrement impossible pour le moment : le statut reste gardé et sera renvoyé.";

type Recorded = { status: number; body: StatusResponseBody };

function failure(status: number, code: StatusErrorCode, error: string): Recorded {
  return { status, body: { ok: false, code, error, serverTime: Date.now() } };
}

class ConflictError extends Error {}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const receivedAt = new Date();
  if (!isSameOriginRequest(request.headers)) return reply(failure(403, "origin", ORIGIN_ERROR), null);
  const user = await getCurrentUser();
  if (!user || user.role !== "DRIVER" || !user.driverId) return reply(failure(401, "session", SESSION_ERROR), null);
  if (user.mustChangePassword) return reply(failure(403, "password", PASSWORD_ERROR), null);

  const { id } = await context.params;
  const stopId = stopIdSchema.safeParse(id);
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  const recorded =
    stopId.success && body.success
      ? await recordStopStatus({ ...user, driverId: user.driverId }, stopId.data, body.data, receivedAt)
      : failure(400, "invalid", "Statut illisible : actualisez la feuille de route.");

  // Any exchange with the phone renews a driver's session close to its end (never a revoked one:
  // getCurrentUser checked it above).
  const sessionExpiresAt = await renewDriverSession(user, receivedAt).catch((error: unknown) => {
    logError("[chauffeur] session renewal failed", error, { userId: user.id });
    return null;
  });
  return reply(recorded, sessionExpiresAt);
}

function reply({ status, body }: Recorded, sessionExpiresAt: Date | null) {
  return jsonReply(status, { ...body, sessionExpiresAt: sessionExpiresAt?.toISOString() ?? null });
}

async function recordStopStatus(
  user: SessionUser & { driverId: string },
  stopId: string,
  input: StatusBody,
  receivedAt: Date,
): Promise<Recorded> {
  const { action } = input;
  const stop = await db.routeStop.findUnique({
    where: { id: stopId },
    select: {
      id: true,
      kind: true,
      completedAt: true,
      tripId: true,
      trip: { select: { status: true } },
      route: { select: { id: true, serviceDate: true, driverId: true, crewMateId: true } },
    },
  });
  // Same answer for a missing stop (deleted by a re-optimization) and someone else's stop: no information leak.
  if (!stop || stopAccess(stop.route, user.driverId, todayIso(receivedAt)) === "not-yours") {
    return failure(403, "not-yours", STOP_ACCESS_ERRORS["not-yours"]);
  }

  const routeStops = await db.routeStop.findMany({
    where: { routeId: stop.route.id },
    select: { id: true, sequence: true, kind: true, tripId: true, completedAt: true, trip: { select: { status: true } } },
  });
  // A dropoff is never recorded before its trip's pickup.
  const pickupAt =
    stop.kind === "DROPOFF"
      ? (routeStops.find((s) => s.tripId === stop.tripId && s.kind === "PICKUP")?.completedAt ?? null)
      : null;
  const observed = boundObservedAt({
    observedAt: input.observedAt ?? null,
    sentAt: input.sentAt ?? null,
    receivedAt,
    previousAt: pickupAt,
  });
  if (!observed.ok) return failure(422, "too-old", TOO_OLD_ERROR);
  // The service day is the day of the gesture: a status tapped at 23:55 and sent at 00:05 still counts.
  if (stopAccess(stop.route, user.driverId, todayIso(observed.at)) === "wrong-day") {
    return failure(403, "wrong-day", STOP_ACCESS_ERRORS["wrong-day"]);
  }

  const latestId = latestCompletedStopId(routeStops.map((s) => ({ ...s, tripStatus: s.trip.status })));
  const decision = decideStopAction(
    action,
    { kind: stop.kind, completedAt: stop.completedAt, tripStatus: stop.trip.status, isLatestCompleted: latestId === stop.id },
    observed.at,
  );
  if (decision.type === "refuse") return failure(409, "refused", decision.error);
  if (decision.type === "noop") {
    return { status: 200, body: { ok: true, outcome: "noop", message: decision.message, serverTime: Date.now(), sessionExpiresAt: null } };
  }

  try {
    await db.$transaction(async (tx) => {
      // Guarded by the values the decision was computed from: zero rows means someone changed them meanwhile.
      const stopUpdate = await tx.routeStop.updateMany({
        where: { id: stop.id, completedAt: stop.completedAt },
        data: stopWrite(decision, user.id, receivedAt),
      });
      if (stopUpdate.count !== 1) throw new ConflictError();
      if (decision.tripStatus !== stop.trip.status) {
        const tripUpdate = await tx.trip.updateMany({
          where: { id: stop.tripId, status: stop.trip.status },
          data: { status: decision.tripStatus },
        });
        if (tripUpdate.count !== 1) throw new ConflictError();
      }
      await audit(tx, user, {
        action: stopAuditAction(action, stop.kind),
        entity: "Trip",
        entityId: stop.tripId,
        serviceDate: toIsoDate(stop.route.serviceDate),
        // A status sent later from the queue: the time of the gesture (the event itself is dated on receipt).
        ...(observed.deferred && decision.completedAt ? { details: { observedAt: decision.completedAt.toISOString() } } : {}),
      });
    });
  } catch (error) {
    if (error instanceof ConflictError) return failure(409, "conflict", CONFLICT_ERROR);
    logError("[chauffeur] stop status failed", error, { action, stopId: stop.id });
    return failure(500, "server", SERVER_ERROR);
  }

  return { status: 200, body: { ok: true, outcome: "applied", message: decision.message, serverTime: Date.now(), sessionExpiresAt: null } };
}
