/**
 * Turns recurrences ("dialyse lundi, mercredi, vendredi, RDV 7 h 30") into
 * trips for a date range. Idempotent: a trip is unique per
 * (recurrence, date, direction), so regenerating a week never duplicates.
 *
 * A trip needs a prescription valid on its date: the recurrence's own, or,
 * once it has ended (the renewal is not attached yet), another prescription of
 * the patient with the same mode that covers the date. Occurrences without
 * any are reported (skipped), never silently dropped.
 *
 * No server-only import: the seed calls generateTrips with its own client.
 * The server side (horizon, revival, audit) is lib/trips/completion.ts.
 */
import type { Prisma, PrescribedMode, RecurrenceLegs, SharingScope, SharingStatus, TripDirection } from "@prisma/client";
import { addDays, fromIsoDate, isoWeekday, toIsoDate } from "@/lib/time";
import { NO_CANCELLATION } from "./cancellation";
import { allowedVehicleTypesFor, formatAddress, initialSharingStatus, nextSharingStatus, sharingAllowedFor } from "./rules";

type Place = { address: string; postalCode: string; city: string; lat: number; lng: number };

export type PrescriptionForGeneration = {
  id: string;
  mode: PrescribedMode;
  sharing: SharingScope;
  validFrom: Date;
  validTo: Date;
};

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
  /** `prescriptions`: all the patient's prescriptions, to fall back on a renewal not attached yet. */
  patient: Place & { active: boolean; prescriptions?: readonly PrescriptionForGeneration[] };
  facility: Place;
  /** The prescription the recurrence is attached to. */
  prescription: Omit<PrescriptionForGeneration, "id">;
};

/** What a recurrence query includes for the generation (patient with all their prescriptions, facility, prescription). */
export const GENERATION_INCLUDE = {
  patient: { include: { prescriptions: { select: { id: true, mode: true, sharing: true, validFrom: true, validTo: true } } } },
  facility: true,
  prescription: true,
} satisfies Prisma.RecurrenceInclude;

function covers(p: { validFrom: Date; validTo: Date }, isoDate: string): boolean {
  return toIsoDate(p.validFrom) <= isoDate && isoDate <= toIsoDate(p.validTo);
}

/**
 * The prescription a trip of `rec` uses on `isoDate`: the recurrence's own when
 * it covers the date; otherwise the patient's other prescription of the same
 * mode covering it (the one lasting longest: a renewal). Null when none does.
 */
export function prescriptionOn(
  rec: Pick<RecurrenceForGeneration, "prescriptionId" | "prescription" | "patient">,
  isoDate: string,
): PrescriptionForGeneration | null {
  if (covers(rec.prescription, isoDate)) return { id: rec.prescriptionId, ...rec.prescription };
  let best: PrescriptionForGeneration | null = null;
  for (const p of rec.patient.prescriptions ?? []) {
    if (p.id === rec.prescriptionId || p.mode !== rec.prescription.mode || !covers(p, isoDate)) continue;
    const better =
      !best ||
      p.validTo.getTime() > best.validTo.getTime() ||
      (p.validTo.getTime() === best.validTo.getTime() && p.validFrom.getTime() > best.validFrom.getTime());
    if (better) best = p;
  }
  return best;
}

/** The recurrence plans a care session on this date (active, patient active, weekday and period), whatever the prescription. */
export function recurrenceOccursOn(
  rec: Pick<RecurrenceForGeneration, "active" | "weekdays" | "startDate" | "endDate"> & { patient: { active: boolean } },
  isoDate: string,
): boolean {
  if (!rec.active || !rec.patient.active) return false;
  if (!rec.weekdays.includes(isoWeekday(isoDate))) return false;
  if (isoDate < toIsoDate(rec.startDate)) return false;
  return !rec.endDate || isoDate <= toIsoDate(rec.endDate);
}

/** A session the recurrence plans but no prescription covers: no trip, reported to the regulator. */
export type SkippedOccurrence = { recurrenceId: string; patientId: string; date: string };

export type RecurrencePlan = { trips: Prisma.TripCreateManyInput[]; skipped: SkippedOccurrence[] };

