"use server";

/**
 * « Corriger le statut » (FLD-02): the regulator records or fixes a stop's status after the fact, with the real time
 * and a reason from a list (lib/domain/stop-correction.ts), on a day already started or past (never a day to come).
 * The stop says it was corrected (completedSource CORRECTED, correctionReason), the account that did it is its author
 * (completedById), and the change is audited on the trip (stop.correct: the stop's kind, the status and the minute
 * from and to, the reason; for an absence, its reason stays on the trip, the trail only says it changed).
 *
 * The time keeps the route's statuses in their order, as « Fin de tournée » does (observed-time.ts previousStatusAt,
 * nextStatusAt): never before a status recorded on an earlier stop, nor after one on a later stop. Otherwise the
 * corrected stop would become the route's latest status (the crew's « Annuler » would jump to it) and pull the
 * crew's next taps forward to its time.
 */
import type { NoShowReason } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { NO_SHOW_REASONS } from "@/lib/domain/field-wait";
import { CORRECTION_REASONS, CORRECTION_TARGET_LABELS, currentTarget, decideCorrection } from "@/lib/domain/stop-correction";
import { nextStatusAt, previousStatusAt } from "@/app/chauffeur/_lib/observed-time";
import { logError } from "@/lib/log";
import { minuteOn } from "@/lib/planning/day-progress";
import { formatMinute, instantOfMinute, parseMinute, todayIso, toIsoDate } from "@/lib/time";
import type { PlanningActionResult } from "./actions";

const inputSchema = z.object({
  stopId: z.string().trim().min(1).max(64),
  target: z.enum(["PICKUP", "DROPOFF", "NO_SHOW", "NONE"]),
  time: z.string().max(5),
  reason: z.enum(CORRECTION_REASONS, { error: "Choisissez le motif de la correction." }),
  noShowReason: z.enum(NO_SHOW_REASONS).nullish(),
});

class ChangedMeanwhile extends Error {}

export async function correctStopStatus(input: {
  stopId: string;
  target: string;
  time: string;
  reason: string;
  noShowReason?: string | null;
}): Promise<PlanningActionResult> {
  const user = await requireUser("REGULATOR");
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    const reasonIssue = parsed.error.issues.find((issue) => issue.path[0] === "reason");
    return { ok: false, error: reasonIssue ? "Choisissez le motif de la correction." : "Demande invalide : rechargez la page." };
  }
  const { stopId, target, time, reason, noShowReason } = parsed.data;
  if (target === "NO_SHOW" && !noShowReason) return { ok: false, error: "Choisissez le motif de l'absence." };
  const minute = target === "NONE" ? null : parseMinute(time);
  if (target !== "NONE" && minute === null) return { ok: false, error: "Indiquez l'heure réelle (HH:MM)." };

  try {
    const stop = await db.routeStop.findUnique({
      where: { id: stopId },
      select: {
        id: true,
        sequence: true,
        kind: true,
        tripId: true,
        routeId: true,
        completedAt: true,
        route: { select: { serviceDate: true } },
        trip: { select: { status: true, noShowReason: true } },
      },
    });
    if (!stop) return { ok: false, error: "Arrêt introuvable (planning modifié entre-temps ?) : rechargez la page.", stale: true };
    const isoDate = toIsoDate(stop.route.serviceDate);
    const now = new Date();
    if (isoDate > todayIso(now)) return { ok: false, error: "Un statut se corrige le jour de la tournée ou après." };
    const routeStops = await db.routeStop.findMany({
      where: { routeId: stop.routeId },
      select: { id: true, sequence: true, kind: true, tripId: true, completedAt: true, trip: { select: { status: true } } },
    });
    const other = routeStops.find((s) => s.tripId === stop.tripId && s.kind !== stop.kind);
    const at = minute === null ? null : instantOfMinute(isoDate, minute);
    const decision = decideCorrection({
      kind: stop.kind,
      tripStatus: stop.trip.status,
      completedAt: stop.completedAt,
      otherAt: other?.completedAt ?? null,
      target,
      at,
      now,
      noShowReason: stop.trip.noShowReason,
      newNoShowReason: noShowReason ?? null,
    });
    if (!decision.ok) return { ok: false, error: decision.error };
    if (decision.completedAt) {
      // In the route's order, like a time typed in « Fin de tournée ».
      const recorded = routeStops.map((s) => ({ ...s, cancelled: s.trip.status === "CANCELLED" }));
      const previousAt = previousStatusAt(stop, recorded);
      const nextAt = nextStatusAt(stop, recorded);
      if (previousAt && decision.completedAt < previousAt) {
        return { ok: false, error: `Heure avant le statut d'un arrêt précédent de la tournée (${formatMinute(minuteOn(previousAt, isoDate))})\u00a0: vérifiez l'heure, ou corrigez d'abord cet arrêt.` };
      }
      if (nextAt && decision.completedAt > nextAt) {
        return { ok: false, error: `Heure après le statut d'un arrêt suivant de la tournée (${formatMinute(minuteOn(nextAt, isoDate))})\u00a0: vérifiez l'heure, ou corrigez d'abord cet arrêt.` };
      }
    }

    const from = currentTarget(stop.kind, stop.completedAt, stop.trip.status);
    const recorded = decision.completedAt !== null;
    const absent: NoShowReason | null = decision.tripStatus === "NO_SHOW" ? (noShowReason ?? null) : null;
    await db.$transaction(async (tx) => {
      // Guarded by what was read: the crew (or another regulator) may have recorded something meanwhile.
      const stopUpdate = await tx.routeStop.updateMany({
        where: { id: stop.id, completedAt: stop.completedAt },
        data: {
          completedAt: decision.completedAt,
          completedById: recorded ? user.id : null,
          completedReceivedAt: recorded ? now : null,
          completedSource: recorded ? "CORRECTED" : null,
          correctionReason: recorded ? reason : null,
        },
      });
      if (stopUpdate.count !== 1) throw new ChangedMeanwhile();
      const tripUpdate = await tx.trip.updateMany({
        where: { id: stop.tripId, status: stop.trip.status },
        data: { status: decision.tripStatus, noShowReason: absent },
      });
      if (tripUpdate.count !== 1) throw new ChangedMeanwhile();
      await audit(tx, user, {
        action: "stop.correct",
        entity: "Trip",
        entityId: stop.tripId,
        serviceDate: isoDate,
        details: {
          stopKind: stop.kind,
          status: { from, to: target },
          minute: { from: stop.completedAt ? minuteOn(stop.completedAt, isoDate) : null, to: minute },
          reason,
          // Never the absence's reason itself (health data): only that it changed.
          ...(absent !== null && stop.trip.noShowReason !== null && absent !== stop.trip.noShowReason ? { noShowReasonChanged: true } : {}),
        },
      });
    });
    revalidatePath("/planning");
    revalidatePath("/chauffeur");
    revalidatePath("/tableau-de-bord");
    const label = CORRECTION_TARGET_LABELS[target];
    return { ok: true, message: target === "NONE" ? "Statut retiré." : `Statut corrigé : ${label.toLowerCase()} à ${formatMinute(minute)}.` };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ChangedMeanwhile) {
      return { ok: false, error: "Le statut a changé entre-temps (saisi par l'équipage ?) : rechargez la page.", stale: true };
    }
    logError("[planning] correctStopStatus failed", error, { stopId });
    return { ok: false, error: "Correction impossible pour le moment : réessayez." };
  }
}
