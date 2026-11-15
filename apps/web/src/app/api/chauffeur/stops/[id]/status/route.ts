/**
 * POST /api/chauffeur/stops/:id/status — records one status of the driver
 * roadmap (« Pris en charge », « Déposé », « Patient absent » with its reason,
 * « Annuler », and « Arrivé » / « Annuler l'arrivée » on a pickup: FLD-01),
 * sent with fetch from the phone's queue (chauffeur/_lib/status-queue.ts)
 * instead of a server action: no page render in the answer, no roadmap.view
 * audit event per tap, and a stuck request does not hold the others (Next.js
 * sends server actions one at a time).
 *
 * Steps:
 * 1. same-site request (lib/auth/same-origin) and a current driver allowed to
 *    record statuses (currentDriver, lib/auth: the rules of requireDriver, the
 *    session version and password fingerprint checked as for every page). No
 *    redirect: a JSON 401 (or 403 "password") keeps the status in the phone's
 *    queue until the driver signs in again. The phone also says whose queue
 *    the status comes from (ownerId): sent under another account's cookie
 *    (shared phone, two tabs), it is answered 401 and waits for its owner;
 * 2. the stop and its route, checked against the session's driver (route's
 *    driver or crew mate; a stop id from the phone is never trusted);
 * 3. a replay of a status already in place (answer lost on the way back)
 *    succeeds at once without writing, whatever its age (step 4 would refuse
 *    an old one the server already has);
 * 4. the time of the gesture, bounded (observed-time.ts: never before the
 *    statuses already recorded on earlier stops), and the service day of that
 *    time (Europe/Paris): see chauffeur/_lib/access;
 * 5. the pure rules of chauffeur/_lib/transitions, and for « Patient absent »
 *    the minimum wait set in Paramètres (lib/domain/field-wait.ts);
 * 6. guarded updates in one transaction, so a concurrent change by the other
 *    crew member is detected instead of overwritten. The stop keeps who
 *    recorded it and when the server received it, and the same transaction
 *    writes the audit event on the trip (stop.pickup, stop.dropoff,
 *    stop.no_show, stop.undo_pickup, stop.undo_dropoff, stop.arrive,
 *    stop.undo_arrive; details.observedAt for a status sent later from the
 *    queue). The reason of an absence stays on the trip (Trip.noShowReason),
 *    never in the trail (it can be health data).
 * « Fin de tournée » (FLD-02): a forgotten status sent with the real time the
 * crew typed (declaredMinute) instead of the time of the gesture: today, or
 * the day before until 03:00 (access.ts lateEntryAccess); the time must be
 * past and keep the route's statuses in their order (boundDeclaredAt), the
 * 3 h bound of a gesture does not apply. The stop says it was entered
 * afterwards (completedSource DECLARED), the audit event gives the time
 * declared (details.declaredAt); no minimum wait is checked for an absence
 * declared afterwards (the crew vouches for it).
 *
 * Nothing is revalidated: the phone shows the status at once and refreshes
 * the roadmap a moment later, after a refusal too (the page is then stale).
 * The answer may renew a driver's session close to its end
 * (lib/auth/session-renewal.ts).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { lateEntryAccess, STOP_ACCESS_ERRORS, stopAccess } from "@/app/chauffeur/_lib/access";
import { boundDeclaredAt, boundObservedAt, nextStatusAt, previousStatusAt, TOO_OLD_ERROR } from "@/app/chauffeur/_lib/observed-time";
import { latestCompletedStopId } from "@/app/chauffeur/_lib/roadmap";
import { STOP_ACTIONS, type StatusErrorCode, type StatusResponseBody } from "@/app/chauffeur/_lib/status-protocol";
import { decideStopAction, isArrivalAction, stopAuditAction, stopWrite, type StopSnapshot } from "@/app/chauffeur/_lib/transitions";
import { audit } from "@/lib/audit";
import { currentDriver, type DriverAccount } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/auth/same-origin";
import { renewDriverSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { NO_SHOW_REASONS, noShowWaitIssue } from "@/lib/domain/field-wait";
import { logError } from "@/lib/log";
import { minuteOn } from "@/lib/planning/day-progress";
import { formatMinute, instantOfMinute, todayIso, toIsoDate } from "@/lib/time";
import { jsonReply, ORIGIN_ERROR, PASSWORD_ERROR, SESSION_ERROR } from "@/app/api/chauffeur/_lib/reply";

const stopIdSchema = z.string().trim().min(1).max(64);
const epochMs = z.number().int().nonnegative().max(8.64e15);
const bodySchema = z.object({
  action: z.enum(STOP_ACTIONS),
  observedAt: epochMs.nullish(),
  sentAt: epochMs.nullish(),
  /** Account whose queue on the phone holds the status (absent from a page loaded before this field existed). */
  ownerId: z.string().max(64).nullish(),
  /** « Patient absent »: the reason from the list (absent from a page loaded before FLD-01). */
  reason: z.enum(NO_SHOW_REASONS).nullish(),
  /** « Fin de tournée » (FLD-02): the real time typed by the crew, minute of the service day. */
  declaredMinute: z.number().int().min(0).max(24 * 60 - 1).nullish(),
});
type StatusBody = z.infer<typeof bodySchema>;

