/**
 * Pure helpers of the trips list: filters from the URL, sorting by key time,
 * day summary, co-passengers from route stops and French messages.
 * No server-only import so vitest can cover them.
 */
import type { Payer, SharingStatus, TripDirection, TripStatus } from "@prisma/client";
import { isSameEpisode, type LegKey } from "@/lib/domain/no-show";
import { normalizeSearch } from "@/lib/list-filters";
import { formatDateTime, formatShortDate } from "@/lib/time";
import { keyMinute, sharingConflict } from "./trip-rules";
import { formatPersonName } from "@/lib/names";

const TRIP_STATUSES = ["PLANNED", "ASSIGNED", "PICKED_UP", "DROPPED_OFF", "CANCELLED", "NO_SHOW"] as const satisfies readonly TripStatus[];
const SHARING_STATUSES = ["NOT_ELIGIBLE", "NOT_PROPOSED", "PROPOSED", "ACCEPTED", "REFUSED"] as const satisfies readonly SharingStatus[];
const DIRECTIONS = ["OUTBOUND", "RETURN"] as const satisfies readonly TripDirection[];
const PAYERS = ["CPAM", "PRIVATE"] as const satisfies readonly Payer[];

/** « Véhicule » filter: the trips still without a route (not cancelled, patient not absent). */
export const UNASSIGNED = "aucun";
/** « Établissement » filter: the trips to a free address (no facility). */
export const NO_FACILITY = "libre";
/** « Origine » filter: from a recurrence (regular) or created one by one. */
export const ORIGINS = ["reguliere", "ponctuelle"] as const;
export type OriginFilter = (typeof ORIGINS)[number];

/**
 * "ACTIVE" = every status but CANCELLED; "RETURN_TO_CHECK" = return trips
 * whose outbound leg was closed as patient absent (@/lib/domain/no-show).
 */
export type StatusFilter = TripStatus | "ACTIVE" | "RETURN_TO_CHECK";
/** "SHARED" = shared in the current planning (Trip.shared), the other values are the traceability status. */
export type SharingFilter = SharingStatus | "SHARED";

export type TripFilters = {
  status: StatusFilter | null;
  direction: TripDirection | null;
  sharing: SharingFilter | null;
  q: string;
  /**
   * One patient, by id (?patient=): the links from the planning use it, so a
   * patient's name never travels in a URL (access logs, history, Referer).
   */
  patient: string | null;
  /** A facility id, or NO_FACILITY. */
  facility: string | null;
  /** A vehicle id (the trip's route), or UNASSIGNED. */
  vehicle: string | null;
  /** The depot of the trip's vehicle. */
  depot: string | null;
  payer: Payer | null;
  origin: OriginFilter | null;
};

export const EMPTY_FILTERS: TripFilters = {
  status: null,
  direction: null,
  sharing: null,
  q: "",
  patient: null,
  facility: null,
  vehicle: null,
  depot: null,
  payer: null,
  origin: null,
};

type SearchParamValue = string | string[] | undefined;

