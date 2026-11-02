"use server";

/**
 * Status actions of the driver roadmap. Each one:
 * 1. authenticates the driver (requireDriver) before reading anything;
 * 2. loads the stop with its route and checks that the session's driver is the
 *    route's driver or crew mate (a stop id from the client is never trusted);
 * 3. only accepts routes of today (Europe/Paris): statuses are recorded on the day;
 * 4. applies the pure rules of ./_lib/transitions (idempotent: a replay after a
 *    lost response succeeds without writing twice);
 * 5. writes with guarded updates in one transaction, so a concurrent change by
 *    the other crew member is detected instead of being overwritten.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireDriver } from "@/lib/auth";
import { db } from "@/lib/db";
import { todayIso, toIsoDate } from "@/lib/time";
import { latestCompletedStopId } from "./_lib/roadmap";
import { decideStopAction, type StopAction } from "./_lib/transitions";

export type StopActionResult = { ok: true; message: string } | { ok: false; error: string };

const stopIdSchema = z.string().trim().min(1).max(64);

/** "Pris en charge" on a pickup stop. */
export async function markPickedUp(stopId: string): Promise<StopActionResult> {
  return runStopAction("PICKUP", stopId);
}

/** "Déposé" on a dropoff stop (its pickup must be recorded). */
export async function markDroppedOff(stopId: string): Promise<StopActionResult> {
  return runStopAction("DROPOFF", stopId);
}

/** "Patient absent" on a pickup stop: trip NO_SHOW, its dropoff is skipped. */
export async function markNoShow(stopId: string): Promise<StopActionResult> {
  return runStopAction("NO_SHOW", stopId);
}

/** "Annuler": clears the latest status recorded on the route (this stop only). */
export async function undoStopStatus(stopId: string): Promise<StopActionResult> {
  return runStopAction("UNDO", stopId);
}

class ConflictError extends Error {}

const CONFLICT_ERROR = "Le statut a changé entre-temps (autre membre de l'équipage ?). La feuille de route est actualisée.";

async function runStopAction(action: StopAction, rawStopId: unknown): Promise<StopActionResult> {
  const user = await requireDriver();

  const parsed = stopIdSchema.safeParse(rawStopId);
  if (!parsed.success) return { ok: false, error: "Arrêt inconnu." };

  const stop = await db.routeStop.findUnique({
    where: { id: parsed.data },
    select: {
      id: true,
      kind: true,
      completedAt: true,
      tripId: true,
      trip: { select: { status: true } },
      route: { select: { id: true, serviceDate: true, driverId: true, crewMateId: true } },
    },
  });
  // Same answer for a missing stop and someone else's stop: no information leak.
  if (!stop || (stop.route.driverId !== user.driverId && stop.route.crewMateId !== user.driverId)) {
    return { ok: false, error: "Cet arrêt ne fait pas partie de vos tournées." };
  }
  if (toIsoDate(stop.route.serviceDate) !== todayIso()) {
    return { ok: false, error: "Les statuts se saisissent uniquement le jour de la tournée." };
  }

  const routeStops = await db.routeStop.findMany({
    where: { routeId: stop.route.id },
    select: { id: true, sequence: true, kind: true, tripId: true, completedAt: true, trip: { select: { status: true } } },
  });
  const latestId = latestCompletedStopId(routeStops.map((s) => ({ ...s, tripStatus: s.trip.status })));

  const decision = decideStopAction(
    action,
    { kind: stop.kind, completedAt: stop.completedAt, tripStatus: stop.trip.status, isLatestCompleted: latestId === stop.id },
    new Date(),
  );

  if (decision.type === "refuse") {
    revalidatePath("/chauffeur");
    return { ok: false, error: decision.error };
  }
  if (decision.type === "noop") {
    revalidatePath("/chauffeur");
    return { ok: true, message: decision.message };
  }

  try {
    await db.$transaction(async (tx) => {
      // Guarded by the values the decision was computed from: zero rows means someone changed them meanwhile.
      const stopUpdate = await tx.routeStop.updateMany({
        where: { id: stop.id, completedAt: stop.completedAt },
        data: { completedAt: decision.completedAt },
      });
      if (stopUpdate.count !== 1) throw new ConflictError();
      if (decision.tripStatus !== stop.trip.status) {
        const tripUpdate = await tx.trip.updateMany({
          where: { id: stop.tripId, status: stop.trip.status },
          data: { status: decision.tripStatus },
        });
        if (tripUpdate.count !== 1) throw new ConflictError();
      }
    });
  } catch (error) {
    revalidatePath("/chauffeur");
    if (error instanceof ConflictError) return { ok: false, error: CONFLICT_ERROR };
    console.error("Driver stop action failed", { action, stopId: stop.id, error });
    return { ok: false, error: "Enregistrement impossible pour le moment. Réessayez dans un instant." };
  }

  revalidatePath("/chauffeur");
  return { ok: true, message: decision.message };
}