/** Pure planning step: which trips the recurrences produce between fromIso and toIso (inclusive), and which sessions they skip. */
export function planRecurrenceTrips(recurrences: readonly RecurrenceForGeneration[], fromIso: string, toIso: string): RecurrencePlan {
  const trips: Prisma.TripCreateManyInput[] = [];
  const skipped: SkippedOccurrence[] = [];
  for (let date = fromIso; date <= toIso; date = addDays(date, 1)) {
    const serviceDate = fromIsoDate(date);
    for (const rec of recurrences) {
      if (!recurrenceOccursOn(rec, date)) continue;
      // A trip needs a valid prescription on its date.
      const prescription = prescriptionOn(rec, date);
      if (!prescription) {
        skipped.push({ recurrenceId: rec.id, patientId: rec.patientId, date });
        continue;
      }

      const home = rec.patient;
      const care = rec.facility;
      const { mode, sharing } = prescription;
      const common = {
        serviceDate,
        patientId: rec.patientId,
        prescriptionId: prescription.id,
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
  return { trips, skipped };
}

/** The trips of planRecurrenceTrips only. */
export function planTripsFromRecurrences(
  recurrences: readonly RecurrenceForGeneration[],
  fromIso: string,
  toIso: string,
): Prisma.TripCreateManyInput[] {
  return planRecurrenceTrips(recurrences, fromIso, toIso).trips;
}

/** Key of a recurrence trip, as the database's unique (recurrence, date, direction). */
export function recurrenceTripKey(recurrenceId: string, isoDate: string, direction: TripDirection): string {
  return `${recurrenceId}|${isoDate}|${direction}`;
}

export function plannedTripKey(trip: Prisma.TripCreateManyInput): string {
  return recurrenceTripKey(trip.recurrenceId ?? "", toIsoDate(new Date(trip.serviceDate)), trip.direction);
}

/**
 * What a trip the application cancelled becomes once its recurrence plans it
 * again (the cause is gone): the trip the generation would create now, on the
 * same row (its id, notes and audit trail stay). A refusal of shared transport
 * stays recorded; the planning starts afresh.
 */
export function revivalData(
  planned: Prisma.TripCreateManyInput,
  current: { sharingStatus: SharingStatus },
): Prisma.TripUncheckedUpdateManyInput {
  const sharingAllowed = planned.sharingAllowed ?? false;
  return {
    status: "PLANNED",
    ...NO_CANCELLATION,
    prescriptionId: planned.prescriptionId,
    facilityId: planned.facilityId,
    allowedVehicleTypes: planned.allowedVehicleTypes,
    pickupAddress: planned.pickupAddress,
    pickupLat: planned.pickupLat,
    pickupLng: planned.pickupLng,
    dropoffAddress: planned.dropoffAddress,
    dropoffLat: planned.dropoffLat,
    dropoffLng: planned.dropoffLng,
    appointmentMinute: planned.appointmentMinute ?? null,
    readyMinute: planned.readyMinute ?? null,
    sharingAllowed,
    sharingStatus: nextSharingStatus(current.sharingStatus, sharingAllowed),
    routeId: null,
    lockedVehicleId: null,
    plannedPickupMinute: null,
    plannedDropoffMinute: null,
    shared: false,
    detourKm: null,
    estimatedRevenue: null,
  };
}

/** Where clause of the recurrences that may produce trips between fromIso and toIso. */
export function recurrencesInRange(fromIso: string, toIso: string): Prisma.RecurrenceWhereInput {
  return {
    active: true,
    startDate: { lte: fromIsoDate(toIso) },
    OR: [{ endDate: null }, { endDate: { gte: fromIsoDate(fromIso) } }],
  };
}

/**
 * Creates the missing trips of [fromIso, toIso]. Existing trips (even edited or cancelled) are left untouched.
 * Takes a transaction client (a full PrismaClient also fits). Used by the seed; the application completes
 * the trips with lib/trips/completion.ts (horizon, revival of trips the application cancelled, audit).
 */
export async function generateTrips(
  prisma: Prisma.TransactionClient,
  fromIso: string,
  toIso: string,
): Promise<{ planned: number; created: number; skipped: SkippedOccurrence[] }> {
  const recurrences = await prisma.recurrence.findMany({ where: recurrencesInRange(fromIso, toIso), include: GENERATION_INCLUDE });
  const { trips, skipped } = planRecurrenceTrips(recurrences, fromIso, toIso);
  const { count } = await prisma.trip.createMany({ data: trips, skipDuplicates: true });
  return { planned: trips.length, created: count, skipped };
}
