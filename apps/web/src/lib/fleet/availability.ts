/**
 * Dated unavailability of a vehicle (maintenance, repair, inspection, on-call
 * duty…): an unavailable vehicle is not planned that day and its default crew
 * is free for other vehicles (lib/staff/day-crews.ts). Pure module.
 */
import type { VehicleUnavailabilityKind } from "@prisma/client";
import { VEHICLE_UNAVAILABILITY_LABELS } from "@/lib/labels";
import { formatShortDate } from "@/lib/time";

/** From startDate to endDate included ("YYYY-MM-DD"). */
export type DatedVehicleUnavailability = {
  vehicleId: string;
  kind: VehicleUnavailabilityKind;
  startDate: string;
  endDate: string;
};

/** The unavailability covering the date, if any (the earliest one when several overlap). */
export function unavailabilityOn(
  vehicleId: string,
  isoDate: string,
  list: readonly DatedVehicleUnavailability[],
): DatedVehicleUnavailability | null {
  let found: DatedVehicleUnavailability | null = null;
  for (const u of list) {
    if (u.vehicleId !== vehicleId || u.startDate > isoDate || u.endDate < isoDate) continue;
    if (!found || u.startDate < found.startDate) found = u;
  }
  return found;
}

/** "Entretien du 12/11/2026 au 13/11/2026", "Garde le 11/11/2026". */
export function unavailabilityText(u: Pick<DatedVehicleUnavailability, "kind" | "startDate" | "endDate">): string {
  const label = VEHICLE_UNAVAILABILITY_LABELS[u.kind];
  return u.startDate === u.endDate
    ? `${label} le ${formatShortDate(u.startDate)}`
    : `${label} du ${formatShortDate(u.startDate)} au ${formatShortDate(u.endDate)}`;
}
