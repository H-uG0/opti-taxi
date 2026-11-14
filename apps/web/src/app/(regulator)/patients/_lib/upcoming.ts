/**
 * « Prochaines courses » of the patient record, grouped by day, with what each
 * trip allows (change, cancel, restore) and « Annuler ce jour ». Pure module:
 * the page builds the rows, the client component shows them (unit-tested).
 */
import type { CancellationOrigin, CancellationReason, PatientAbsenceKind, SharingStatus, TripDirection, TripStatus } from "@prisma/client";
import { cancellationLabel } from "@/lib/domain/cancellation";
import { planningAbsenceLabel } from "@/lib/domain/patient-absences";
import { DIRECTION_LABELS, SHARING_STATUS_LABELS, TRIP_STATUS_LABELS } from "@/lib/labels";
import { formatMinute, formatShortDate, toIsoDate } from "@/lib/time";

const STATUS_TONES: Record<TripStatus, string> = {
  PLANNED: "neutral",
  ASSIGNED: "brand",
  PICKED_UP: "info",
  DROPPED_OFF: "success",
  CANCELLED: "neutral",
  NO_SHOW: "warning",
};

export type UpcomingTrip = {
  id: string;
  date: string;
  direction: TripDirection;
  directionLabel: string;
  status: TripStatus;
  statusLabel: string;
  statusTone: string;
  /** "RDV 10:00", "Fin de séance 13:00". */
  timeText: string;
  /** "prise en charge 09:15" once planned. */
  plannedText: string | null;
  facility: string | null;
  oneOffAddress: boolean;
  notes: string | null;
  /** Why it was cancelled (« Hospitalisation (du … au …) »), null when not cancelled. */
  cancellation: string | null;
  shared: boolean;
  sharingLabel: string;
  sharingRefused: boolean;
  inRoute: boolean;
  canCancel: boolean;
  canRestore: boolean;
  editHref: string | null;
  /** « du 17/11/2026 (aller) »: names the trip in the buttons' labels and the question. */
  ariaName: string;
};

export type UpcomingDay = {
  date: string;
  /** "17/11/2026". */
  label: string;
  today: boolean;
  /** « Hospitalisation » / « Absence » when the patient is absent that day (planning wording, never the note). */
  absence: string | null;
  coursesHref: string;
  trips: UpcomingTrip[];
};

export type UpcomingTripInput = {
  id: string;
  serviceDate: Date;
  direction: TripDirection;
  status: TripStatus;
  appointmentMinute: number | null;
  readyMinute: number | null;
  plannedPickupMinute: number | null;
  routeId: string | null;
  oneOffAddress: boolean;
  notes: string | null;
  shared: boolean;
  sharingStatus: SharingStatus;
  cancellationReason: CancellationReason | null;
  cancellationOrigin: CancellationOrigin | null;
  cancellationNote: string | null;
  lateCancellation: boolean;
  facility: { name: string } | null;
};

const OPEN: readonly TripStatus[] = ["PLANNED", "ASSIGNED"];

/** The trips of the coming days, by day (then by time), with what the record lets do with each. */
export function upcomingDays(
  trips: readonly UpcomingTripInput[],
  absences: readonly { kind: PatientAbsenceKind; startDate: string; endDate: string }[],
  patientId: string,
  todayIso: string,
): UpcomingDay[] {
  const keyMinute = (t: UpcomingTripInput) => t.plannedPickupMinute ?? t.appointmentMinute ?? t.readyMinute ?? 0;
  const sorted = [...trips].sort(
    (a, b) => toIsoDate(a.serviceDate).localeCompare(toIsoDate(b.serviceDate)) || keyMinute(a) - keyMinute(b),
  );
  const days = new Map<string, UpcomingDay>();
  for (const t of sorted) {
    const date = toIsoDate(t.serviceDate);
    let day = days.get(date);
    if (!day) {
      const absence = absences.find((a) => a.startDate <= date && date <= a.endDate);
      day = {
        date,
        label: formatShortDate(date),
        today: date === todayIso,
        absence: absence ? planningAbsenceLabel(absence.kind) : null,
        coursesHref: `/courses?${new URLSearchParams({ date, patient: patientId }).toString()}`,
        trips: [],
      };
      days.set(date, day);
    }
    const open = OPEN.includes(t.status);
    const direction = DIRECTION_LABELS[t.direction];
    day.trips.push({
      id: t.id,
      date,
      direction: t.direction,
      directionLabel: direction,
      status: t.status,
      statusLabel: TRIP_STATUS_LABELS[t.status],
      statusTone: STATUS_TONES[t.status],
      timeText: t.direction === "OUTBOUND" ? `RDV ${formatMinute(t.appointmentMinute)}` : `Fin de séance ${formatMinute(t.readyMinute)}`,
      plannedText: t.plannedPickupMinute !== null ? `prise en charge ${formatMinute(t.plannedPickupMinute)}` : null,
      facility: t.facility?.name ?? null,
      oneOffAddress: t.oneOffAddress,
      notes: t.notes,
      cancellation: t.status === "CANCELLED" ? cancellationLabel(t) : null,
      shared: t.shared,
      sharingLabel: SHARING_STATUS_LABELS[t.sharingStatus],
      sharingRefused: t.sharingStatus === "REFUSED",
      inRoute: t.routeId !== null,
      canCancel: open,
      // A past day is never restored (restoreTrip refuses it too); a trip the application cancelled on a day the
      // patient is absent comes back by shortening the absence.
      canRestore: t.status === "CANCELLED" && date >= todayIso && !(day.absence !== null && t.cancellationOrigin === "SYSTEM"),
      editHref: open ? `/courses/${encodeURIComponent(t.id)}/modifier?retour=patient` : null,
      ariaName: `du ${formatShortDate(date)} (${direction.toLowerCase()})`,
    });
  }
  return [...days.values()];
}

/** « Annuler ce jour (aller et retour) » when the day's open trips are an outbound and a return, else « Annuler ce jour ». */
export function dayCancelLabel(open: readonly Pick<UpcomingTrip, "direction">[]): string {
  const both = open.some((t) => t.direction === "OUTBOUND") && open.some((t) => t.direction === "RETURN");
  return both ? "Annuler ce jour (aller et retour)" : "Annuler ce jour";
}

/** The question before cancelling a day: what goes, and the routes they leave. */
export function dayCancelQuestion(label: string, open: readonly Pick<UpcomingTrip, "direction" | "inRoute">[]): string {
  const outbound = open.filter((t) => t.direction === "OUTBOUND").length;
  const back = open.length - outbound;
  const what =
    open.length === 1
      ? outbound === 1
        ? "l'aller"
        : "le retour"
      : outbound === 1 && back === 1
        ? "l'aller et le retour"
        : `les ${open.length} courses`;
  const routed = open.filter((t) => t.inRoute).length;
  const routes =
    routed === 0
      ? ""
      : routed === 1
        ? " 1 course sera retirée de sa tournée."
        : ` ${routed} courses seront retirées de leur tournée.`;
  return `Annuler ${what} du ${label} ?${routes}`;
}
