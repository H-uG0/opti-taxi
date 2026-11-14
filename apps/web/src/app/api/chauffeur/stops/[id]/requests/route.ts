/**
 * POST /api/chauffeur/stops/:id/requests — what a crew signals or asks from a stop of its roadmap (DAY-05,
 * lib/domain/field-requests.ts):
 * - from an outbound drop-off: « Patient prêt à HH:MM » (READY_TIME: the return's end of session changes at once,
 *   the regulator is told), « Demander un retour » when none is planned (RETURN), the next session of the series
 *   (NEXT_SESSION), the cancellation of the return (CANCEL with target "return");
 * - from a pickup still to do: the cancellation of its trip (CANCEL).
 * A cancellation or a return waits for the regulator (« À traiter » of the planning). Online only: the phone says
 * so when the request does not go through (no queue: the regulator may be called instead).
 *
 * Rules of the other driver routes: same-site request, current driver (JSON 401, no redirect), the page's account
 * (ownerId), the crew's own route, today only. Each request is written with its audit event (field_request.create on
 * the trip concerned, details.kind and details.requestId; a new end of session also trip.ready_time with
 * details.from and to, minutes). Never the reason in the trail (health data): it stays on the request.
 */
import type { Prisma, TripStatus } from "@prisma/client";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { STOP_ACCESS_ERRORS, stopAccess } from "@/app/chauffeur/_lib/access";
import { audit } from "@/lib/audit";
import { currentDriver } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/auth/same-origin";
import { renewDriverSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { FIELD_CANCEL_REASONS, nextSessionIssue, OPEN_TRIP_STATUSES, readyMinuteIssue } from "@/lib/domain/field-requests";
import { isSameEpisode } from "@/lib/domain/no-show";
import { logError } from "@/lib/log";
import { formatMinute, fromIsoDate, todayIso, toIsoDate } from "@/lib/time";
import { jsonReply, ORIGIN_ERROR, PASSWORD_ERROR, SESSION_ERROR } from "@/app/api/chauffeur/_lib/reply";

const bodySchema = z.object({
  kind: z.enum(["READY_TIME", "CANCEL", "RETURN", "NEXT_SESSION"]),
  readyMinute: z.number().int().min(0).max(1439).nullish(),
  reason: z.enum(FIELD_CANCEL_REASONS).nullish(),
  nextSessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  target: z.enum(["return"]).nullish(),
  ownerId: z.string().max(64).nullish(),
});
type RequestBody = z.infer<typeof bodySchema>;

export type FieldRequestResponse =
  | { ok: true; message: string; serverTime: number; sessionExpiresAt: string | null }
  | { ok: false; code: "origin" | "session" | "password" | "invalid" | "not-yours" | "wrong-day" | "refused" | "conflict" | "server"; error: string; serverTime: number };
type Failure = Extract<FieldRequestResponse, { ok: false }>;
type Outcome = { status: number; body: FieldRequestResponse };

function failure(status: number, code: Failure["code"], error: string): Outcome {
  return { status, body: { ok: false, code, error, serverTime: Date.now() } };
}

function done(message: string): Outcome {
  return { status: 200, body: { ok: true, message, serverTime: Date.now(), sessionExpiresAt: null } };
}

class ConflictError extends Error {}

const CONFLICT = "La course a changé entre-temps\u00a0: la feuille de route est actualisée.";
const SERVER_ERROR = "Envoi impossible pour le moment\u00a0: réessayez, ou appelez la régulation.";
const NO_RETURN = "Aucun retour ouvert pour ce patient aujourd'hui\u00a0: demandez un retour, ou appelez la régulation.";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const now = new Date();
  if (!isSameOriginRequest(request.headers)) return reply(failure(403, "origin", ORIGIN_ERROR), null);
  const current = await currentDriver();
  if (!current.ok) return reply(current.reason === "password" ? failure(403, "password", PASSWORD_ERROR) : failure(401, "session", SESSION_ERROR), null);
  const user = current.driver;
  const { id } = await context.params;
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (body.success && body.data.ownerId && body.data.ownerId !== user.id) return reply(failure(401, "session", SESSION_ERROR), null);
  let outcome: Outcome;
  try {
    outcome = body.success && id.length <= 64 ? await record(user, id, body.data, now) : failure(400, "invalid", "Demande illisible\u00a0: actualisez la feuille de route.");
  } catch (error) {
    if (error instanceof ConflictError) outcome = failure(409, "conflict", CONFLICT);
    else {
      logError("[chauffeur] field request failed", error, { stopId: id });
      outcome = failure(500, "server", SERVER_ERROR);
    }
  }
  const sessionExpiresAt = await renewDriverSession(user, now).catch(() => null);
  return reply(outcome, sessionExpiresAt);
}

