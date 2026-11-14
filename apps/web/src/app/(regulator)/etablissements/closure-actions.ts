"use server";

import type { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { closureCancellationNote } from "@/lib/domain/facility-calendar";
import { periodFrom, type DatedPeriod } from "@/lib/domain/patient-absences";
import { idSchema, invalidState, messageState, readForm, successState, type FormState } from "@/lib/forms";
import { evaluate } from "@/lib/optimizer/client";
import { refreshNotice, refreshRoutes, withRefreshNotice } from "@/lib/planning/refresh-routes";
import { fromIsoDate, todayIso } from "@/lib/time";
import { completeTrips, currentHorizon, reviveOneOffTrips } from "@/lib/trips/completion";
import {
  CANCEL,
  describeSync,
  EMPTY_SYNC,
  isEmptySync,
  withCompletion,
  withSyncNotice,
  type SyncSummary,
} from "@/app/(regulator)/patients/_lib/trip-sync";
import { SYNC_TX_OPTIONS, syncOpenTrips } from "@/app/(regulator)/patients/_lib/trip-sync-db";
import { closureSchema } from "./_lib/closure-schema";

/**
 * Dated closures of a facility (« Fermetures » on its record). Adding one
 * cancels, in its transaction, the open trips to or from the facility on its
 * days (from today on) as the application: reason « établissement fermé »,
 * the dates as note, origin SYSTEM. Removing one brings them back from
 * tomorrow on, with the sessions not generated yet (lib/trips/completion.ts).
 */

const FACILITY_GONE = "Établissement introuvable : il a peut-être été supprimé. Rechargez la page.";

type Actor = Awaited<ReturnType<typeof requireUser>>;

function refreshPages(facilityId: string, summary: SyncSummary) {
  revalidatePath(`/etablissements/${facilityId}`);
  if (!isEmptySync(summary)) revalidatePath("/", "layout");
}

async function followClosures(
  tx: Prisma.TransactionClient,
  user: Actor,
  facilityId: string,
  closure: DatedPeriod | null,
  leftRoutes: Set<string>,
): Promise<SyncSummary> {
  const today = todayIso();
  let summary = EMPTY_SYNC;
  const days = closure ? periodFrom(closure, today) : null;
  if (closure && days) {
    const window = { gte: fromIsoDate(days.startDate), lte: fromIsoDate(days.endDate) };
    summary = await syncOpenTrips(tx, { facilityId, serviceDate: window }, () => CANCEL, today, leftRoutes, user, {
      cause: closureCancellationNote(closure),
      reason: "FACILITY_CLOSED",
    });
  }
  // Days no longer closed: their trips come back (from tomorrow on), and the sessions not generated yet are created.
  const completion = await completeTrips(tx, user, await currentHorizon(tx, today), { facilityId });
  const revivedOneOff = await reviveOneOffTrips(tx, user, { facilityId });
  return withCompletion(summary, { created: completion.created, revived: completion.revived + revivedOneOff });
}

async function answer(message: string, summary: SyncSummary, leftRoutes: Set<string>): Promise<FormState> {
  const refresh = await refreshRoutes({ prisma: db, evaluate }, leftRoutes);
  return successState([message, describeSync(summary), refreshNotice(refresh)].filter(Boolean).join(" "));
}

export async function addFacilityClosure(facilityId: string, _state: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const id = idSchema.safeParse(facilityId);
  if (!id.success) return messageState(FACILITY_GONE);
  const values = readForm(formData);
  const parsed = closureSchema.safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);
  const facility = await db.facility.findUnique({ where: { id: id.data }, select: { id: true } });
  if (!facility) return messageState(FACILITY_GONE);

  const { startDate, endDate, note } = parsed.data;
  const leftRoutes = new Set<string>();
  const summary = await db.$transaction(async (tx) => {
    const closure = await tx.facilityClosure.create({
      data: { facilityId: facility.id, startDate: fromIsoDate(startDate), endDate: fromIsoDate(endDate), note },
      select: { id: true },
    });
    await audit(tx, user, {
      action: "facility_closure.create",
      entity: "FacilityClosure",
      entityId: closure.id,
      details: { facilityId: facility.id, startDate, endDate },
    });
    return followClosures(tx, user, facility.id, { startDate, endDate }, leftRoutes);
  }, SYNC_TX_OPTIONS);
  refreshPages(facility.id, summary);
  return answer("Fermeture enregistrée.", summary, leftRoutes);
}

export async function deleteFacilityClosure(facilityId: string, closureId: string): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const facility = idSchema.safeParse(facilityId);
  const closure = idSchema.safeParse(closureId);
  if (!facility.success || !closure.success) return messageState("Demande invalide.");
  const [fid, cid] = [facility.data, closure.data];
  const leftRoutes = new Set<string>();
  const summary = await db.$transaction(async (tx) => {
    const removed = await tx.facilityClosure.deleteMany({ where: { id: cid, facilityId: fid } });
    if (removed.count === 0) return null;
    await audit(tx, user, { action: "facility_closure.delete", entity: "FacilityClosure", entityId: cid, details: { facilityId: fid } });
    return followClosures(tx, user, fid, null, leftRoutes);
  }, SYNC_TX_OPTIONS);
  if (!summary) {
    revalidatePath(`/etablissements/${fid}`);
    return successState("Cette fermeture était déjà supprimée.");
  }
  refreshPages(fid, summary);
  // The closure leaves the list (its button with it): the record says what came back, as after any save.
  const refresh = await refreshRoutes({ prisma: db, evaluate }, leftRoutes);
  redirect(withRefreshNotice(withSyncNotice(`/etablissements/${fid}?enregistre=1#calendrier`, summary), refresh));
}
