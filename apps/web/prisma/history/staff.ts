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
 */
import type { AbsenceKind, Prisma, VehicleUnavailabilityKind } from "@prisma/client";
import { addDays, fromIsoDate, isoWeekday } from "@/lib/time";
import { unitFromKey } from "./hash";
import { historyAbsenceId, historyUnavailabilityId } from "./ids";

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

export type StaffEvents = {
  absences: Prisma.StaffAbsenceCreateManyInput[];
  unavailabilities: Prisma.VehicleUnavailabilityCreateManyInput[];
};

const ABSENCE_NOTES: Record<Exclude<AbsenceKind, "SICK" | "ON_CALL">, string> = {
  LEAVE: "Congés posés.",
  TRAINING: "Formation continue.",
  OTHER: "Rendez-vous personnel (journée).",
};

/** The absences and vehicles off the road that start on `isoDate` (people and vehicles in a stable order). */
export function planStaffEvents(
  isoDate: string,
  people: readonly StaffMember[],
  vehicleIds: readonly string[],
): StaffEvents {
  const weekday = isoWeekday(isoDate);
  const date = fromIsoDate(isoDate);
  const b = STAFF_BEHAVIOUR;
  const absences: Prisma.StaffAbsenceCreateManyInput[] = [];
  const unavailabilities: Prisma.VehicleUnavailabilityCreateManyInput[] = [];
  const absence = (driverId: string, kind: AbsenceKind, endDate: Date) => {
    absences.push({
      id: historyAbsenceId(isoDate, absences.length + 1),
      driverId,
      kind,
      startDate: date,
      endDate,
      note: kind === "SICK" || kind === "ON_CALL" ? null : ABSENCE_NOTES[kind],
    });
  };

  for (const person of [...people].sort((a, z) => a.id.localeCompare(z.id))) {
    if (!person.workDays.includes(weekday)) continue;
    if (weekday === 1 && unitFromKey(`leave:${isoDate}:${person.id}`) < b.weekOfLeave) {
      absence(person.id, "LEAVE", fromIsoDate(addDays(isoDate, 4)));
      continue;
    }
    const draw = unitFromKey(`absent:${isoDate}:${person.id}`);
    if (draw < b.sickDay) absence(person.id, "SICK", date);
    else if (draw < b.sickDay + b.trainingDay) absence(person.id, "TRAINING", date);
    else if (draw < b.sickDay + b.trainingDay + b.personalAppointment) absence(person.id, "OTHER", date);
  }

  if (weekday !== 7) {
    for (const vehicleId of [...vehicleIds].sort()) {
      const draw = unitFromKey(`garage:${isoDate}:${vehicleId}`);
      let kind: VehicleUnavailabilityKind | null = null;
      let days = 1;
      if (draw < b.garageDay) kind = "MAINTENANCE";
      else if (draw < b.garageDay + b.repair) [kind, days] = ["REPAIR", 2];
      if (!kind) continue;
      unavailabilities.push({
        id: historyUnavailabilityId(isoDate, unavailabilities.length + 1),
        vehicleId,
        kind,
        startDate: date,
        endDate: fromIsoDate(addDays(isoDate, days - 1)),
        note: kind === "MAINTENANCE" ? "Révision au garage." : "Réparation : pare-brise et rétroviseur.",
      });
    }
  }
  return { absences, unavailabilities };
}
