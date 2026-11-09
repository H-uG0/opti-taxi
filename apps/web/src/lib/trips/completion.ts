/**
 * Keeps the trips of the recurrences in place without a scheduled job: every
 * change that can add trips (a recurrence, a prescription or a patient
 * created, changed or reactivated), opening the planning or the trips of a
 * date, and « Optimiser » complete the trips of the horizon — from tomorrow
 * (never a day already begun) to D+N (setting tripHorizonDays). Always in the
 * transaction of the caller, with its audit events.
 *
 * Completing also brings back the trips the application cancelled (origin
 * SYSTEM: the referential sync) once their cause is gone — the recurrence
 * plans them again, or, for a one-off trip, its patient is active and its
 * prescription covers it again. A trip a person cancelled is never brought back.
 */
import "server-only";
import type { Prisma } from "@prisma/client";
import { audit, type AuditActor, type AuditEntry } from "@/lib/audit";
import {
  GENERATION_INCLUDE,
  planRecurrenceTrips,
  plannedTripKey,
  recurrencesInRange,
  recurrenceTripKey,
  revivalData,
  type RecurrenceForGeneration,
} from "@/lib/domain/trip-generation";
import { fromIsoDate, toIsoDate, tomorrowIso } from "@/lib/time";
import { oneOffRevival, type OneOffRevivalTrip } from "./revival";
import { DEFAULT_TRIP_HORIZON_DAYS, horizonOf, writableRange, type DateRange } from "./horizon";

export { DEFAULT_TRIP_HORIZON_DAYS, horizonOf, inHorizon, type DateRange } from "./horizon";

type Client = Prisma.TransactionClient;

/** The horizon setting, read only (a missing settings row means the default). */
export async function readTripHorizonDays(client: Pick<Client, "appSettings">): Promise<number> {
  const settings = await client.appSettings.findUnique({ where: { id: 1 }, select: { tripHorizonDays: true } });
  return settings?.tripHorizonDays ?? DEFAULT_TRIP_HORIZON_DAYS;
}

/** The horizon of today: from tomorrow to D+N. */
export async function currentHorizon(client: Pick<Client, "appSettings">, todayIso: string): Promise<DateRange> {
  return horizonOf(todayIso, await readTripHorizonDays(client));
}

/** A recurrence whose sessions had no prescription on some dates of the range: named for the regulator. */
export type SkippedRecurrence = {
  recurrenceId: string;
  patientId: string;
  patientName: string;
  /** Recurrence label, or its facility. */
  label: string;
  dates: string[];
};

export type Completion = {
  /** Trips created, per service day. */
  createdByDay: Map<string, number>;
  created: number;
  /** Trips the application had cancelled, brought back. */
  revived: number;
  skipped: SkippedRecurrence[];
};

export const NOTHING_COMPLETED: Completion = { createdByDay: new Map(), created: 0, revived: 0, skipped: [] };

type LoadedRecurrence = RecurrenceForGeneration & {
  label: string | null;
  patient: { firstName: string; lastName: string };
  facility: { name: string };
};

function skippedRecurrences(recurrences: readonly LoadedRecurrence[], skipped: ReturnType<typeof planRecurrenceTrips>["skipped"]) {
  const byRecurrence = new Map<string, SkippedRecurrence>();
  const recById = new Map(recurrences.map((r) => [r.id, r]));
  for (const occurrence of skipped) {
    const rec = recById.get(occurrence.recurrenceId);
    if (!rec) continue;
    const entry = byRecurrence.get(rec.id) ?? {
      recurrenceId: rec.id,
      patientId: rec.patientId,
      patientName: `${rec.patient.lastName.toUpperCase()} ${rec.patient.firstName}`,
      label: rec.label?.trim() || rec.facility.name,
      dates: [],
    };
    entry.dates.push(occurrence.date);
    byRecurrence.set(rec.id, entry);
  }
  return [...byRecurrence.values()].sort((a, b) => a.patientName.localeCompare(b.patientName, "fr"));
}

/**
 * Creates the missing trips of the recurrences matching `where` over `range`
 * (never before tomorrow), and brings back, from tomorrow on, their trips the
 * application cancelled that the recurrences plan again. Traced: one
 * trip.generate per day with trips created, one trip.revive per trip brought back.
 */
