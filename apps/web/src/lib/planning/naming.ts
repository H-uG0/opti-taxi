/**
 * How the planning names a trip and a violation in a list (the plan waiting for confirmation, its
 * « Changements », the per-vehicle choice, the draft): « MARTIN Jeanne (aller, RDV 08:30) »,
 * « Hors fenêtre horaire — Taxi 1, MARTIN Jeanne (aller, RDV 08:30) ». Pure module.
 */
import type { TripDirection } from "@prisma/client";
import { VIOLATION_LABELS } from "@/lib/labels";
import { formatMinute } from "@/lib/time";

export type TripLineSource = {
  patientName: string;
  direction: TripDirection;
  appointmentMinute: number | null;
  readyMinute: number | null;
};

/** « MARTIN Jeanne (aller, RDV 08:30) », « MARTIN Jeanne (retour, fin 11:15) ». */
export function tripLineText(trip: TripLineSource): string {
  const when =
    trip.direction === "OUTBOUND" ? `aller, RDV ${formatMinute(trip.appointmentMinute)}` : `retour, fin ${formatMinute(trip.readyMinute)}`;
  return `${trip.patientName} (${when})`;
}

/** « Hors fenêtre horaire — Taxi 1, MARTIN Jeanne (aller, RDV 08:30) » (its raw message holds ids). */
export function violationLineText(
  violation: { code: string; tripId: string | null; vehicleId: string | null },
  tripLine: (tripId: string) => string,
  vehicleLabel: (vehicleId: string) => string | null,
): string {
  const vehicle = violation.vehicleId ? vehicleLabel(violation.vehicleId) : null;
  const where = [vehicle, violation.tripId ? tripLine(violation.tripId) : null].filter((part): part is string => part !== null);
  const label = VIOLATION_LABELS[violation.code] ?? violation.code;
  return where.length > 0 ? `${label} — ${where.join(", ")}` : label;
}
