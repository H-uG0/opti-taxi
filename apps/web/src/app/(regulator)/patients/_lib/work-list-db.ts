import "server-only";
import { db } from "@/lib/db";
import { fromIsoDate, toIsoDate } from "@/lib/time";
import { findRenewal, formatRecurrenceSummary } from "./status";
import { prescriptionWorkItems, workListLimit, type WorkItem } from "./work-list";

/**
 * Number of prescriptions to handle (work-list.ts), for the navigation: one
 * count query, the same rule as needsPrescriptionWork.
 */
export async function countPrescriptionWork(todayIso: string): Promise<number> {
  const today = fromIsoDate(todayIso);
  const limit = fromIsoDate(workListLimit(todayIso));
  const rows = await db.$queryRaw<{ count: number }[]>`
    SELECT COUNT(DISTINCT r."prescriptionId")::int AS "count"
    FROM "Recurrence" r
    JOIN "Prescription" p ON p."id" = r."prescriptionId"
    JOIN "Patient" pa ON pa."id" = r."patientId"
    WHERE r."active" AND pa."active"
      AND p."validTo" <= ${limit}
      AND (r."endDate" IS NULL OR (r."endDate" > p."validTo" AND r."endDate" >= ${today}))`;
  return rows[0]?.count ?? 0;
}

/** The work list itself (read only). */
export async function loadPrescriptionWork(todayIso: string): Promise<WorkItem[]> {
  const recurrences = await db.recurrence.findMany({
    where: {
      active: true,
      patient: { active: true },
      prescription: { validTo: { lte: fromIsoDate(workListLimit(todayIso)) } },
    },
    select: {
      weekdays: true,
      appointmentMinute: true,
      label: true,
      startDate: true,
      endDate: true,
      facility: { select: { name: true } },
      prescription: { select: { id: true, mode: true, validFrom: true, validTo: true } },
      patient: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          city: true,
          prescriptions: { select: { id: true, mode: true, validFrom: true, validTo: true } },
        },
      },
    },
  });
  return prescriptionWorkItems(
    recurrences.map((r) => {
      const renewal = findRenewal(r.prescription, r.patient.prescriptions);
      return {
        startDate: toIsoDate(r.startDate),
        endDate: r.endDate ? toIsoDate(r.endDate) : null,
        summary: formatRecurrenceSummary({
          weekdays: r.weekdays,
          appointmentMinute: r.appointmentMinute,
          label: r.label,
          facilityName: r.facility.name,
        }),
        patient: { id: r.patient.id, name: `${r.patient.lastName.toUpperCase()} ${r.patient.firstName}`, city: r.patient.city },
        prescription: {
          id: r.prescription.id,
          mode: r.prescription.mode,
          validFrom: toIsoDate(r.prescription.validFrom),
          validTo: toIsoDate(r.prescription.validTo),
        },
        renewal: renewal
          ? { id: renewal.id, validFrom: toIsoDate(renewal.validFrom), validTo: toIsoDate(renewal.validTo) }
          : null,
      };
    }),
    todayIso,
  );
}
