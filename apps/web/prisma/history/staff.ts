/**
 * Absences and vehicles off the road on a simulated day (pure, unit-tested),
 * written before « Optimiser demain » so that the crews of the day are
 * resolved with them, as in the app (lib/staff/day-crews.ts proposes the
 * replacements). Drawn from stable keys: the same on every run.
 *
 * - On a Monday, a person takes a week of leave now and then (one row, Monday
 *   to Friday, owned by the Monday).
 * - Any working day: a sick day, a training day or a personal appointment.
 * - A vehicle goes to the garage for the day, or for two days of repair.
 * Sick days carry no note: a note never holds medical information.
 *
 * A row covers only dates the run simulates (`mayCover`): a week of leave or
 * a repair is cut short before today, before a date planned in the app and
 * before any date the run leaves alone, so it never changes the crews of a
 * day it does not own. A person already absent, or a vehicle already off the
 * road, over the dates of a new row gets none (rows of any origin, as the
 * seed's fleet avoids overlaps; rows of a previous simulation that start
 * after the date are ignored: their date is simulated again after this one).
 */
import type { AbsenceKind, Prisma, VehicleUnavailabilityKind } from "@prisma/client";
import { addDays, fromIsoDate, isoWeekday } from "@/lib/time";
import { unitFromKey } from "./hash";
import { historyAbsenceId, historyUnavailabilityId, isHistoryId } from "./ids";

export const STAFF_BEHAVIOUR = {
  /** Person, on a Monday they work: a week of leave starts. */
  weekOfLeave: 0.03,
  /** Person and working day. */
  sickDay: 0.012,
  trainingDay: 0.005,
  personalAppointment: 0.003,
  /** Vehicle and day (Monday to Saturday). */
  garageDay: 0.012,
  repair: 0.004,
} as const;

export type StaffMember = { id: string; workDays: readonly number[] };

/** An absence or a vehicle off the road already stored: its row id, its person or vehicle, its dates (inclusive). */
export type CoveredRange = { rowId: string; ownerId: string; from: string; to: string };

export type StaffDayOptions = {
  /** Whether a row starting on the simulated date may also cover this later date (a date the run simulates). */
  mayCover: (isoDate: string) => boolean;
  /** Absences and vehicles off the road stored over the dates a new row could cover (StaffAbsence, VehicleUnavailability). */
  absences: readonly CoveredRange[];
  unavailabilities: readonly CoveredRange[];
};

/** Longest row a simulated day starts (a week of leave, Monday to Friday): how far `absences` must be read. */
export const LONGEST_EVENT_DAYS = 5;

export type StaffEvents = {
  absences: Prisma.StaffAbsenceCreateManyInput[];
  unavailabilities: Prisma.VehicleUnavailabilityCreateManyInput[];
};

const ABSENCE_NOTES: Record<Exclude<AbsenceKind, "SICK" | "ON_CALL">, string> = {
  LEAVE: "Congés posés.",
  TRAINING: "Formation continue.",
  OTHER: "Rendez-vous personnel (journée).",
};

/** Last day of a row of `days` days starting on `isoDate`, cut before the first later date it may not cover. */
export function coveredUntil(isoDate: string, days: number, mayCover: (isoDate: string) => boolean): string {
  let last = isoDate;
  for (let offset = 1; offset < days; offset++) {
    const next = addDays(isoDate, offset);
    if (!mayCover(next)) break;
    last = next;
  }
  return last;
}

/**
 * Whether `ownerId` is already covered between `from` and `to` by a stored row
 * (a row of a previous simulation starting after `isoDate` excepted).
 */
function busy(stored: readonly CoveredRange[], isoDate: string, ownerId: string, from: string, to: string): boolean {
  return stored.some(
    (row) => row.ownerId === ownerId && row.from <= to && row.to >= from && !(isHistoryId(row.rowId) && row.from > isoDate),
  );
}

/** The absences and vehicles off the road that start on `isoDate` (people and vehicles in a stable order). */
export function planStaffEvents(
  isoDate: string,
  people: readonly StaffMember[],
  vehicleIds: readonly string[],
  options: StaffDayOptions,
): StaffEvents {
  const weekday = isoWeekday(isoDate);
  const date = fromIsoDate(isoDate);
  const b = STAFF_BEHAVIOUR;
  const absences: Prisma.StaffAbsenceCreateManyInput[] = [];
  const unavailabilities: Prisma.VehicleUnavailabilityCreateManyInput[] = [];
  const absence = (driverId: string, kind: AbsenceKind, until: string) => {
    if (busy(options.absences, isoDate, driverId, isoDate, until)) return;
    absences.push({
      id: historyAbsenceId(isoDate, absences.length + 1),
      driverId,
      kind,
      startDate: date,
      endDate: fromIsoDate(until),
      note: kind === "SICK" || kind === "ON_CALL" ? null : ABSENCE_NOTES[kind],
    });
  };

  for (const person of [...people].sort((a, z) => a.id.localeCompare(z.id))) {
    if (!person.workDays.includes(weekday)) continue;
    if (weekday === 1 && unitFromKey(`leave:${isoDate}:${person.id}`) < b.weekOfLeave) {
      absence(person.id, "LEAVE", coveredUntil(isoDate, LONGEST_EVENT_DAYS, options.mayCover));
      continue;
    }
    const draw = unitFromKey(`absent:${isoDate}:${person.id}`);
    if (draw < b.sickDay) absence(person.id, "SICK", isoDate);
    else if (draw < b.sickDay + b.trainingDay) absence(person.id, "TRAINING", isoDate);
    else if (draw < b.sickDay + b.trainingDay + b.personalAppointment) absence(person.id, "OTHER", isoDate);
  }

  if (weekday !== 7) {
    for (const vehicleId of [...vehicleIds].sort()) {
      const draw = unitFromKey(`garage:${isoDate}:${vehicleId}`);
      let kind: VehicleUnavailabilityKind | null = null;
      let days = 1;
      if (draw < b.garageDay) kind = "MAINTENANCE";
      else if (draw < b.garageDay + b.repair) [kind, days] = ["REPAIR", 2];
      if (!kind) continue;
      const until = coveredUntil(isoDate, days, options.mayCover);
      if (busy(options.unavailabilities, isoDate, vehicleId, isoDate, until)) continue;
      unavailabilities.push({
        id: historyUnavailabilityId(isoDate, unavailabilities.length + 1),
        vehicleId,
        kind,
        startDate: date,
        endDate: fromIsoDate(until),
        note: kind === "MAINTENANCE" ? "Révision au garage." : "Réparation : pare-brise et rétroviseur.",
      });
    }
  }
  return { absences, unavailabilities };
}