function firstValue(value: SearchParamValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function pick<T extends string>(value: SearchParamValue, allowed: readonly T[]): T | null {
  const v = firstValue(value);
  return v !== undefined && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

function id(value: SearchParamValue): string | null {
  const v = (firstValue(value) ?? "").trim();
  return /^[\w-]{1,64}$/.test(v) ? v : null;
}

/** Reads ?statut=&sens=&partage=&q=&patient=&etablissement=&vehicule=&depot=&payeur=&origine= ; unknown values are ignored. */
export function parseTripFilters(params: Record<string, SearchParamValue>): TripFilters {
  return {
    status: pick<StatusFilter>(params.statut, [...TRIP_STATUSES, "ACTIVE", "RETURN_TO_CHECK"]),
    direction: pick<TripDirection>(params.sens, DIRECTIONS),
    sharing: pick<SharingFilter>(params.partage, [...SHARING_STATUSES, "SHARED"]),
    q: (firstValue(params.q) ?? "").trim().slice(0, 80),
    patient: id(params.patient),
    facility: id(params.etablissement),
    vehicle: id(params.vehicule),
    depot: id(params.depot),
    payer: pick<Payer>(params.payeur, PAYERS),
    origin: pick<OriginFilter>(params.origine, ORIGINS),
  };
}

export function hasActiveFilters(filters: TripFilters): boolean {
  return (
    filters.status !== null ||
    filters.direction !== null ||
    filters.sharing !== null ||
    filters.q !== "" ||
    filters.patient !== null ||
    filters.facility !== null ||
    filters.vehicle !== null ||
    filters.depot !== null ||
    filters.payer !== null ||
    filters.origin !== null
  );
}

/** Lowercase, accents removed: "Hélène" and "helene" match (lib/list-filters.ts). */
export { normalizeSearch };

export type FilterableTrip = {
  patientId?: string;
  status: TripStatus;
  direction: TripDirection;
  sharingStatus: SharingStatus;
  shared: boolean;
  patient: { firstName: string; lastName: string };
  /** Return trip to check: its outbound leg was closed as patient absent (returnsToCheckAfterNoShow). */
  outboundNoShow?: boolean;
  routeId?: string | null;
  facilityId?: string | null;
  facility?: { name: string } | null;
  pickupAddress?: string;
  dropoffAddress?: string;
  payer?: Payer;
  recurrenceId?: string | null;
  /** The vehicle of the trip's route and its depot. */
  route?: { vehicle: { id: string; depotId: string } } | null;
};

export function matchesFilters(trip: FilterableTrip, filters: TripFilters): boolean {
  if (filters.status === "ACTIVE") {
    if (trip.status === "CANCELLED") return false;
  } else if (filters.status === "RETURN_TO_CHECK") {
    if (!trip.outboundNoShow) return false;
  } else if (filters.status !== null && trip.status !== filters.status) {
    return false;
  }
  if (filters.patient !== null && trip.patientId !== filters.patient) return false;
  if (filters.direction !== null && trip.direction !== filters.direction) return false;
  if (filters.sharing === "SHARED") {
    if (!trip.shared) return false;
  } else if (filters.sharing !== null && trip.sharingStatus !== filters.sharing) {
    return false;
  }
  if (filters.facility === NO_FACILITY ? (trip.facilityId ?? null) !== null : filters.facility !== null && trip.facilityId !== filters.facility) {
    return false;
  }
  if (filters.vehicle === UNASSIGNED) {
    if ((trip.routeId ?? null) !== null || trip.status === "CANCELLED" || trip.status === "NO_SHOW") return false;
  } else if (filters.vehicle !== null && trip.route?.vehicle.id !== filters.vehicle) {
    return false;
  }
  if (filters.depot !== null && trip.route?.vehicle.depotId !== filters.depot) return false;
  if (filters.payer !== null && trip.payer !== filters.payer) return false;
  if (filters.origin !== null && ((trip.recurrenceId ?? null) !== null) !== (filters.origin === "reguliere")) return false;
  if (filters.q) {
    // The patient's name in both orders, the facility and the addresses (a city): « clinique gap », « dupont marie ».
    const needle = normalizeSearch(filters.q);
    const { firstName, lastName } = trip.patient;
    const haystacks = [`${firstName} ${lastName}`, `${lastName} ${firstName}`].map(normalizeSearch);
    if (!haystacks.some((h) => h.includes(needle))) {
      const place = normalizeSearch([trip.facility?.name, trip.pickupAddress, trip.dropoffAddress].filter(Boolean).join(" "));
      const words = needle.split(" ");
      if (!words.every((word) => place.includes(word) || haystacks[0]!.includes(word))) return false;
    }
  }
  return true;
}

export function filterTrips<T extends FilterableTrip>(trips: T[], filters: TripFilters): T[] {
  return trips.filter((trip) => matchesFilters(trip, filters));
}

export type SortableTrip = {
  id: string;
  direction: TripDirection;
  appointmentMinute: number | null;
  readyMinute: number | null;
  patient: { firstName: string; lastName: string };
};

/** Sorted by key time (RDV for an outbound leg, end of session for a return leg), trips without time last. */
export function compareTrips(a: SortableTrip, b: SortableTrip): number {
  const ka = keyMinute(a);
  const kb = keyMinute(b);
  if (ka !== kb) {
    if (ka === null) return 1;
    if (kb === null) return -1;
    return ka - kb;
  }
  const byName =
    a.patient.lastName.localeCompare(b.patient.lastName, "fr", { sensitivity: "base" }) ||
    a.patient.firstName.localeCompare(b.patient.firstName, "fr", { sensitivity: "base" });
  if (byName !== 0) return byName;
  if (a.direction !== b.direction) return a.direction === "OUTBOUND" ? -1 : 1;
  return a.id.localeCompare(b.id);
}

export function sortTrips<T extends SortableTrip>(trips: readonly T[]): T[] {
  return [...trips].sort(compareTrips);
}

export type DaySummary = {
  /** Trips that are not cancelled. */
  total: number;
  outbound: number;
  return: number;
  /** Not cancelled and placed in a route. */
  assigned: number;
  /** Not cancelled and not in any route yet. */
  unassigned: number;
  shared: number;
  sharingAccepted: number;
  sharingRefused: number;
  sharingPending: number;
  /** Still shared in the plan although the patient refused: the day must be re-optimized. */
  sharingConflicts: number;
  /** Return trips still to do whose outbound leg was closed as patient absent: call the patient or cancel. */
  returnsToCheck: number;
  cancelled: number;
};

export function summarizeTrips(
  trips: readonly {
    status: TripStatus;
    direction: TripDirection;
    routeId: string | null;
    shared: boolean;
    sharingStatus: SharingStatus;
    sharingAllowed: boolean;
    outboundNoShow?: boolean;
  }[],
): DaySummary {
  const summary: DaySummary = {
    total: 0,
    outbound: 0,
    return: 0,
    assigned: 0,
    unassigned: 0,
    shared: 0,
    sharingAccepted: 0,
    sharingRefused: 0,
    sharingPending: 0,
    sharingConflicts: 0,
    returnsToCheck: 0,
    cancelled: 0,
  };
  for (const trip of trips) {
    if (trip.status === "CANCELLED") {
      summary.cancelled += 1;
      continue;
    }
    summary.total += 1;
    if (trip.direction === "OUTBOUND") summary.outbound += 1;
    else summary.return += 1;
    if (trip.routeId) summary.assigned += 1;
    else summary.unassigned += 1;
    if (trip.shared) summary.shared += 1;
    if (trip.sharingStatus === "ACCEPTED") summary.sharingAccepted += 1;
    if (trip.sharingStatus === "REFUSED") summary.sharingRefused += 1;
    if (trip.sharingAllowed && (trip.sharingStatus === "NOT_PROPOSED" || trip.sharingStatus === "PROPOSED")) {
      summary.sharingPending += 1;
    }
    if (sharingConflict(trip)) summary.sharingConflicts += 1;
    if (trip.outboundNoShow) summary.returnsToCheck += 1;
  }
  return summary;
}

/** Filters in use as URL parameters. */
export function filtersToParams(filters: TripFilters): Record<string, string> {
  const params: Record<string, string> = {};
  if (filters.status) params.statut = filters.status;
  if (filters.direction) params.sens = filters.direction;
  if (filters.sharing) params.partage = filters.sharing;
  if (filters.q) params.q = filters.q;
  if (filters.facility) params.etablissement = filters.facility;
  if (filters.vehicle) params.vehicule = filters.vehicle;
  if (filters.depot) params.depot = filters.depot;
  if (filters.payer) params.payeur = filters.payer;
  if (filters.origin) params.origine = filters.origin;
  if (filters.patient) params.patient = filters.patient;
  return params;
}

/** Builds /courses?date=…&statut=… keeping only meaningful parameters. */
export function coursesHref(date: string, filters: TripFilters = EMPTY_FILTERS): string {
  return `/courses?${new URLSearchParams({ date, ...filtersToParams(filters) }).toString()}`;
}

// Co-passengers from the route stops: one implementation, shared with the detach of a trip.
export { coPassengersFromStops, type StopForCoPassengers } from "@/lib/planning/detach";

/** "DUPONT M." (compact co-passenger hint): the short form of lib/names. */
export function shortPatientName(patient: { firstName: string; lastName: string }): string {
  return formatPersonName(patient, "short");
}

/** "DUPONT Marie" — last name first, as on a planning sheet. */
export function patientDisplayName(patient: { firstName: string; lastName: string }): string {
  return formatPersonName(patient);
}

/** Real instant (UTC) -> "02/11 à 14:05" in Europe/Paris (lib/time formatDateTime); null stays null. */
export function formatInstant(instant: Date | null | undefined): string | null {
  return instant ? formatDateTime(instant) : null;
}

/** French plural: 0 and 1 take the singular. */
export function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

/** The return of an outbound trip: its key time, and whether it is in a route (shared or not) for the confirmations. */
export type PairedReturn = { id: string; keyMinute: number | null; inRoute: boolean; shared: boolean };

/**
 * For each outbound trip still open, the return of the same care that day
 * (same patient, recurrence or facility), still open too: « Annuler la course »
 * and « Annuler la sélection » offer to cancel it along.
 */
export function pairedReturns(
  trips: readonly (LegKey & {
    id: string;
    direction: TripDirection;
    status: TripStatus;
    readyMinute: number | null;
    routeId: string | null;
    shared: boolean;
  })[],
): Map<string, PairedReturn> {
  const open = (status: TripStatus) => status === "PLANNED" || status === "ASSIGNED";
  const pairs = new Map<string, PairedReturn>();
  for (const outbound of trips) {
    if (outbound.direction !== "OUTBOUND" || !open(outbound.status)) continue;
    const back = trips.find((t) => t.direction === "RETURN" && open(t.status) && isSameEpisode(outbound, t));
    if (back) pairs.set(outbound.id, { id: back.id, keyMinute: back.readyMinute, inRoute: back.routeId !== null, shared: back.shared });
  }
  return pairs;
}

/**
 * Feedback of « Annuler la sélection » : « 12 courses annulées (hospitalisation),
 * dont 4 retirées de leur tournée. 3 annulations tardives. 2 courses non
 * annulées : déjà commencées, terminées ou modifiées entre-temps. »
 */
export function bulkCancelMessage(result: { cancelled: number; fromRoutes: number; late: number; skipped: number; reason: string }): string {
  const parts: string[] = [];
  if (result.cancelled > 0) {
    const routes =
      result.fromRoutes === 0
        ? ""
        : result.fromRoutes === result.cancelled
          ? result.cancelled > 1
            ? ", toutes retirées de leur tournée"
            : " et retirée de sa tournée"
          : `, dont ${plural(result.fromRoutes, "retirée de sa tournée", "retirées de leur tournée")}`;
    parts.push(`${plural(result.cancelled, "course annulée", "courses annulées")} (${result.reason})${routes}.`);
    if (result.late > 0) parts.push(`${plural(result.late, "annulation tardive", "annulations tardives")}.`);
  } else {
    parts.push("Aucune course annulée.");
  }
  if (result.skipped > 0) {
    parts.push(
      `${plural(result.skipped, "course non annulée", "courses non annulées")}\u00a0: déjà ${result.skipped > 1 ? "commencées, terminées ou modifiées" : "commencée, terminée ou modifiée"} entre-temps.`,
    );
  }
  return parts.join(" ");
}

/** Feedback of « Générer les courses » : what was created or brought back between fromIso and toIso. */
export function generationMessage(result: { created: number; revived: number }, fromIso: string, toIso: string): string {
  const period = fromIso === toIso ? `Le ${formatShortDate(fromIso)}` : `Du ${formatShortDate(fromIso)} au ${formatShortDate(toIso)}`;
  if (result.created + result.revived === 0) return `${period}\u00a0: toutes les courses régulières existent déjà.`;
  const done = [];
  if (result.created > 0) done.push(plural(result.created, "course créée", "courses créées"));
  if (result.revived > 0) done.push(plural(result.revived, "course annulée automatiquement rétablie", "courses annulées automatiquement rétablies"));
  return `${period}\u00a0: ${done.join(", ")}.`;
}
