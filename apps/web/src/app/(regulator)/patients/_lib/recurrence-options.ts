import "server-only";
import { db } from "@/lib/db";
import { PRESCRIBED_MODE_LABELS } from "@/lib/labels";
import { formatShortDate, toIsoDate } from "@/lib/time";
import type { FacilityOption, PrescriptionOption } from "../_components/recurrence-form";
import { prescriptionValidity } from "./status";

/**
 * Choices of the recurrence form: active facilities (plus the one already
 * used, even if deactivated since) and this patient's prescriptions.
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
      select: { id: true, mode: true, validFrom: true, validTo: true },
    }),
  ]);

  return {
    facilities,
    prescriptions: prescriptions.map((p) => {
      const dates = { validFrom: toIsoDate(p.validFrom), validTo: toIsoDate(p.validTo) };
      const state = prescriptionValidity(dates, todayIso).state;
      const suffix = state === "expired" ? " — expirée" : state === "upcoming" ? " — à venir" : "";
      return {
        id: p.id,
        ...dates,
        label: `${PRESCRIBED_MODE_LABELS[p.mode]} · ${formatShortDate(dates.validFrom)} → ${formatShortDate(dates.validTo)}${suffix}`,
      };
    }),
  };
}
