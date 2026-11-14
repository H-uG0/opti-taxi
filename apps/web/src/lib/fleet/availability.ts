/**
 * Dated unavailability of a vehicle (maintenance, repair, inspection, on-call
 * duty…): an unavailable vehicle is not planned that day and its default crew
 * is free for other vehicles (lib/staff/day-crews.ts). Pure module.
 */
import type { VehicleUnavailabilityKind } from "@prisma/client";
import { VEHICLE_UNAVAILABILITY_LABELS } from "@/lib/labels";
import { formatMinute, formatShortDate } from "@/lib/time";
import { coversWholeDay, takenHoursText } from "./partial-day";

/**
 * From startDate to endDate included ("YYYY-MM-DD"); with startMinute, from that time of the first day, with
 * endMinute, until that time of the last day (lib/fleet/partial-day.ts).
 */
export type DatedVehicleUnavailability = {
  vehicleId: string;
  kind: VehicleUnavailabilityKind;
  startDate: string;
  endDate: string;
  startMinute?: number | null;
  endMinute?: number | null;
};

/**
 * The unavailability covering the whole date, if any (the earliest one when several overlap). A vehicle
 * out of service from a time of the day still works that day until then (partial-day.ts).
 */
export function unavailabilityOn(
  vehicleId: string,
  isoDate: string,
  list: readonly DatedVehicleUnavailability[],
): DatedVehicleUnavailability | null {
  let found: DatedVehicleUnavailability | null = null;
  for (const u of list) {
    if (u.vehicleId !== vehicleId || !coversWholeDay(u, isoDate)) continue;
    if (!found || u.startDate < found.startDate) found = u;
  }
  return found;
}

/** "Entretien du 12/11/2026 au 13/11/2026", "Garde le 11/11/2026", "Réparation le 14/11/2026 à partir de 11:20". */
export function unavailabilityText(
  u: Pick<DatedVehicleUnavailability, "kind" | "startDate" | "endDate" | "startMinute" | "endMinute">,
): string {
  const label = VEHICLE_UNAVAILABILITY_LABELS[u.kind];
  if (u.startDate === u.endDate) {
    const hours = takenHoursText(u, u.startDate);
    return `${label} le ${formatShortDate(u.startDate)}${hours ? ` ${hours}` : ""}`;
  }
  const from = u.startMinute != null ? ` à partir de ${formatMinute(u.startMinute)}` : "";
  const until = u.endMinute != null ? ` jusqu'à ${formatMinute(u.endMinute)}` : "";
  return `${label} du ${formatShortDate(u.startDate)}${from} au ${formatShortDate(u.endDate)}${until}`;
}
