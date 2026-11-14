import "server-only";
import { auditRead, type AuditActor } from "@/lib/audit";
import { db } from "@/lib/db";
import { MOBILITY_LABELS, PRESCRIBED_MODE_LABELS, SHARING_SCOPE_LABELS } from "@/lib/labels";
import { formatPersonName } from "@/lib/names";
import { addDays, formatShortDate, fromIsoDate, toIsoDate } from "@/lib/time";
import type { PatientOption } from "./new-trip-form";
import { usualFacility } from "./usual-facility";

/** How far back the latest trip of a patient without recurrence is looked for (its facility is proposed). */
const RECENT_TRIP_DAYS = 120;

/**
 * What « Nouvelle course » needs of the patient chosen: name and town, mobility,
 * the prescriptions still valid from today on, and the facility usually
 * attended (with the session length there). Only an active patient. The read
 * of their record is traced (patient.view).
 */
export async function loadTripPatient(user: AuditActor, patientId: string, todayIso: string): Promise<PatientOption | null> {
  const patient = await db.patient.findFirst({
    where: { id: patientId, active: true },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      city: true,
      mobility: true,
      prescriptions: {
        where: { validTo: { gte: fromIsoDate(todayIso) } },
        orderBy: { validFrom: "asc" },
        select: { id: true, mode: true, sharing: true, validFrom: true, validTo: true, prescriber: true },
      },
      recurrences: {
        where: { active: true },
        select: { facilityId: true, weekdays: true, sessionMinutes: true, createdAt: true },
      },
      trips: {
        where: { serviceDate: { gte: fromIsoDate(addDays(todayIso, -RECENT_TRIP_DAYS)) }, facilityId: { not: null } },
        orderBy: { serviceDate: "desc" },
        take: 5,
        select: { facilityId: true, serviceDate: true },
      },
    },
  });
  if (!patient) return null;
  await auditRead(user, { action: "patient.view", entity: "Patient", entityId: patient.id });

  const facilityIds = [...new Set([...patient.recurrences.map((r) => r.facilityId), ...patient.trips.flatMap((t) => (t.facilityId ? [t.facilityId] : []))])];
  const active = facilityIds.length
    ? await db.facility.findMany({ where: { id: { in: facilityIds }, active: true }, select: { id: true } })
    : [];
  const usual = usualFacility(
    patient.recurrences,
    patient.trips.map((t) => ({ facilityId: t.facilityId, serviceDate: toIsoDate(t.serviceDate) })),
    new Set(active.map((f) => f.id)),
  );

  return {
    id: patient.id,
    label: `${formatPersonName(patient)} — ${patient.city}`,
    mobilityLabel: MOBILITY_LABELS[patient.mobility],
    usualFacilityId: usual?.facilityId ?? null,
    usualSessionMinutes: usual?.sessionMinutes ?? null,
    prescriptions: patient.prescriptions.map((p) => {
      const validFrom = toIsoDate(p.validFrom);
      const validTo = toIsoDate(p.validTo);
      return {
        id: p.id,
        mode: p.mode,
        sharing: p.sharing,
        validFrom,
        validTo,
        label: [
          PRESCRIBED_MODE_LABELS[p.mode],
          `partage ${SHARING_SCOPE_LABELS[p.sharing].toLowerCase()}`,
          `du ${formatShortDate(validFrom)} au ${formatShortDate(validTo)}`,
          p.prescriber,
        ]
          .filter(Boolean)
          .join(" · "),
      };
    }),
  };
}
