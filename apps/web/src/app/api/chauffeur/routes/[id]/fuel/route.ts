/**
 * POST /api/chauffeur/routes/:id/fuel — « Ajouter un plein ou une recharge » for the day's vehicle, by its crew
 * (FLD-03). The same form and checks as the regulator's (vehicules/fleet-schema.ts: the odometer, the quantity in L or
 * kWh, the amount, full tank or not), dated on the route's day; the odometer never below a mileage known on or before
 * that day (fill-ups and the crew's readings) nor above a later one. Online only: the phone says when nothing left.
 *
 * Rules of the other driver routes: same-site request, current driver (JSON 401, no redirect), the page's account
 * (ownerId), the crew's own route, on a day still open (today, the day before until 03:00). Audited on the fill-up
 * (fuel_log.create, details.vehicleId and details.source "driver").
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { lateEntryAccess, STOP_ACCESS_ERRORS } from "@/app/chauffeur/_lib/access";
import { fuelSchema, odometerConflict } from "@/app/(regulator)/vehicules/fleet-schema";
import { audit } from "@/lib/audit";
import { currentDriver } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/auth/same-origin";
import { renewDriverSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { energyUnit } from "@/lib/fleet/consumption";
import { loadKmPoints } from "@/lib/fleet/odometer-load";
import { fieldErrorsFromZod } from "@/lib/forms";
import { logError } from "@/lib/log";
import { fromIsoDate, toIsoDate } from "@/lib/time";
import { jsonReply, ORIGIN_ERROR, PASSWORD_ERROR, SESSION_ERROR } from "@/app/api/chauffeur/_lib/reply";

const bodySchema = z.object({
  odometerKm: z.string().max(20),
  quantity: z.string().max(20),
  cost: z.string().max(20),
  fullTank: z.boolean(),
  ownerId: z.string().max(64).nullish(),
});

export type FuelResponse =
  | { ok: true; message: string; serverTime: number; sessionExpiresAt: string | null }
  | {
      ok: false;
      code: "origin" | "session" | "password" | "invalid" | "not-yours" | "wrong-day" | "server";
      error: string;
      /** The form's fields and their message. */
      fieldErrors?: Partial<Record<"odometerKm" | "quantity" | "cost", string>>;
      serverTime: number;
    };

type Outcome = { status: number; body: FuelResponse };

function failure(status: number, code: Extract<FuelResponse, { ok: false }>["code"], error: string, fieldErrors?: Extract<FuelResponse, { ok: false }>["fieldErrors"]): Outcome {
  return { status, body: { ok: false, code, error, ...(fieldErrors ? { fieldErrors } : {}), serverTime: Date.now() } };
}

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
    outcome = body.success && id.length <= 64 ? await record(user, id, body.data, now) : failure(400, "invalid", "Plein illisible : saisissez-le de nouveau.");
  } catch (error) {
    logError("[chauffeur] fuel log failed", error, { routeId: id });
    outcome = failure(500, "server", "Enregistrement impossible pour le moment : réessayez.");
  }
  const sessionExpiresAt = await renewDriverSession(user, now).catch(() => null);
  return reply(outcome, sessionExpiresAt);
}

function reply({ status, body }: Outcome, sessionExpiresAt: Date | null) {
  return jsonReply<FuelResponse>(status, body.ok ? { ...body, sessionExpiresAt: sessionExpiresAt?.toISOString() ?? null } : body);
}

async function record(
  user: { id: string; role: "DRIVER" | "REGULATOR"; driverId: string; name?: string },
  routeId: string,
  input: z.infer<typeof bodySchema>,
  now: Date,
): Promise<Outcome> {
  const route = await db.route.findUnique({
    where: { id: routeId },
    select: { vehicleId: true, serviceDate: true, driverId: true, crewMateId: true, vehicle: { select: { energy: true } } },
  });
  if (!route) return failure(403, "not-yours", STOP_ACCESS_ERRORS["not-yours"]);
  const access = lateEntryAccess(route, user.driverId, now);
  if (access !== "ok") return failure(403, access, access === "not-yours" ? STOP_ACCESS_ERRORS["not-yours"] : "Un plein se saisit le jour de la tournée (jusqu'à 03:00 le lendemain).");
  const isoDate = toIsoDate(route.serviceDate);
  // The regulator's form and checks, the date set to the route's day.
  const values = { date: isoDate, odometerKm: input.odometerKm, quantity: input.quantity, cost: input.cost, fullTank: input.fullTank ? "on" : "", note: "" };
  const parsed = fuelSchema.safeParse(values);
  if (!parsed.success) {
    const { fieldErrors } = fieldErrorsFromZod(parsed.error);
    const pick = (name: "odometerKm" | "quantity" | "cost") => (fieldErrors[name] ? { [name]: fieldErrors[name] } : {});
    return failure(400, "invalid", "Vérifiez les champs signalés.", { ...pick("odometerKm"), ...pick("quantity"), ...pick("cost") });
  }
  const points = await loadKmPoints(db, route.vehicleId);
  const conflict = odometerConflict(parsed.data, points.map((p) => ({ date: p.date, odometerKm: p.km })));
  if (conflict) return failure(400, "invalid", "Vérifiez le compteur.", { odometerKm: conflict });
  const { date, ...rest } = parsed.data;
  await db.$transaction(async (tx) => {
    const created = await tx.fuelLog.create({
      data: { vehicleId: route.vehicleId, date: fromIsoDate(date), ...rest, note: null, recordedById: user.id },
      select: { id: true },
    });
    await audit(tx, user, { action: "fuel_log.create", entity: "FuelLog", entityId: created.id, serviceDate: isoDate, details: { vehicleId: route.vehicleId, source: "driver" } });
  });
  const unit = energyUnit(route.vehicle.energy);
  return {
    status: 200,
    body: {
      ok: true,
      message: `${unit === "kWh" ? "Recharge" : "Plein"} enregistré${unit === "kWh" ? "e" : ""} : la régulation le voit sur la fiche du véhicule.`,
      serverTime: Date.now(),
      sessionExpiresAt: null,
    },
  };
}