// The phone refreshes the roadmap after any refusal (driver-app.tsx), a conflict included.
const CONFLICT_ERROR = "Le statut a changé entre-temps (autre membre de l'équipage\u202f?). La feuille de route est actualisée.";
const SERVER_ERROR = "Enregistrement impossible pour le moment\u00a0: le statut reste gardé et sera renvoyé.";

type Recorded = { status: number; body: StatusResponseBody };

function failure(status: number, code: StatusErrorCode, error: string): Recorded {
  return { status, body: { ok: false, code, error, serverTime: Date.now() } };
}

class ConflictError extends Error {}

/** Why a time typed in « Fin de tournée » is refused, with the status it would cross. */
function declaredError(reason: "future" | "before-previous" | "after-next", bound: Date | null, isoDate: string): string {
  const at = bound ? formatMinute(minuteOn(bound, isoDate)) : "";
  if (reason === "future") return "Heure à venir\u00a0: saisissez l'heure réelle, déjà passée.";
  if (reason === "before-previous") return `Heure avant le statut déjà saisi de l'arrêt précédent (${at})\u00a0: vérifiez l'heure.`;
  return `Heure après le statut déjà saisi de l'arrêt suivant (${at})\u00a0: vérifiez l'heure.`;
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const receivedAt = new Date();
  if (!isSameOriginRequest(request.headers)) return reply(failure(403, "origin", ORIGIN_ERROR), null);
  const current = await currentDriver();
  if (!current.ok) {
    const refusal =
      current.reason === "password" ? failure(403, "password", PASSWORD_ERROR) : failure(401, "session", SESSION_ERROR);
    return reply(refusal, null);
  }
  const user = current.driver;

  const { id } = await context.params;
  const stopId = stopIdSchema.safeParse(id);
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  // Another account's status (its page still open on a phone now signed in as this one): never
  // recorded in this account's name; it waits on the phone for its owner's sign-in.
  if (body.success && body.data.ownerId && body.data.ownerId !== user.id) {
    return reply(failure(401, "session", SESSION_ERROR), null);
  }
  const recorded =
    stopId.success && body.success
      ? await recordStopStatus(user, stopId.data, body.data, receivedAt)
      : failure(400, "invalid", "Statut illisible\u00a0: actualisez la feuille de route.");

  // Any exchange with the phone renews a driver's session close to its end (never a revoked one:
  // currentDriver checked it above).
  const sessionExpiresAt = await renewDriverSession(user, receivedAt).catch((error: unknown) => {
    logError("[chauffeur] session renewal failed", error, { userId: user.id });
    return null;
  });
  return reply(recorded, sessionExpiresAt);
}

function reply({ status, body }: Recorded, sessionExpiresAt: Date | null) {
  return jsonReply(status, { ...body, sessionExpiresAt: sessionExpiresAt?.toISOString() ?? null });
}

function noop(message: string): Recorded {
  return { status: 200, body: { ok: true, outcome: "noop", message, serverTime: Date.now(), sessionExpiresAt: null } };
}

