/**
 * Pure helpers of the trips list: filters from the URL, sorting by key time,
 * day summary, co-passengers from route stops and French messages.
 * No server-only import so vitest can cover them.
 */
import type { SharingStatus, TripDirection, TripStatus } from "@prisma/client";
import { isSameEpisode, type LegKey } from "@/lib/domain/no-show";
import { formatShortDate, TIME_ZONE } from "@/lib/time";
import { keyMinute, sharingConflict } from "./trip-rules";

const TRIP_STATUSES = ["PLANNED", "ASSIGNED", "PICKED_UP", "DROPPED_OFF", "CANCELLED", "NO_SHOW"] as const satisfies readonly TripStatus[];
const SHARING_STATUSES = ["NOT_ELIGIBLE", "NOT_PROPOSED", "PROPOSED", "ACCEPTED", "REFUSED"] as const satisfies readonly SharingStatus[];
const DIRECTIONS = ["OUTBOUND", "RETURN"] as const satisfies readonly TripDirection[];

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
};

export const EMPTY_FILTERS: TripFilters = { status: null, direction: null, sharing: null, q: "", patient: null };

type SearchParamValue = string | string[] | undefined;

function firstValue(value: SearchParamValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function pick<T extends string>(value: SearchParamValue, allowed: readonly T[]): T | null {
  const v = firstValue(value);
  return v !== undefined && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

/** Reads ?statut=&sens=&partage=&q=&patient= ; unknown values are ignored. */
export function parseTripFilters(params: Record<string, SearchParamValue>): TripFilters {
  const patient = (firstValue(params.patient) ?? "").trim();
  return {
    status: pick<StatusFilter>(params.statut, [...TRIP_STATUSES, "ACTIVE", "RETURN_TO_CHECK"]),
    direction: pick<TripDirection>(params.sens, DIRECTIONS),
    sharing: pick<SharingFilter>(params.partage, [...SHARING_STATUSES, "SHARED"]),
    q: (firstValue(params.q) ?? "").trim().slice(0, 80),
    patient: /^[\w-]{1,64}$/.test(patient) ? patient : null,
  };
}

export function hasActiveFilters(filters: TripFilters): boolean {
  return filters.status !== null || filters.direction !== null || filters.sharing !== null || filters.q !== "" || filters.patient !== null;
}

/** Lowercase, accents removed: "Hélène" and "helene" match. */
export function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export type FilterableTrip = {
  patientId?: string;
  status: TripStatus;
  direction: TripDirection;
  sharingStatus: SharingStatus;
  shared: boolean;
  patient: { firstName: string; lastName: string };
  /** Return trip to check: its outbound leg was closed as patient absent (returnsToCheckAfterNoShow). */
  outboundNoShow?: boolean;
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
  if (filters.q) {
    const needle = normalizeSearch(filters.q);
    const { firstName, lastName } = trip.patient;
    const haystacks = [`${firstName} ${lastName}`, `${lastName} ${firstName}`].map(normalizeSearch);
    if (!haystacks.some((h) => h.includes(needle))) return false;
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

/** Filters in use as URL parameters (statut, sens, partage, q). */
export function filtersToParams(filters: TripFilters): Record<string, string> {
  const params: Record<string, string> = {};
  if (filters.status) params.statut = filters.status;
  if (filters.direction) params.sens = filters.direction;
  if (filters.sharing) params.partage = filters.sharing;
  if (filters.q) params.q = filters.q;
  if (filters.patient) params.patient = filters.patient;
  return params;
}

/** Builds /courses?date=…&statut=… keeping only meaningful parameters. */
export function coursesHref(date: string, filters: TripFilters = EMPTY_FILTERS): string {
  return `/courses?${new URLSearchParams({ date, ...filtersToParams(filters) }).toString()}`;
}

// Co-passengers from the route stops: one implementation, shared with the detach of a trip.
export { coPassengersFromStops, type StopForCoPassengers } from "@/lib/planning/detach";

/** "Dupont Marie" -> "Dupont M." (compact co-passenger hint). */
export function shortPatientName(patient: { firstName: string; lastName: string }): string {
  const initial = patient.firstName.trim().charAt(0);
  return initial ? `${patient.lastName} ${initial.toUpperCase()}.` : patient.lastName;
}

/** "DUPONT Marie" — last name first, as on a planning sheet. */
export function patientDisplayName(patient: { firstName: string; lastName: string }): string {
  return `${patient.lastName.toUpperCase()} ${patient.firstName}`;
}

const instantFormat = new Intl.DateTimeFormat("fr-FR", {
  timeZone: TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** Real instant (UTC) -> "02/11/2026 14:05" in Europe/Paris. */
export function formatInstant(instant: Date | null | undefined): string | null {
  if (!instant) return null;
  return instantFormat.format(instant).replace(",", "");
}

/** French plural: 0 and 1 take the singular. */
export function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

export type PairedReturn = { id: string; keyMinute: number | null };

/**
 * For each outbound trip still open, the return of the same care that day
 * (same patient, recurrence or facility), still open too: « Annuler la course »
 * offers to cancel it along.
 */
export function pairedReturns(
  trips: readonly (LegKey & { id: string; direction: TripDirection; status: TripStatus; readyMinute: number | null })[],
): Map<string, PairedReturn> {
  const open = (status: TripStatus) => status === "PLANNED" || status === "ASSIGNED";
  const pairs = new Map<string, PairedReturn>();
  for (const outbound of trips) {
    if (outbound.direction !== "OUTBOUND" || !open(outbound.status)) continue;
    const back = trips.find((t) => t.direction === "RETURN" && open(t.status) && isSameEpisode(outbound, t));
    if (back) pairs.set(outbound.id, { id: back.id, keyMinute: back.readyMinute });
  }
  return pairs;
}

/** Feedback of « Générer les courses » : what was created or brought back between fromIso and toIso. */
export function generationMessage(result: { created: number; revived: number }, fromIso: string, toIso: string): string {
  const period = fromIso === toIso ? `Le ${formatShortDate(fromIso)}` : `Du ${formatShortDate(fromIso)} au ${formatShortDate(toIso)}`;
  if (result.created + result.revived === 0) return `${period} : toutes les courses régulières existent déjà.`;
  const done = [];
  if (result.created > 0) done.push(plural(result.created, "course créée", "courses créées"));
  if (result.revived > 0) done.push(plural(result.revived, "course annulée automatiquement rétablie", "courses annulées automatiquement rétablies"));
  return `${period} : ${done.join(", ")}.`;
}
