/**
 * Pure helpers of the trips list: filters from the URL, sorting by key time,
 * day summary, co-passengers from route stops and French messages.
 * No server-only import so vitest can cover them.
 */
import type { SharingStatus, StopKind, TripDirection, TripStatus } from "@prisma/client";
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
};

export const EMPTY_FILTERS: TripFilters = { status: null, direction: null, sharing: null, q: "" };

type SearchParamValue = string | string[] | undefined;

function firstValue(value: SearchParamValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function pick<T extends string>(value: SearchParamValue, allowed: readonly T[]): T | null {
  const v = firstValue(value);
  return v !== undefined && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

/** Reads ?statut=&sens=&partage=&q= ; unknown values are ignored. */
export function parseTripFilters(params: Record<string, SearchParamValue>): TripFilters {
  return {
    status: pick<StatusFilter>(params.statut, [...TRIP_STATUSES, "ACTIVE", "RETURN_TO_CHECK"]),
    direction: pick<TripDirection>(params.sens, DIRECTIONS),
    sharing: pick<SharingFilter>(params.partage, [...SHARING_STATUSES, "SHARED"]),
    q: (firstValue(params.q) ?? "").trim().slice(0, 80),
  };
}

export function hasActiveFilters(filters: TripFilters): boolean {
  return filters.status !== null || filters.direction !== null || filters.sharing !== null || filters.q !== "";
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
  return params;
}

/** Builds /courses?date=…&statut=… keeping only meaningful parameters. */
export function coursesHref(date: string, filters: TripFilters = EMPTY_FILTERS): string {
  return `/courses?${new URLSearchParams({ date, ...filtersToParams(filters) }).toString()}`;
}

export type StopForCoPassengers = { routeId: string; tripId: string; kind: StopKind; sequence: number };

/**
 * Co-passengers of each trip: trips on board at the same time in the same route,
 * read from the ordered stops (a patient is on board from its pickup to its dropoff).
 */
export function coPassengersFromStops(stops: readonly StopForCoPassengers[]): Map<string, string[]> {
  const byRoute = new Map<string, StopForCoPassengers[]>();
  for (const stop of stops) {
    const list = byRoute.get(stop.routeId);
    if (list) list.push(stop);
    else byRoute.set(stop.routeId, [stop]);
  }

  const links = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    let set = links.get(a);
    if (!set) links.set(a, (set = new Set()));
    set.add(b);
  };

  for (const routeStops of byRoute.values()) {
    const onBoard = new Set<string>();
    for (const stop of [...routeStops].sort((x, y) => x.sequence - y.sequence)) {
      if (stop.kind === "PICKUP") {
        for (const other of onBoard) {
          link(stop.tripId, other);
          link(other, stop.tripId);
        }
        onBoard.add(stop.tripId);
      } else {
        onBoard.delete(stop.tripId);
      }
    }
  }

  return new Map([...links].map(([tripId, set]) => [tripId, [...set]]));
}

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

/** Feedback of the "Générer les courses" action. */
export function generationMessage(result: { planned: number; created: number }, fromIso: string, toIso: string): string {
  const existing = Math.max(0, result.planned - result.created);
  const created = plural(result.created, "course créée", "courses créées");
  const already = `${existing} déjà ${existing > 1 ? "existantes" : "existante"}`;
  return `Semaine du ${formatShortDate(fromIso)} au ${formatShortDate(toIso)} : ${created} (${already}).`;
}
