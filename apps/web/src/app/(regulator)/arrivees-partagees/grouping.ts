/**
 * Groups the day's shared transports by care facility, then by vehicle passage,
 * so the facility's reception desk can be told which patients arrive (or leave)
 * together (décret 2025-202, art. R. 322-11-7). Pure: no database access.
 */
import type { FacilityType, TripDirection, VehicleType } from "@prisma/client";

export type SharedTransportTrip = {
  id: string;
  direction: TripDirection;
  patientName: string;
  facility: {
    id: string;
    name: string;
    type: FacilityType;
    phone: string | null;
    address: string;
  } | null;
  vehicle: { id: string; label: string; type: VehicleType } | null;
  driverName: string | null;
  routeValidated: boolean;
  plannedPickupMinute: number | null;
  plannedDropoffMinute: number | null;
  appointmentMinute: number | null;
  readyMinute: number | null;
  /** Trips on board at the same time (from the route stops). */
  coPassengerIds: readonly string[];
  /** The patient refused sharing (or the prescription forbids it) but the plan still shares the trip. */
  sharingRefused: boolean;
};

export type GroupedPatient = {
  tripId: string;
  patientName: string;
  /** Arrival: planned dropoff at the facility. Departure: planned pickup at the facility. */
  plannedMinute: number | null;
  /** Arrival: appointment. Departure: end of session. */
  referenceMinute: number | null;
  sharingRefused: boolean;
};

export type TransportGroup = {
  key: string;
  vehicle: SharedTransportTrip["vehicle"];
  driverName: string | null;
  routeValidated: boolean;
  /** Earliest planned minute of the group at the facility. */
  minute: number | null;
  patients: GroupedPatient[];
  /** Co-passengers of this passage travelling to or from another place. */
  otherCoPassengers: number;
};

export type FacilitySharedTransports = {
  facility: NonNullable<SharedTransportTrip["facility"]>;
  arrivals: TransportGroup[];
  departures: TransportGroup[];
};

/** Two trips of the same vehicle at the same facility less than this apart are one passage. */
export const SAME_PASSAGE_MINUTES = 10;

function plannedMinuteAtFacility(trip: SharedTransportTrip): number | null {
  return trip.direction === "OUTBOUND" ? trip.plannedDropoffMinute : trip.plannedPickupMinute;
}

function referenceMinute(trip: SharedTransportTrip): number | null {
  return trip.direction === "OUTBOUND" ? trip.appointmentMinute : trip.readyMinute;
}

