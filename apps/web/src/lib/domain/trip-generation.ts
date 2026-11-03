/**
 * Turns recurrences ("dialyse lundi, mercredi, vendredi, RDV 7 h 30") into
 * trips for a date range. Idempotent: a trip is unique per
 * (recurrence, date, direction), so regenerating a week never duplicates.
 *
 * No server-only import: the seed calls generateTrips with its own client.
 */
import type { Prisma, PrescribedMode, RecurrenceLegs, SharingScope } from "@prisma/client";
import { addDays, fromIsoDate, isoWeekday, toIsoDate } from "@/lib/time";
import { allowedVehicleTypesFor, formatAddress, initialSharingStatus, sharingAllowedFor } from "./rules";

type Place = { address: string; postalCode: string; city: string; lat: number; lng: number };

export type RecurrenceForGeneration = {
  id: string;
  patientId: string;
  facilityId: string;
  prescriptionId: string;
  weekdays: number[];
  appointmentMinute: number;
  sessionMinutes: number;
  legs: RecurrenceLegs;
  startDate: Date;
  endDate: Date | null;
  active: boolean;
  patient: Place & { active: boolean };
  facility: Place;
  prescription: { mode: PrescribedMode; sharing: SharingScope; validFrom: Date; validTo: Date };
};

/** Pure planning step: which trips the recurrences produce between fromIso and toIso (inclusive). */
export function planTripsFromRecurrences(
  recurrences: RecurrenceForGeneration[],
  fromIso: string,
  toIso: string,
): Prisma.TripCreateManyInput[] {
  const trips: Prisma.TripCreateManyInput[] = [];
  for (let date = fromIso; date <= toIso; date = addDays(date, 1)) {
    const weekday = isoWeekday(date);
    const serviceDate = fromIsoDate(date);
    for (const rec of recurrences) {
      if (!rec.active || !rec.patient.active) continue;
      if (!rec.weekdays.includes(weekday)) continue;
      if (date < toIsoDate(rec.startDate)) continue;
      if (rec.endDate && date > toIsoDate(rec.endDate)) continue;
      // A trip needs a valid prescription on its date.
      if (date < toIsoDate(rec.prescription.validFrom) || date > toIsoDate(rec.prescription.validTo)) continue;

      const home = rec.patient;
      const care = rec.facility;
      const { mode, sharing } = rec.prescription;
      const common = {
        serviceDate,
        patientId: rec.patientId,
        prescriptionId: rec.prescriptionId,
        recurrenceId: rec.id,
        facilityId: rec.facilityId,
        payer: "CPAM" as const,
        allowedVehicleTypes: allowedVehicleTypesFor(mode, "CPAM"),
      };

      if (rec.legs === "OUTBOUND" || rec.legs === "BOTH") {
        const sharingAllowed = sharingAllowedFor(sharing, "OUTBOUND", mode, "CPAM");
        trips.push({
          ...common,
          direction: "OUTBOUND",
          pickupAddress: formatAddress(home),
          pickupLat: home.lat,
          pickupLng: home.lng,
          dropoffAddress: formatAddress(care),
          dropoffLat: care.lat,
          dropoffLng: care.lng,
          appointmentMinute: rec.appointmentMinute,
          sharingAllowed,
          sharingStatus: initialSharingStatus(sharingAllowed),
        });
      }
      if (rec.legs === "RETURN" || rec.legs === "BOTH") {
        const sharingAllowed = sharingAllowedFor(sharing, "RETURN", mode, "CPAM");
        trips.push({
          ...common,
          direction: "RETURN",
          pickupAddress: formatAddress(care),
          pickupLat: care.lat,
          pickupLng: care.lng,
          dropoffAddress: formatAddress(home),
          dropoffLat: home.lat,
          dropoffLng: home.lng,
          readyMinute: rec.appointmentMinute + rec.sessionMinutes,
          sharingAllowed,
          sharingStatus: initialSharingStatus(sharingAllowed),
        });
      }
    }
  }
  return trips;
}

/**
 * Creates the missing trips of [fromIso, toIso]. Existing trips (even edited or cancelled) are left untouched.
 * Takes a transaction client (a full PrismaClient also fits) so callers can run it with their audit event.
 */
export async function generateTrips(
  prisma: Prisma.TransactionClient,
  fromIso: string,
  toIso: string,
): Promise<{ planned: number; created: number }> {
  const recurrences = await prisma.recurrence.findMany({
    where: {
      active: true,
      startDate: { lte: fromIsoDate(toIso) },
      OR: [{ endDate: null }, { endDate: { gte: fromIsoDate(fromIso) } }],
    },
    include: { patient: true, facility: true, prescription: true },
  });
  const data = planTripsFromRecurrences(recurrences, fromIso, toIso);
  const { count } = await prisma.trip.createMany({ data, skipDuplicates: true });
  return { planned: data.length, created: count };
}
