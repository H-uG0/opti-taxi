/**
 * POST /api/chauffeur/routes/:id/odometer — a reading of the vehicle's odometer by its crew (FLD-03), at the start or
 * the end of the day, sent from the phone's queue like a status (offline too: chauffeur/_lib/status-queue.ts).
 *
 * Rules of the other driver routes: same-site request, current driver (JSON 401, no redirect; the reading waits on
 * the phone), the page's account (ownerId), the crew's own route (driver or crew mate), on a day still open at the
 * time of the gesture (today, the day before until 03:00: chauffeur/_lib/access.ts). The reading is checked against every mileage known of the
 * vehicle (lib/fleet/odometer.ts checkReading): never below the last one (fill-ups included) nor the day's start,
 * an unusual jump only once the crew confirms it. One reading per vehicle, day and moment: a new one replaces it.
 * Audited on the vehicle (odometer.record: details.moment, details.km { from, to }).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { lateEntryAccess, STOP_ACCESS_ERRORS } from "@/app/chauffeur/_lib/access";
import { boundObservedAt } from "@/app/chauffeur/_lib/observed-time";
import type { StatusErrorCode, StatusResponseBody } from "@/app/chauffeur/_lib/status-protocol";
import { MAX_ODOMETER_KM } from "@/app/(regulator)/vehicules/fleet-schema";
import { audit } from "@/lib/audit";
import { currentDriver } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/auth/same-origin";
import { renewDriverSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { checkReading } from "@/lib/fleet/odometer";
import { loadKmPoints } from "@/lib/fleet/odometer-load";
import { logError } from "@/lib/log";
import { toIsoDate } from "@/lib/time";
import { jsonReply, ORIGIN_ERROR, PASSWORD_ERROR, SESSION_ERROR } from "@/app/api/chauffeur/_lib/reply";

const epochMs = z.number().int().nonnegative().max(8.64e15);
const bodySchema = z.object({
  moment: z.enum(["START", "END"]),
  km: z.number().int().min(0).max(MAX_ODOMETER_KM),
  confirmed: z.boolean().nullish(),
  observedAt: epochMs.nullish(),
  sentAt: epochMs.nullish(),
  ownerId: z.string().max(64).nullish(),
});

type Recorded = { status: number; body: StatusResponseBody };

function failure(status: number, code: StatusErrorCode, error: string): Recorded {
  return { status, body: { ok: false, code, error, serverTime: Date.now() } };
}

function done(outcome: "applied" | "noop", message: string): Recorded {
  return { status: 200, body: { ok: true, outcome, message, serverTime: Date.now(), sessionExpiresAt: null } };
}

class ChangedMeanwhile extends Error {}

const nf = new Intl.NumberFormat("fr-FR");

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const receivedAt = new Date();
  if (!isSameOriginRequest(request.headers)) return reply(failure(403, "origin", ORIGIN_ERROR), null);
  const current = await currentDriver();
  if (!current.ok) return reply(current.reason === "password" ? failure(403, "password", PASSWORD_ERROR) : failure(401, "session", SESSION_ERROR), null);
  const user = current.driver;
  const { id } = await context.params;
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (body.success && body.data.ownerId && body.data.ownerId !== user.id) return reply(failure(401, "session", SESSION_ERROR), null);

  let recorded: Recorded;
  try {
    recorded = body.success && id.length <= 64 ? await record(user, id, body.data, receivedAt) : failure(400, "invalid", "Relevé illisible : saisissez-le de nouveau.");
  } catch (error) {
    if (error instanceof ChangedMeanwhile) recorded = failure(409, "conflict", "Relevé saisi entre-temps par l'autre membre de l'équipage : la page est actualisée.");
    else {
      logError("[chauffeur] odometer reading failed", error, { routeId: id });
      recorded = failure(500, "server", "Enregistrement impossible pour le moment : le relevé reste gardé et sera renvoyé.");
    }
  }
  const sessionExpiresAt = await renewDriverSession(user, receivedAt).catch(() => null);
  return reply(recorded, sessionExpiresAt);
}

function reply({ status, body }: Recorded, sessionExpiresAt: Date | null) {
  return jsonReply(status, { ...body, sessionExpiresAt: sessionExpiresAt?.toISOString() ?? null });
}

async function record(
  user: { id: string; role: "DRIVER" | "REGULATOR"; driverId: string; name?: string },
  routeId: string,
  input: z.infer<typeof bodySchema>,
  receivedAt: Date,
): Promise<Recorded> {
  const route = await db.route.findUnique({ where: { id: routeId }, select: { vehicleId: true, serviceDate: true, driverId: true, crewMateId: true } });
  // Same answer for a missing route and someone else's: no information leak.
  if (!route) return failure(403, "not-yours", STOP_ACCESS_ERRORS["not-yours"]);
  // The time of the gesture, bounded like a status (an old one is dated on receipt: the reading itself matters). It
  // decides whether the day is still open: typed offline at 02:55 and sent at 03:05, the reading still counts.
  const observed = boundObservedAt({ observedAt: input.observedAt ?? null, sentAt: input.sentAt ?? null, receivedAt, previousAt: null });
  const recordedAt = observed.ok ? observed.at : receivedAt;
  const access = lateEntryAccess(route, user.driverId, recordedAt);
  if (access !== "ok") return failure(403, access, access === "not-yours" ? STOP_ACCESS_ERRORS["not-yours"] : "Ce relevé se saisit le jour de la tournée (jusqu'à 03:00 le lendemain).");
  const isoDate = toIsoDate(route.serviceDate);
  const { moment, km } = input;

  const points = await loadKmPoints(db, route.vehicleId);
  const own = points.find((p) => p.date === isoDate && p.moment === moment);
  if (own && own.km === km) return done("noop", "Relevé déjà enregistré.");
  const startKm = moment === "END" ? (points.find((p) => p.date === isoDate && p.moment === "START")?.km ?? null) : null;
  const check = checkReading({
    km,
    date: isoDate,
    moment,
    others: points.filter((p) => !(p.date === isoDate && p.moment === moment)),
    startKm,
  });
  if (!check.ok && (check.kind === "refused" || !input.confirmed)) return failure(422, check.kind === "refused" ? "odometer" : "confirm", check.message);

  await db.$transaction(async (tx) => {
    const key = { vehicleId_serviceDate_moment: { vehicleId: route.vehicleId, serviceDate: route.serviceDate, moment } };
    const existing = await tx.odometerReading.findUnique({ where: key, select: { km: true } });
    if ((existing?.km ?? null) !== (own?.km ?? null)) throw new ChangedMeanwhile();
    const data = { km, recordedAt, recordedById: user.id, confirmed: !check.ok };
    await tx.odometerReading.upsert({ where: key, create: { vehicleId: route.vehicleId, serviceDate: route.serviceDate, moment, ...data }, update: data });
    await audit(tx, user, {
      action: "odometer.record",
      entity: "Vehicle",
      entityId: route.vehicleId,
      serviceDate: isoDate,
      details: { moment, km: { from: existing?.km ?? null, to: km } },
    });
  });
  return done("applied", `Compteur ${moment === "START" ? "au départ" : "au retour"} : ${nf.format(km)} km enregistré.`);
}