function compareMinutes(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/** Union-find over trip indexes. */
function makeSets(size: number) {
  const parent = Array.from({ length: size }, (_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[i] !== root) {
      const next = parent[i]!;
      parent[i] = root;
      i = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  return { find, union };
}

/**
 * Passages of one direction at one facility: trips of the same vehicle that are
 * co-passengers, or that reach the facility within SAME_PASSAGE_MINUTES of each other.
 */
function groupPassages(trips: SharedTransportTrip[]): TransportGroup[] {
  const sets = makeSets(trips.length);
  for (let i = 0; i < trips.length; i++) {
    for (let j = i + 1; j < trips.length; j++) {
      const a = trips[i]!;
      const b = trips[j]!;
      if (!a.vehicle || !b.vehicle || a.vehicle.id !== b.vehicle.id) continue;
      const coPassengers = a.coPassengerIds.includes(b.id) || b.coPassengerIds.includes(a.id);
      const ma = plannedMinuteAtFacility(a);
      const mb = plannedMinuteAtFacility(b);
      const sameTime = ma !== null && mb !== null && Math.abs(ma - mb) <= SAME_PASSAGE_MINUTES;
      if (coPassengers || sameTime) sets.union(i, j);
    }
  }

  const byRoot = new Map<number, SharedTransportTrip[]>();
  trips.forEach((trip, i) => {
    const root = sets.find(i);
    const list = byRoot.get(root);
    if (list) list.push(trip);
    else byRoot.set(root, [trip]);
  });

  const groups: TransportGroup[] = [];
  for (const members of byRoot.values()) {
    const patients = members
      .map((trip) => ({
        tripId: trip.id,
        patientName: trip.patientName,
        plannedMinute: plannedMinuteAtFacility(trip),
        referenceMinute: referenceMinute(trip),
        sharingRefused: trip.sharingRefused,
      }))
      .sort(
        (a, b) =>
          compareMinutes(a.plannedMinute, b.plannedMinute) || a.patientName.localeCompare(b.patientName, "fr"),
      );
    const memberIds = new Set(members.map((trip) => trip.id));
    const outside = new Set(members.flatMap((trip) => trip.coPassengerIds.filter((id) => !memberIds.has(id))));
    const first = members[0]!;
    groups.push({
      key: patients.map((p) => p.tripId).join("+"),
      vehicle: first.vehicle,
      driverName: first.driverName,
      routeValidated: members.every((trip) => trip.routeValidated),
      minute: patients[0]?.plannedMinute ?? null,
      patients,
      otherCoPassengers: outside.size,
    });
  }

  return groups.sort(
    (a, b) =>
      compareMinutes(a.minute, b.minute) ||
      (a.vehicle?.label ?? "").localeCompare(b.vehicle?.label ?? "", "fr") ||
      a.key.localeCompare(b.key),
  );
}

/**
 * Facilities sorted by name, each with its arrivals (outbound) and departures (return).
 * Only trips with at least one co-passenger on board according to the route
 * stops are listed (contract: shared = at least one co-passenger): the stored
 * shared flag may lag behind a manual change, and the reception desk must not
 * be told about a shared transport that no longer exists.
 */
export function groupSharedTransports(trips: readonly SharedTransportTrip[]): FacilitySharedTransports[] {
  const byFacility = new Map<string, { facility: NonNullable<SharedTransportTrip["facility"]>; trips: SharedTransportTrip[] }>();
  for (const trip of trips) {
    if (!trip.facility || trip.coPassengerIds.length === 0) continue;
    const entry = byFacility.get(trip.facility.id);
    if (entry) entry.trips.push(trip);
    else byFacility.set(trip.facility.id, { facility: trip.facility, trips: [trip] });
  }

  return [...byFacility.values()]
    .map(({ facility, trips: facilityTrips }) => ({
      facility,
      arrivals: groupPassages(facilityTrips.filter((trip) => trip.direction === "OUTBOUND")),
      departures: groupPassages(facilityTrips.filter((trip) => trip.direction === "RETURN")),
    }))
    .sort((a, b) => a.facility.name.localeCompare(b.facility.name, "fr", { sensitivity: "base" }));
}

export function countPatients(facilities: readonly FacilitySharedTransports[]): {
  arrivals: number;
  departures: number;
  /** Patients listed although they refused sharing: re-optimize before telling the reception. */
  refused: number;
} {
  let arrivals = 0;
  let departures = 0;
  let refused = 0;
  for (const f of facilities) {
    for (const g of f.arrivals) arrivals += g.patients.length;
    for (const g of f.departures) departures += g.patients.length;
    for (const g of [...f.arrivals, ...f.departures]) refused += g.patients.filter((p) => p.sharingRefused).length;
  }
  return { arrivals, departures, refused };
}

/** Reads ?etablissement= (one facility's sheet for its reception desk); anything odd means "all". */
export function parseFacilityFilter(value: string | string[] | undefined): string | null {
  const v = (Array.isArray(value) ? value[0] : value)?.trim();
  return v && v.length <= 64 && /^[A-Za-z0-9_-]+$/.test(v) ? v : null;
}

/** /arrivees-partagees?date=…[&etablissement=…] */
export function sharedArrivalsHref(date: string, facilityId: string | null = null): string {
  const params = new URLSearchParams({ date });
  if (facilityId) params.set("etablissement", facilityId);
  return `/arrivees-partagees?${params.toString()}`;
}
