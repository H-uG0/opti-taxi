import "server-only";
import { db } from "@/lib/db";
import { PRESCRIBED_MODE_LABELS } from "@/lib/labels";
import { formatShortDate, toIsoDate } from "@/lib/time";
import type { FacilityOption, PrescriptionOption } from "../_components/recurrence-form";
import { findPredecessor, findRenewal, prescriptionValidity } from "./status";

/**
 * Choices of the recurrence form: active facilities (plus the one already
 * used, even if deactivated since) and this patient's prescriptions, each with
 * the PMT it renews and its renewal (the sessions use them before it starts
 * and after it ends). For a recurrence being edited, a PMT another series uses
 * elsewhere is left out of those (lib/domain/renewal.ts).
 */
export async function loadRecurrenceOptions(
  patientId: string,
  todayIso: string,
  currentFacilityId: string | null = null,
): Promise<{ facilities: FacilityOption[]; prescriptions: PrescriptionOption[] }> {
  const [facilities, prescriptions] = await Promise.all([
    db.facility.findMany({
      where: currentFacilityId ? { OR: [{ active: true }, { id: currentFacilityId }] } : { active: true },
      orderBy: [{ name: "asc" }],
      select: { id: true, name: true, city: true, active: true },
    }),
    db.prescription.findMany({
      where: { patientId },
      orderBy: [{ validTo: "desc" }],
      select: {
        id: true,
        mode: true,
        validFrom: true,
        validTo: true,
        recurrences: { where: { active: true }, select: { facilityId: true } },
      },
    }),
  ]);
  const series = new Set(currentFacilityId ? [currentFacilityId] : []);
  const range = (p: { validFrom: Date; validTo: Date } | null) =>
    p ? { validFrom: toIsoDate(p.validFrom), validTo: toIsoDate(p.validTo) } : null;

  return {
    facilities,
    prescriptions: prescriptions.map((p) => {
      const dates = { validFrom: toIsoDate(p.validFrom), validTo: toIsoDate(p.validTo) };
      const state = prescriptionValidity(dates, todayIso).state;
      const suffix = state === "expired" ? " — expirée" : state === "upcoming" ? " — à venir" : "";
      return {
        id: p.id,
        ...dates,
        previous: range(findPredecessor(p, prescriptions, series)),
        next: range(findRenewal(p, prescriptions, series)),
        label: `${PRESCRIBED_MODE_LABELS[p.mode]} · ${formatShortDate(dates.validFrom)} → ${formatShortDate(dates.validTo)}${suffix}`,
      };
    }),
  };
}
