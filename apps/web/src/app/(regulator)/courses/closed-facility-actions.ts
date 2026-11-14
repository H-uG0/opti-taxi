"use server";

import type { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { closedReasonText } from "@/lib/domain/facility-calendar";
import { formString, type ActionResult } from "@/lib/forms";
import { logError } from "@/lib/log";
import { evaluate } from "@/lib/optimizer/client";
import { isConcurrentWriteError, lockRoutesOfTrips, removeTripStops } from "@/lib/planning/detach";
import { refreshNotice, refreshRoutes } from "@/lib/planning/refresh-routes";
import { isIsoDate, todayIso } from "@/lib/time";
import { loadClosedFacilityTrips } from "@/lib/trips/closed-facilities-load";
import { BULK_CANCEL_MAX, tripIdSchema } from "./trip-form";

/** Interactive transaction: trips, route stops and their audit events. */
const TX_OPTIONS = { maxWait: 15_000, timeout: 60_000 } as const;

const shownIdsSchema = z
  .array(tripIdSchema)
  .min(1)
  .max(BULK_CANCEL_MAX)
  .transform((ids) => new Set(ids));

/**
 * « Annuler ces N courses » of the banner « Jour férié : N courses vers des
 * établissements fermés » (or of one facility of it): the trips the banner
 * showed (`tripId`, posted) that are still open trips of the date to a
 * facility closed that day, read again here — a trip the page did not show
 * (a facility unticked « ouvert les jours fériés » meanwhile) is never
 * cancelled. Each is cancelled by the regulator — reason « établissement
 * fermé », the cause as note (« jour férié (Armistice 1918) », « fermeture du
 * … au … »), never late —, taken out of its route and traced on its own
 * (trip.cancel). A cancellation by a person: it does not come back if the
 * facility turns out to be open.
 */
export async function cancelClosedFacilityTrips(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireUser("REGULATOR");
  const date = formString(formData, "date");
  if (!isIsoDate(date) || date < todayIso()) return { ok: false, message: "Date invalide ou passée : rechargez la page." };
  const shown = shownIdsSchema.safeParse(formData.getAll("tripId").filter((v): v is string => typeof v === "string"));
  if (!shown.success) return { ok: false, message: "Liste de courses invalide : rechargez la page." };

  const now = new Date();
  let cancelled = 0;
  let routeIds: string[] = [];
  try {
    await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const { holiday, groups } = await loadClosedFacilityTrips(tx, date);
      // Only the trips shown that still are to a closed facility: never one the page did not show.
      const kept = groups.map((g) => ({ ...g, tripIds: g.tripIds.filter((id) => shown.data.has(id)) }));
      await lockRoutesOfTrips(tx, kept.flatMap((g) => g.tripIds));
      for (const group of kept) {
        const note =
          group.reason.kind === "holiday" && holiday ? `jour férié (${holiday.label})` : closedReasonText(group.reason);
        for (const tripId of group.tripIds) {
          const { count } = await tx.trip.updateMany({
            where: { id: tripId, status: { in: ["PLANNED", "ASSIGNED"] } },
            data: {
              status: "CANCELLED",
              routeId: null,
              lockedVehicleId: null,
              plannedPickupMinute: null,
              plannedDropoffMinute: null,
              shared: false,
              detourKm: null,
              estimatedRevenue: null,
              cancellationReason: "FACILITY_CLOSED",
              cancellationOrigin: "USER",
              cancellationNote: note,
              cancelledAt: now,
              cancelledById: user.id,
              lateCancellation: false,
            },
          });
          if (count === 0) continue;
          cancelled += 1;
          await audit(tx, user, {
            action: "trip.cancel",
            entity: "Trip",
            entityId: tripId,
            serviceDate: date,
            details: { bulk: true, cause: "closed_facility" },
          });
          const removed = await removeTripStops(tx, tripId);
          routeIds = [...new Set([...routeIds, ...removed.routeIds])];
        }
      }
    }, TX_OPTIONS);
  } catch (error) {
    if (isConcurrentWriteError(error)) return { ok: false, message: "Les courses ont changé entre-temps : rechargez la page, rien n'a été annulé." };
    logError("[courses] cancelClosedFacilityTrips failed", error, { date });
    return { ok: false, message: "L'annulation a échoué. Réessayez ou contactez l'administrateur." };
  }
  const skipped = shown.data.size - cancelled;
  // Started, cancelled or no longer to a closed facility since the page was shown.
  const gone = skipped === 1 ? " 1 course n'était plus à annuler." : skipped > 1 ? ` ${skipped} courses n'étaient plus à annuler.` : "";
  if (cancelled === 0) {
    for (const path of ["/courses", "/planning"]) revalidatePath(path);
    return { ok: false, message: "Plus aucune de ces courses n'est à annuler : rechargez la page." };
  }
  const refresh = await refreshRoutes({ prisma: db, evaluate }, routeIds);
  for (const path of ["/courses", "/planning", "/arrivees-partagees", "/chauffeur", "/tableau-de-bord"]) revalidatePath(path);
  const what = cancelled === 1 ? "1 course annulée" : `${cancelled} courses annulées`;
  return { ok: true, message: [`${what} (établissement fermé).${gone}`, refreshNotice(refresh)].filter(Boolean).join(" ") };
}