function reply({ status, body }: Outcome, sessionExpiresAt: Date | null) {
  return jsonReply<FieldRequestResponse>(status, body.ok ? { ...body, sessionExpiresAt: sessionExpiresAt?.toISOString() ?? null } : body);
}

const TRIP_SELECT = {
  id: true,
  status: true,
  direction: true,
  serviceDate: true,
  appointmentMinute: true,
  readyMinute: true,
  patientId: true,
  recurrenceId: true,
  facilityId: true,
} satisfies Prisma.TripSelect;
type RequestTrip = Prisma.TripGetPayload<{ select: typeof TRIP_SELECT }>;

/** The return of the same care, the same day (any status but cancelled). */
async function returnOf(tx: Prisma.TransactionClient, outbound: RequestTrip): Promise<RequestTrip | null> {
  const returns = await tx.trip.findMany({
    where: { serviceDate: outbound.serviceDate, patientId: outbound.patientId, direction: "RETURN", status: { not: "CANCELLED" } },
    select: TRIP_SELECT,
    orderBy: { createdAt: "asc" },
  });
  return returns.find((back) => isSameEpisode(outbound, back)) ?? null;
}

async function record(user: { id: string; role: "DRIVER" | "REGULATOR"; driverId: string; name?: string }, stopId: string, input: RequestBody, now: Date): Promise<Outcome> {
  const stop = await db.routeStop.findUnique({
    where: { id: stopId },
    select: { id: true, kind: true, completedAt: true, route: { select: { serviceDate: true, driverId: true, crewMateId: true } }, trip: { select: TRIP_SELECT } },
  });
  if (!stop) return failure(403, "not-yours", STOP_ACCESS_ERRORS["not-yours"]);
  const access = stopAccess(stop.route, user.driverId, todayIso(now));
  if (access !== "ok") return failure(403, access, STOP_ACCESS_ERRORS[access]);
  const trip = stop.trip;
  const isoDate = toIsoDate(stop.route.serviceDate);
  const atDropoff = stop.kind === "DROPOFF" && trip.direction === "OUTBOUND";
  const event = (kind: string, tripId: string, requestId: string) =>
    ({ action: "field_request.create", entity: "Trip", entityId: tripId, serviceDate: isoDate, details: { kind, requestId } }) as const;

  if (input.kind === "CANCEL" && input.target !== "return") {
    if (stop.kind !== "PICKUP" || stop.completedAt !== null || !OPEN_TRIP_STATUSES.includes(trip.status)) {
      return failure(409, "refused", "Seule une course pas encore prise en charge peut être annulée.");
    }
    if (!input.reason) return failure(400, "invalid", "Choisissez un motif.");
    const reason = input.reason;
    return db.$transaction(async (tx) => {
      const pending = await tx.fieldRequest.findFirst({ where: { tripId: trip.id, kind: "CANCEL", status: "PENDING" }, select: { id: true } });
      if (pending) return done("Demande d'annulation déjà envoyée, en attente de la régulation.");
      const created = await tx.fieldRequest.create({ data: { serviceDate: trip.serviceDate, kind: "CANCEL", tripId: trip.id, cancellationReason: reason, createdById: user.id, createdAt: now }, select: { id: true } });
      await audit(tx, user, event("CANCEL", trip.id, created.id));
      return done("Demande d'annulation envoyée à la régulation.");
    });
  }

  if (!atDropoff) return failure(409, "refused", "Cette demande se fait depuis la dépose de l'aller.");

  return db.$transaction(async (tx) => {
    const back = await returnOf(tx, trip);
    const open = back !== null && OPEN_TRIP_STATUSES.includes(back.status);
    switch (input.kind) {
      case "READY_TIME": {
        if (!back || !open) return failure(409, "refused", NO_RETURN);
        if (input.readyMinute == null) return failure(400, "invalid", "Indiquez l'heure à laquelle le patient est prêt.");
        const issue = readyMinuteIssue(input.readyMinute, trip.appointmentMinute);
        if (issue) return failure(400, "invalid", issue);
        if (input.readyMinute === back.readyMinute) return done(`Fin de séance déjà à ${formatMinute(back.readyMinute)}.`);
        // Guarded on what was read: the regulator (or the other crew member) may have changed it meanwhile.
        const updated = await tx.trip.updateMany({
          where: { id: back.id, readyMinute: back.readyMinute, status: { in: [...OPEN_TRIP_STATUSES] as TripStatus[] } },
          data: { readyMinute: input.readyMinute },
        });
        if (updated.count !== 1) throw new ConflictError();
        // An earlier signal of the same session is replaced by this one.
        await tx.fieldRequest.updateMany({ where: { tripId: back.id, kind: "READY_TIME", status: "PENDING" }, data: { status: "NOTED", resolvedAt: now } });
        const created = await tx.fieldRequest.create({
          data: { serviceDate: back.serviceDate, kind: "READY_TIME", tripId: back.id, readyMinute: input.readyMinute, previousReadyMinute: back.readyMinute, createdById: user.id, createdAt: now },
          select: { id: true },
        });
        await audit(tx, user, [
          { action: "trip.ready_time", entity: "Trip", entityId: back.id, serviceDate: isoDate, details: { from: back.readyMinute, to: input.readyMinute, source: "field" } },
          event("READY_TIME", back.id, created.id),
        ]);
        return done(`Fin de séance transmise\u00a0: retour prêt à ${formatMinute(input.readyMinute)}.`);
      }
      case "CANCEL": {
        if (!back || !open) return failure(409, "refused", "Aucun retour à annuler pour ce patient aujourd'hui.");
        if (!input.reason) return failure(400, "invalid", "Choisissez un motif.");
        const pending = await tx.fieldRequest.findFirst({ where: { tripId: back.id, kind: "CANCEL", status: "PENDING" }, select: { id: true } });
        if (pending) return done("Demande d'annulation déjà envoyée, en attente de la régulation.");
        const created = await tx.fieldRequest.create({ data: { serviceDate: back.serviceDate, kind: "CANCEL", tripId: back.id, cancellationReason: input.reason, createdById: user.id, createdAt: now }, select: { id: true } });
        await audit(tx, user, event("CANCEL", back.id, created.id));
        return done("Demande d'annulation du retour envoyée à la régulation.");
      }
      case "RETURN": {
        if (back) return failure(409, "refused", `Un retour est déjà prévu${back.readyMinute !== null ? ` (fin de séance ${formatMinute(back.readyMinute)})` : ""}\u00a0: signalez plutôt l'heure de fin.`);
        if (input.readyMinute == null) return failure(400, "invalid", "Indiquez l'heure à laquelle le patient est prêt.");
        const issue = readyMinuteIssue(input.readyMinute, trip.appointmentMinute);
        if (issue) return failure(400, "invalid", issue);
        const pending = await tx.fieldRequest.findFirst({ where: { tripId: trip.id, kind: "RETURN", status: "PENDING" }, select: { id: true } });
        if (pending) return done("Demande de retour déjà envoyée, en attente de la régulation.");
        const created = await tx.fieldRequest.create({ data: { serviceDate: trip.serviceDate, kind: "RETURN", tripId: trip.id, readyMinute: input.readyMinute, createdById: user.id, createdAt: now }, select: { id: true } });
        await audit(tx, user, event("RETURN", trip.id, created.id));
        return done("Demande de retour envoyée à la régulation.");
      }
      case "NEXT_SESSION": {
        if (!input.nextSessionDate) return failure(400, "invalid", "Indiquez la date de la prochaine séance.");
        const issue = nextSessionIssue(input.nextSessionDate, isoDate);
        if (issue) return failure(400, "invalid", issue);
        await tx.fieldRequest.updateMany({ where: { tripId: trip.id, kind: "NEXT_SESSION", status: "PENDING" }, data: { status: "NOTED", resolvedAt: now } });
        const created = await tx.fieldRequest.create({
          data: { serviceDate: trip.serviceDate, kind: "NEXT_SESSION", tripId: trip.id, nextSessionDate: fromIsoDate(input.nextSessionDate), createdById: user.id, createdAt: now },
          select: { id: true },
        });
        await audit(tx, user, event("NEXT_SESSION", trip.id, created.id));
        return done("Prochaine séance transmise à la régulation.");
      }
    }
  });
}
