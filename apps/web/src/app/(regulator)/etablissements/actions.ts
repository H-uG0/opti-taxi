"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatAddress } from "@/lib/domain/rules";
import { todayIso } from "@/lib/time";
import { idSchema } from "@/app/(regulator)/patients/_lib/form-parse";
import { EMPTY_SYNC, isEmptySync, withSyncNotice } from "@/app/(regulator)/patients/_lib/trip-sync";
import { SYNC_TX_OPTIONS, syncOpenTrips } from "@/app/(regulator)/patients/_lib/trip-sync-db";
import {
  formString,
  messageState,
  type ActionResult,
  type FormState,
} from "@/app/(regulator)/patients/_lib/form-state";
import { parseFacilityForm } from "./_lib/schema";

const NOT_FOUND = "Établissement introuvable : il a peut-être été supprimé. Rechargez la page.";

/** Facility names appear on the patient pages too. */
function revalidateReferential() {
  revalidatePath("/(regulator)/etablissements", "layout");
  revalidatePath("/(regulator)/patients", "layout");
}

export async function createFacility(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireUser("REGULATOR");
  const parsed = parseFacilityForm(formData);
  if (!parsed.success) return parsed.state;

  const facility = await db.facility.create({ data: parsed.data, select: { id: true } });
  revalidateReferential();
  redirect(`/etablissements/${facility.id}`);
}

/** Saves the facility; a new address is copied to the open trips to come that lead to it (or leave from it). */
export async function updateFacility(facilityId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  await requireUser("REGULATOR");
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

  const summary = await db.$transaction(async (tx) => {
    await tx.facility.update({ where: { id: existing.id }, data });
    if (!moved) return EMPTY_SYNC;
    return syncOpenTrips(
      tx,
      { facilityId: existing.id },
      () => ({ kind: "update", destination: { facilityId: existing.id, place } }),
      today,
    );
  }, SYNC_TX_OPTIONS);

  revalidateReferential();
  if (!isEmptySync(summary)) revalidatePath("/", "layout");
  redirect(withSyncNotice(`/etablissements/${existing.id}`, summary));
}

/**
 * Deactivation keeps the history. It is refused while active recurrences still
 * lead to the facility: they would keep generating trips to a closed place.
 */
export async function setFacilityActive(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireUser("REGULATOR");
  const input = z
    .object({ facilityId: idSchema, active: z.enum(["true", "false"]).transform((v) => v === "true") })
    .safeParse({ facilityId: formString(formData, "facilityId"), active: formString(formData, "active") });
  if (!input.success) return { ok: false, message: "Demande invalide." };
  const { facilityId, active } = input.data;

  if (!active) {
    // Single statement: deactivates only if no active recurrence uses the facility.
    const { count } = await db.facility.updateMany({
      where: { id: facilityId, recurrences: { none: { active: true } } },
      data: { active: false },
    });
    if (count === 0) {
      const facility = await db.facility.findUnique({
        where: { id: facilityId },
        select: { _count: { select: { recurrences: { where: { active: true } } } } },
      });
      if (!facility) return { ok: false, message: NOT_FOUND };
      const n = facility._count.recurrences;
      return {
        ok: false,
        message: `Désactivation impossible : ${n === 1 ? "1 récurrence active mène" : `${n} récurrences actives mènent`} à cet établissement. Désactivez-les ou changez leur établissement d'abord.`,
      };
    }
  } else {
    const { count } = await db.facility.updateMany({ where: { id: facilityId }, data: { active: true } });
    if (count === 0) return { ok: false, message: NOT_FOUND };
  }

  revalidateReferential();
  return { ok: true, message: active ? "Établissement réactivé." : "Établissement désactivé." };
}