async function recordStopStatus(user: DriverAccount, stopId: string, input: StatusBody, receivedAt: Date): Promise<Recorded> {
  const { action } = input;
  const stop = await db.routeStop.findUnique({
    where: { id: stopId },
    select: {
      id: true,
      sequence: true,
      kind: true,
      completedAt: true,
      arrivedAt: true,
      startMinute: true,
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
  const latestId = latestCompletedStopId(routeStops.map((s) => ({ ...s, tripStatus: s.trip.status })));
  const snapshot: StopSnapshot = {
    kind: stop.kind,
    completedAt: stop.completedAt,
    tripStatus: stop.trip.status,
    isLatestCompleted: latestId === stop.id,
    arrivedAt: stop.arrivedAt,
  };
  // A replay of a status already in place (its first answer was lost: phone timeout, network cut) succeeds
  // before the time bounds, which would refuse it once old (the last dropoff of the evening, sent again the
  // next morning). Nothing is written: the bounds have nothing to protect. A noop never depends on the time.
  const replay = decideStopAction(action, snapshot, receivedAt);
  if (replay.type === "noop") return noop(replay.message);

  const isoDate = toIsoDate(stop.route.serviceDate);
  const recorded = routeStops.map((s) => ({ ...s, cancelled: s.trip.status === "CANCELLED" }));
  const declared = input.declaredMinute ?? null;
  let observed: { at: Date; deferred: boolean };
  if (declared !== null) {
    // « Fin de tournée »: a status, with the real time typed, on a day still open to it.
    if (action !== "PICKUP" && action !== "DROPOFF" && action !== "NO_SHOW") {
      return failure(400, "invalid", "Statut illisible\u00a0: actualisez la page.");
    }
    if (lateEntryAccess(stop.route, user.driverId, receivedAt) === "wrong-day") return failure(403, "wrong-day", STOP_ACCESS_ERRORS["wrong-day"]);
    const bounded = boundDeclaredAt({
      at: instantOfMinute(isoDate, declared),
      receivedAt,
      previousAt: previousStatusAt(stop, recorded),
      nextAt: nextStatusAt(stop, recorded),
    });
    if (!bounded.ok) return failure(422, "declared", declaredError(bounded.reason, bounded.bound, isoDate));
    observed = { at: bounded.at, deferred: true };
  } else {
    const gesture = boundObservedAt({
      observedAt: input.observedAt ?? null,
      sentAt: input.sentAt ?? null,
      receivedAt,
      // Never before the statuses already recorded on earlier stops of the route, nor a dropoff before its pickup.
      previousAt: previousStatusAt(stop, recorded),
    });
    if (!gesture.ok) return failure(422, "too-old", TOO_OLD_ERROR);
    // The service day is the day of the gesture: a status tapped at 23:55 and sent at 00:05 still counts.
    if (stopAccess(stop.route, user.driverId, todayIso(gesture.at)) === "wrong-day") {
      return failure(403, "wrong-day", STOP_ACCESS_ERRORS["wrong-day"]);
    }
    observed = gesture;
  }

  const decision = decideStopAction(action, snapshot, observed.at);
  if (decision.type === "refuse") return failure(409, "refused", decision.error);
  if (decision.type === "noop") return noop(decision.message);

  if (action === "NO_SHOW" && decision.tripStatus === "NO_SHOW" && declared === null) {
    // The minimum wait at the door before an absence (Paramètres, 0 by default: no check).
    const settings = await db.appSettings.findUnique({ where: { id: 1 }, select: { noShowMinWaitMin: true } });
    const issue = noShowWaitIssue({
      arrivedMinute: stop.arrivedAt ? minuteOn(stop.arrivedAt, isoDate) : null,
      plannedStartMinute: stop.startMinute,
      minWaitMin: settings?.noShowMinWaitMin ?? 0,
      atMinute: minuteOn(observed.at, isoDate),
    });
    if (issue) return failure(409, "wait", issue);
  }

  const arrival = isArrivalAction(action);
  // The time this request records (the arrival, or the status), for the audit of a status sent later.
  const recordedAt = arrival ? decision.arrivedAt : decision.completedAt;
  try {
    await db.$transaction(async (tx) => {
      // Guarded by the values the decision was computed from: zero rows means someone changed them meanwhile.
      const stopUpdate = arrival
        ? await tx.routeStop.updateMany({
            where: { id: stop.id, completedAt: stop.completedAt, arrivedAt: stop.arrivedAt },
            data: { arrivedAt: decision.arrivedAt ?? null },
          })
        : await tx.routeStop.updateMany({
            where: { id: stop.id, completedAt: stop.completedAt },
            data: stopWrite(decision, user.id, receivedAt, declared !== null ? "DECLARED" : null),
          });
      if (stopUpdate.count !== 1) throw new ConflictError();
      if (decision.tripStatus !== stop.trip.status) {
        const tripUpdate = await tx.trip.updateMany({
          where: { id: stop.tripId, status: stop.trip.status },
          data: {
            status: decision.tripStatus,
            // The reason of an absence goes with it, and leaves with it (« Annuler »).
            ...(decision.tripStatus === "NO_SHOW" ? { noShowReason: input.reason ?? null } : {}),
            ...(stop.trip.status === "NO_SHOW" ? { noShowReason: null } : {}),
          },
        });
        if (tripUpdate.count !== 1) throw new ConflictError();
      }
      await audit(tx, user, {
        action: stopAuditAction(action, stop.kind),
        entity: "Trip",
        entityId: stop.tripId,
        serviceDate: isoDate,
        // A status sent later from the queue: the time of the gesture (the event itself is dated on receipt); one typed
        // in « Fin de tournée »: the time declared.
        ...(declared !== null && recordedAt
          ? { details: { declaredAt: recordedAt.toISOString() } }
          : observed.deferred && recordedAt
            ? { details: { observedAt: recordedAt.toISOString() } }
            : {}),
      });
    });
  } catch (error) {
    if (error instanceof ConflictError) return failure(409, "conflict", CONFLICT_ERROR);
    logError("[chauffeur] stop status failed", error, { action, stopId: stop.id });
    return failure(500, "server", SERVER_ERROR);
  }

  return { status: 200, body: { ok: true, outcome: "applied", message: decision.message, serverTime: Date.now(), sessionExpiresAt: null } };
}
