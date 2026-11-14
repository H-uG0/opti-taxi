/**
 * When a care facility is closed: on its dated closures (entered on its
 * record), and on public holidays unless it works them (« ouvert les jours
 * fériés », ticked for dialysis centres).
 *
 * - A dated closure is explicit: the generation creates no trip to the
 *   facility on its days, and the trips already created are cancelled by the
 *   application (origin SYSTEM), brought back if the closure is removed.
 * - A public holiday only flags the trips (« Jour férié : N courses vers des
 *   établissements fermés »): whether a facility works that day is not known
 *   for sure, and a session left without transport is worse than a trip
 *   cancelled by hand. The regulator cancels them in one click, or ticks
 *   « ouvert les jours fériés » on the facility.
 *
 * Public holidays: the list of « Règles de facturation » (PublicHoliday, the
 * same as the « dimanche et jour férié » surcharge); for a year that list does
 * not cover at all, the 11 legal days computed for that year (Easter-based ones
 * included: lib/domain/holidays.ts), so the horizon never lacks them.
 *
 * Pure module (no server-only import).
 */
import { frenchPublicHolidays, type Holiday } from "./holidays";
import { coveredOn, periodText, type DatedPeriod } from "./patient-absences";
import { toIsoDate } from "@/lib/time";

export type { Holiday };

/**
 * The public holiday of `isoDate`, if any. `rows`: the PublicHoliday rows of
 * that date's year ("YYYY-MM-DD"); none at all: the legal days computed for the year.
 */
export function holidayOn(rows: readonly Holiday[], isoDate: string): Holiday | null {
  const year = isoDate.slice(0, 4);
  const ofYear = rows.filter((h) => h.date.startsWith(year));
  const list = ofYear.length > 0 ? ofYear : frenchPublicHolidays(Number(year));
  return list.find((h) => h.date === isoDate) ?? null;
}

/** Why a facility is closed on a day: one of its closures, or a public holiday it does not work. */
export type ClosedReason = { kind: "closure"; period: DatedPeriod } | { kind: "holiday"; label: string };

/** Is the facility closed on `isoDate` (its closures, then the holiday if it does not work it)? */
export function facilityClosedOn(
  facility: { openOnHolidays: boolean; closures?: readonly { startDate: Date; endDate: Date }[] },
  isoDate: string,
  holiday: Holiday | null,
): ClosedReason | null {
  const closure = (facility.closures ?? []).find((c) => toIsoDate(c.startDate) <= isoDate && isoDate <= toIsoDate(c.endDate));
  if (closure) return { kind: "closure", period: { startDate: toIsoDate(closure.startDate), endDate: toIsoDate(closure.endDate) } };
  if (holiday && !facility.openOnHolidays) return { kind: "holiday", label: holiday.label };
  return null;
}

/** A dated closure covers the date (the generation skips the sessions to the facility that day). */
export function closedByClosureOn(facility: { closures?: readonly { startDate: Date; endDate: Date }[] }, isoDate: string): boolean {
  return coveredOn(facility.closures, isoDate);
}

/** Note of the trips a closure cancels: « fermeture du 24/12/2026 au 26/12/2026 ». */
export function closureCancellationNote(period: DatedPeriod): string {
  return `fermeture ${periodText(period)}`;
}

/** "Fermé du 24/12/2026 au 26/12/2026", "Fermé le 24/12/2026". */
export function closureText(period: DatedPeriod): string {
  return `Fermé ${periodText(period)}`;
}

/** « fermé les jours fériés », « fermé du … au … »: why the facility is listed in the banner. */
export function closedReasonText(reason: ClosedReason): string {
  return reason.kind === "holiday" ? "fermé les jours fériés" : `fermé ${periodText(reason.period)}`;
}

export type ClosedFacilityTrip = {
  id: string;
  facility: { id: string; name: string; openOnHolidays: boolean; closures?: readonly { startDate: Date; endDate: Date }[] } | null;
};

export type ClosedFacilityGroup = { facilityId: string; name: string; reason: ClosedReason; tripIds: string[] };

/** The day's open trips to a closed facility, by facility (most trips first): what the banner shows and cancels. */
export function closedFacilityTrips(
  trips: readonly ClosedFacilityTrip[],
  isoDate: string,
  holiday: Holiday | null,
): ClosedFacilityGroup[] {
  const groups = new Map<string, ClosedFacilityGroup>();
  for (const trip of trips) {
    if (!trip.facility) continue;
    const reason = facilityClosedOn(trip.facility, isoDate, holiday);
    if (!reason) continue;
    const group = groups.get(trip.facility.id) ?? { facilityId: trip.facility.id, name: trip.facility.name, reason, tripIds: [] };
    group.tripIds.push(trip.id);
    groups.set(trip.facility.id, group);
  }
  return [...groups.values()].sort((a, b) => b.tripIds.length - a.tripIds.length || a.name.localeCompare(b.name, "fr"));
}

/** « Jour férié (Armistice 1918) : 3 courses vers des établissements fermés », or the closure's wording on another day. */
export function closedFacilitiesTitle(holiday: Holiday | null, count: number): string {
  const trips = count === 1 ? "1 course vers un établissement fermé" : `${count} courses vers des établissements fermés`;
  return holiday ? `Jour férié (${holiday.label}) : ${trips}` : `${trips.charAt(0).toUpperCase()}${trips.slice(1)} ce jour`;
}
