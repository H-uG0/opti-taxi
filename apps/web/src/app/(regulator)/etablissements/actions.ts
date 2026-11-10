"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatAddress } from "@/lib/domain/rules";
import { evaluate } from "@/lib/optimizer/client";
import { refreshRoutes, withRefreshNotice } from "@/lib/planning/refresh-routes";
import { todayIso } from "@/lib/time";
import { activationEvent, alreadyInStateMessage } from "@/app/(regulator)/patients/_lib/audit-events";
import { idSchema } from "@/app/(regulator)/patients/_lib/form-parse";
import { EMPTY_SYNC, isEmptySync, withSyncNotice } from "@/app/(regulator)/patients/_lib/trip-sync";
import { SYNC_TX_OPTIONS, syncOpenTrips } from "@/app/(regulator)/patients/_lib/trip-sync-db";
import { formString, messageState, type ActionResult, type FormState } from "@/lib/forms";
import { parseFacilityForm } from "./_lib/schema";

const NOT_FOUND = "Établissement introuvable\u00a0: il a peut-être été supprimé. Rechargez la page.";
const CHANGED_MEANWHILE = "L'établissement vient d'être modifié depuis un autre poste\u00a0: rechargez la page.";

/** Facility names appear on the patient pages too. */
function revalidateReferential() {
  revalidatePath("/(regulator)/etablissements", "layout");
  revalidatePath("/(regulator)/patients", "layout");
}

// Every change below is traced (lib/audit.ts) in the transaction that writes it.

export async function createFacility(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const parsed = parseFacilityForm(formData);
  if (!parsed.success) return parsed.state;

  const facility = await db.$transaction(async (tx) => {
    const created = await tx.facility.create({ data: parsed.data, select: { id: true } });
    await audit(tx, user, { action: "facility.create", entity: "Facility", entityId: created.id });
    return created;
  });
  revalidateReferential();
  redirect(`/etablissements/${facility.id}`);
}

/**
 * Saves the facility; a new address is copied to the open trips to come that
 * lead to it (or leave from it). Those already in a route leave it, and the
 * routes they left are recomputed once the transaction has committed
 * (lib/planning/refresh-routes.ts).
 */
export async function updateFacility(facilityId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const id = idSchema.safeParse(facilityId);
  const parsed = parseFacilityForm(formData);
  if (!parsed.success) return parsed.state;
  if (!id.success) return messageState(NOT_FOUND, null);

  const existing = await db.facility.findUnique({
    where: { id: id.data },
    select: { id: true, address: true, postalCode: true, city: true, lat: true, lng: true },
  });
  if (!existing) return messageState(NOT_FOUND, null);

  const data = parsed.data;
  const today = todayIso();
  const place = { address: formatAddress(data), lat: data.lat, lng: data.lng };
  const moved = place.address !== formatAddress(existing) || data.lat !== existing.lat || data.lng !== existing.lng;

  const leftRoutes = new Set<string>();
  const summary = await db.$transaction(async (tx) => {
    await tx.facility.update({ where: { id: existing.id }, data });
    await audit(tx, user, { action: "facility.update", entity: "Facility", entityId: existing.id });
    if (!moved) return EMPTY_SYNC;
    return syncOpenTrips(
      tx,
      { facilityId: existing.id },
      () => ({ kind: "update", destination: { facilityId: existing.id, place } }),
      today,
      leftRoutes,
      user,
    );
  }, SYNC_TX_OPTIONS);
  const refresh = await refreshRoutes({ prisma: db, evaluate }, leftRoutes);

  revalidateReferential();
  if (!isEmptySync(summary)) revalidatePath("/", "layout");
  redirect(withRefreshNotice(withSyncNotice(`/etablissements/${existing.id}`, summary), refresh));
}

/**
 * Deactivation keeps the history and changes no trip. It is refused while
 * active recurrences still lead to the facility: they would keep generating
 * trips to a closed place.
 */
export async function setFacilityActive(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireUser("REGULATOR");
  const input = z
    .object({ facilityId: idSchema, active: z.enum(["true", "false"]).transform((v) => v === "true") })
    .safeParse({ facilityId: formString(formData, "facilityId"), active: formString(formData, "active") });
  if (!input.success) return { ok: false, message: "Demande invalide." };
  const { facilityId, active } = input.data;

  const count = await db.$transaction(async (tx) => {
    // Single statement, guarded on the opposite state (a stale page or a double
    // click writes and traces nothing); deactivation applies only if no active
    // recurrence uses the facility.
    const updated = await tx.facility.updateMany({
      where: active
        ? { id: facilityId, active: false }
        : { id: facilityId, active: true, recurrences: { none: { active: true } } },
      data: { active },
    });
    if (updated.count > 0) await audit(tx, user, activationEvent("facility", facilityId, active));
    return updated.count;
  });

  if (count === 0) {
    const facility = await db.facility.findUnique({
      where: { id: facilityId },
      select: { active: true, _count: { select: { recurrences: { where: { active: true } } } } },
    });
    if (!facility) return { ok: false, message: NOT_FOUND };
    if (facility.active === active) {
      revalidateReferential(); // the page was stale: show the current state
      return { ok: true, message: alreadyInStateMessage("facility", active) };
    }
    const n = facility._count.recurrences;
    // Changed between the write and this read (another regulator): let the page reload.
    if (active || n === 0) return { ok: false, message: CHANGED_MEANWHILE };
    return {
      ok: false,
      message: `Désactivation impossible\u00a0: ${n === 1 ? "1 récurrence active mène" : `${n} récurrences actives mènent`} à cet établissement. Désactivez-les ou changez leur établissement d'abord.`,
    };
  }

  revalidateReferential();
  return { ok: true, message: active ? "Établissement réactivé." : "Établissement désactivé." };
}
