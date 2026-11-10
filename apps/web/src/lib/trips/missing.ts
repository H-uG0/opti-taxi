/**
 * Active recurrences that plan a session on a date but have no trip that day
 * (whatever its status: a trip cancelled on purpose is not missing). Shown
 * before optimizing: « N récurrences actives sans course ce jour ». Pure.
 */
import { prescriptionOn, recurrenceOccursOn, type RecurrenceForGeneration } from "@/lib/domain/trip-generation";
import { formatPersonName } from "@/lib/names";

export type MissingRecurrence = {
  recurrenceId: string;
  patientId: string;
  patientName: string;
  /** Recurrence label, or its facility. */
  label: string;
  /** No prescription covers the date: no trip can be generated until one does. */
  withoutPrescription: boolean;
};

type NamedRecurrence = RecurrenceForGeneration & {
  label: string | null;
  patient: { firstName: string; lastName: string };
  facility: { name: string };
};

export function recurrencesWithoutTrip(
  recurrences: readonly NamedRecurrence[],
  withTrip: ReadonlySet<string>,
  isoDate: string,
): MissingRecurrence[] {
  return recurrences
    .filter((rec) => recurrenceOccursOn(rec, isoDate) && !withTrip.has(rec.id))
    .map((rec) => ({
      recurrenceId: rec.id,
      patientId: rec.patientId,
      patientName: formatPersonName(rec.patient),
      label: rec.label?.trim() || rec.facility.name,
      withoutPrescription: prescriptionOn(rec, isoDate) === null,
    }))
    .sort((a, b) => a.patientName.localeCompare(b.patientName, "fr"));
}