export async function completeTrips(
  tx: Client,
  actor: AuditActor,
  range: DateRange,
  where: Prisma.RecurrenceWhereInput = {},
): Promise<Completion> {
  const writable = writableRange(range, tomorrowIso());
  if (!writable) return { ...NOTHING_COMPLETED, createdByDay: new Map() };
  const { from } = writable;

  const recurrences: LoadedRecurrence[] = await tx.recurrence.findMany({
    where: { AND: [recurrencesInRange(from, range.to), where] },
    include: GENERATION_INCLUDE,
  });
  const plan = planRecurrenceTrips(recurrences, from, range.to);
  const created =
    plan.trips.length > 0
      ? await tx.trip.createManyAndReturn({ data: plan.trips, skipDuplicates: true, select: { serviceDate: true } })
      : [];
  const createdByDay = new Map<string, number>();
  for (const trip of created) {
    const day = toIsoDate(trip.serviceDate);
    createdByDay.set(day, (createdByDay.get(day) ?? 0) + 1);
  }

  const revived = await reviveRecurrenceTrips(tx, actor, { recurrence: { AND: [{ active: true }, where] } }, tomorrowIso());
  const events: AuditEntry[] = [...createdByDay].map(([day, count]) => ({
    action: "trip.generate",
    entity: "Trip",
    entityId: null,
    serviceDate: day,
    details: { created: count },
  }));
  await audit(tx, actor, events);
  return { createdByDay, created: created.length, revived, skipped: skippedRecurrences(recurrences, plan.skipped) };
}

/**
 * Brings back the trips of recurrences (matching `where`), from `fromIso` on,
 * that the application cancelled and that the recurrences plan again with the
 * same data the generation would create now. Returns how many.
 */
async function reviveRecurrenceTrips(tx: Client, actor: AuditActor, where: Prisma.TripWhereInput, fromIso: string): Promise<number> {
  const candidates = await tx.trip.findMany({
    where: {
      AND: [where, { recurrenceId: { not: null }, status: "CANCELLED", cancellationOrigin: "SYSTEM", serviceDate: { gte: fromIsoDate(fromIso) } }],
    },
    select: { id: true, recurrenceId: true, serviceDate: true, direction: true, sharingStatus: true },
  });
  if (candidates.length === 0) return 0;
  const dates = candidates.map((t) => toIsoDate(t.serviceDate)).sort();
  const first = dates[0] ?? fromIso;
  const last = dates.at(-1) ?? fromIso;
  const recurrences = await tx.recurrence.findMany({
    where: { id: { in: [...new Set(candidates.map((t) => t.recurrenceId ?? ""))] } },
    include: GENERATION_INCLUDE,
  });
  const planned = new Map(planRecurrenceTrips(recurrences, first, last).trips.map((trip) => [plannedTripKey(trip), trip]));

  const events: AuditEntry[] = [];
  for (const trip of candidates) {
    const day = toIsoDate(trip.serviceDate);
    const again = planned.get(recurrenceTripKey(trip.recurrenceId ?? "", day, trip.direction));
    if (!again) continue;
    // Guarded: a trip restored or changed meanwhile is left as it is.
    const { count } = await tx.trip.updateMany({
      where: { id: trip.id, status: "CANCELLED", cancellationOrigin: "SYSTEM" },
      data: revivalData(again, trip),
    });
    if (count > 0) events.push({ action: "trip.revive", entity: "Trip", entityId: trip.id, serviceDate: day });
  }
  await audit(tx, actor, events);
  return events.length;
}

/**
 * Brings back the one-off trips (no recurrence) matching `where`, from
 * tomorrow on, that the application cancelled and whose cause is gone: the
 * patient is active, the facility too, and a CPAM trip's prescription covers
 * its date (see oneOffRevival). Traced trip.revive. Returns how many.
 */
export async function reviveOneOffTrips(tx: Client, actor: AuditActor, where: Prisma.TripWhereInput): Promise<number> {
  const candidates: OneOffRevivalTrip[] = await tx.trip.findMany({
    where: {
      AND: [
        where,
        { recurrenceId: null, status: "CANCELLED", cancellationOrigin: "SYSTEM", serviceDate: { gte: fromIsoDate(tomorrowIso()) } },
      ],
    },
    select: {
      id: true,
      serviceDate: true,
      direction: true,
      payer: true,
      sharingStatus: true,
      pickupAddress: true,
      pickupLat: true,
      pickupLng: true,
      dropoffAddress: true,
      dropoffLat: true,
      dropoffLng: true,
      patient: { select: { active: true, address: true, postalCode: true, city: true, lat: true, lng: true } },
      prescription: { select: { mode: true, sharing: true, validFrom: true, validTo: true } },
      facility: { select: { active: true, address: true, postalCode: true, city: true, lat: true, lng: true } },
    },
  });
  const events: AuditEntry[] = [];
  for (const trip of candidates) {
    const data = oneOffRevival(trip);
    if (!data) continue;
    const { count } = await tx.trip.updateMany({ where: { id: trip.id, status: "CANCELLED", cancellationOrigin: "SYSTEM" }, data });
    if (count > 0) events.push({ action: "trip.revive", entity: "Trip", entityId: trip.id, serviceDate: toIsoDate(trip.serviceDate) });
  }
  await audit(tx, actor, events);
  return events.length;
}
