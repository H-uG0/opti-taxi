/**
 * Keeps the trips already generated in line with the referential. Trips copy
 * the prescription rules (allowed vehicle types, sharing), the addresses and
 * the times when they are created, and the optimizer reads those copies: when
 * a prescription, a recurrence, a patient or a facility changes, its open
 * future trips (not started, not cancelled) must follow.
 *
 * Pure planning step (no database): the server actions load the trips, ask
 * `planTripChange` what to do with each one and apply it in a transaction.
 */
import type {
  Payer,
  PrescribedMode,
  RecurrenceLegs,
  SharingScope,
  SharingStatus,
  TripDirection,
  TripStatus,
  VehicleType,
} from "@prisma/client";
import { allowedVehicleTypesFor, isShareable, nextSharingStatus, sharingAllowedFor } from "@/lib/domain/rules";

// Shared with the revival of cancelled trips (lib/domain/trip-generation.ts).
export { nextSharingStatus };
import { isoWeekday } from "@/lib/time";

/** Trips a referential change may still modify: not started, not cancelled. */
export const OPEN_TRIP_STATUSES = ["PLANNED", "ASSIGNED"] as const satisfies readonly TripStatus[];

export type Place = { address: string; lat: number; lng: number };
export type DateRange = { validFrom: string; validTo: string };
export type PrescriptionRules = { id: string; mode: PrescribedMode; sharing: SharingScope };

/** A trip as the sync needs it (dates as "YYYY-MM-DD"). */
export type SyncTrip = {
  id: string;
  serviceDate: string;
  direction: TripDirection;
  status: TripStatus;
  payer: Payer;
  prescriptionId: string | null;
  facilityId: string | null;
  allowedVehicleTypes: VehicleType[];
  sharingAllowed: boolean;
  sharingStatus: SharingStatus;
  shared: boolean;
  appointmentMinute: number | null;
  readyMinute: number | null;
  pickupAddress: string;
  pickupLat: number;
  pickupLng: number;
  dropoffAddress: string;
  dropoffLat: number;
  dropoffLng: number;
  /** Recurrence that generated the trip (null for a one-off trip). */
  recurrenceId: string | null;
  routeId: string | null;
  /** Type of the vehicle whose route serves the trip. */
  routeVehicleType: VehicleType | null;
  lockedVehicleId: string | null;
  lockedVehicleType: VehicleType | null;
  /** Validity of the prescription the trip is attached to. */
  prescriptionValidity: DateRange | null;
};

/** What a referential change asks of one trip. */
export type TripTarget =
  | { kind: "cancel" }
  | {
      kind: "update";
      prescription?: PrescriptionRules;
      /** The patient's home: pickup of an outbound trip, drop-off of a return. */
      home?: Place;
      /** The care place: drop-off of an outbound trip, pickup of a return. */
      destination?: { facilityId: string; place: Place };
      /** Appointment (outbound) or end of session (return). */
      keyMinute?: number;
    };

export const CANCEL: TripTarget = { kind: "cancel" };
export const NO_CHANGE: TripTarget = { kind: "update" };

/** Fields a referential change may write on a trip. */
export type TripPatch = {
  status?: TripStatus;
  prescriptionId?: string;
  facilityId?: string;
  allowedVehicleTypes?: VehicleType[];
  sharingAllowed?: boolean;
  sharingStatus?: SharingStatus;
  appointmentMinute?: number;
  readyMinute?: number;
  pickupAddress?: string;
  pickupLat?: number;
  pickupLng?: number;
  dropoffAddress?: string;
  dropoffLat?: number;
  dropoffLng?: number;
  lockedVehicleId?: null;
  routeId?: null;
  plannedPickupMinute?: null;
  plannedDropoffMinute?: null;
  shared?: false;
  detourKm?: null;
  estimatedRevenue?: null;
};

export type TripChange = {
  tripId: string;
  /** Status read before the change: the write is guarded on it. */
  expectedStatus: TripStatus;
  cancel: boolean;
  /** The trip leaves its route: its stops must be removed. */
  detach: boolean;
  data: TripPatch;
};

export type TripDecision =
  | { type: "none" }
  /** A trip of today already in a route: the day is under way, the regulator handles it. */
  | { type: "deferred" }
  | { type: "change"; change: TripChange };

/** Planning results that no longer hold once the trip leaves its route. */
const DETACHED: TripPatch = {
  routeId: null,
  plannedPickupMinute: null,
  plannedDropoffMinute: null,
  shared: false,
  detourKm: null,
  estimatedRevenue: null,
};

export function isOpenFutureTrip(trip: Pick<SyncTrip, "status" | "serviceDate">, todayIso: string): boolean {
  return (OPEN_TRIP_STATUSES as readonly TripStatus[]).includes(trip.status) && trip.serviceDate >= todayIso;
}

export function coversDate(range: DateRange, isoDate: string): boolean {
  return range.validFrom <= isoDate && isoDate <= range.validTo;
}

function sameTypes(a: readonly VehicleType[], b: readonly VehicleType[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((t) => right.has(t));
}

type Side = "pickup" | "dropoff";

/** Writes `place` on one side of the trip; true when it changed. */
function setPlace(data: TripPatch, trip: SyncTrip, side: Side, place: Place): boolean {
  const [address, lat, lng] =
    side === "pickup"
      ? [trip.pickupAddress, trip.pickupLat, trip.pickupLng]
      : [trip.dropoffAddress, trip.dropoffLat, trip.dropoffLng];
  if (address === place.address && lat === place.lat && lng === place.lng) return false;
  if (side === "pickup") {
    data.pickupAddress = place.address;
    data.pickupLat = place.lat;
    data.pickupLng = place.lng;
  } else {
    data.dropoffAddress = place.address;
    data.dropoffLat = place.lat;
    data.dropoffLng = place.lng;
  }
  return true;
}

/**
 * The change to apply to `trip` so it matches `target`. A routed trip whose
 * place, time, vehicle type or sharing no longer matches its planned stops
 * leaves its route (the day must be re-optimized). Trips of today already in
 * a route are not touched: the day is under way.
 */
export function planTripChange(trip: SyncTrip, target: TripTarget, todayIso: string): TripDecision {
  if (!isOpenFutureTrip(trip, todayIso)) return { type: "none" };
  const routedToday = trip.routeId !== null && trip.serviceDate === todayIso;

  if (target.kind === "cancel") {
    if (routedToday) return { type: "deferred" };
    return {
      type: "change",
      change: {
        tripId: trip.id,
        expectedStatus: trip.status,
        cancel: true,
        detach: trip.routeId !== null,
        data: { status: "CANCELLED", ...DETACHED, lockedVehicleId: null },
      },
    };
  }

  const data: TripPatch = {};
  let moved = false;
  let allowed = trip.allowedVehicleTypes;
  let sharingAllowed = trip.sharingAllowed;
  let sharingStatus = trip.sharingStatus;

  if (target.prescription) {
    const p = target.prescription;
    if (trip.prescriptionId !== p.id) data.prescriptionId = p.id;
    const nextAllowed = allowedVehicleTypesFor(p.mode, trip.payer);
    if (!sameTypes(nextAllowed, allowed)) data.allowedVehicleTypes = allowed = nextAllowed;
    const nextSharing = sharingAllowedFor(p.sharing, trip.direction, p.mode, trip.payer);
    if (nextSharing !== sharingAllowed) data.sharingAllowed = sharingAllowed = nextSharing;
    const nextStatus = nextSharingStatus(sharingStatus, sharingAllowed);
    if (nextStatus !== sharingStatus) data.sharingStatus = sharingStatus = nextStatus;
  }

  const homeSide: Side = trip.direction === "OUTBOUND" ? "pickup" : "dropoff";
  const careSide: Side = trip.direction === "OUTBOUND" ? "dropoff" : "pickup";
  if (target.home) moved = setPlace(data, trip, homeSide, target.home) || moved;
  if (target.destination) {
    if (trip.facilityId !== target.destination.facilityId) data.facilityId = target.destination.facilityId;
    moved = setPlace(data, trip, careSide, target.destination.place) || moved;
  }
  if (target.keyMinute !== undefined) {
    if (trip.direction === "OUTBOUND" && trip.appointmentMinute !== target.keyMinute) {
      data.appointmentMinute = target.keyMinute;
      moved = true;
    } else if (trip.direction === "RETURN" && trip.readyMinute !== target.keyMinute) {
      data.readyMinute = target.keyMinute;
      moved = true;
    }
  }

  if (Object.keys(data).length === 0) return { type: "none" };

  // A lock on a vehicle type the prescription no longer allows cannot be kept.
  if (trip.lockedVehicleId !== null && trip.lockedVehicleType !== null && !allowed.includes(trip.lockedVehicleType)) {
    data.lockedVehicleId = null;
  }
  const vehicleRefused = trip.routeVehicleType !== null && !allowed.includes(trip.routeVehicleType);
  const sharingBroken = trip.shared && !isShareable({ sharingAllowed, sharingStatus });
  const detach = trip.routeId !== null && (moved || vehicleRefused || sharingBroken);
  if (detach) {
    if (routedToday) return { type: "deferred" };
    Object.assign(data, DETACHED);
    if (trip.status === "ASSIGNED") data.status = "PLANNED";
  }
  return { type: "change", change: { tripId: trip.id, expectedStatus: trip.status, cancel: false, detach, data } };
}

// ---------------------------------------------------------------- targets

/**
 * A prescription changed: its trips follow its rules. A trip outside its new
 * validity moves to `fallback` — the prescription the generation would give it
 * that day (a recurring trip covered by the renewal, lib/domain/renewal.ts) —
 * and is cancelled only when there is none.
 */
export function prescriptionTarget(
  trip: SyncTrip,
  prescription: PrescriptionRules & DateRange,
  fallback: PrescriptionRules | null = null,
): TripTarget {
  if (coversDate(prescription, trip.serviceDate)) return { kind: "update", prescription };
  return fallback ? { kind: "update", prescription: fallback } : CANCEL;
}

export type RecurrenceSchedule = {
  facilityId: string;
  prescriptionId: string;
  weekdays: number[];
  appointmentMinute: number;
  sessionMinutes: number;
  legs: RecurrenceLegs;
  startDate: string;
  endDate: string | null;
};

/** Does the recurrence still produce a trip on this date and leg? */
export function recurrenceSchedules(
  recurrence: Pick<RecurrenceSchedule, "weekdays" | "legs" | "startDate" | "endDate">,
  isoDate: string,
  direction: TripDirection,
): boolean {
  if (!recurrence.weekdays.includes(isoWeekday(isoDate))) return false;
  if (isoDate < recurrence.startDate) return false;
  if (recurrence.endDate !== null && isoDate > recurrence.endDate) return false;
  return recurrence.legs === "BOTH" || recurrence.legs === direction;
}

/**
 * A recurrence changed: its trips that no longer fit its days, legs or period
 * are cancelled. The others take the new prescription when it covers their
 * date (otherwise they keep the one in force that day, or take `fallback`,
 * the one the generation would give them that day — a renewal or the PMT
 * renewed —, and are cancelled only when none covers it), the new facility,
 * and the new time — except trips whose time was changed by hand, which keep it.
 */
export function recurrenceTarget(
  trip: SyncTrip,
  before: RecurrenceSchedule,
  after: RecurrenceSchedule & { prescription: PrescriptionRules & DateRange; facility: Place },
  fallback: PrescriptionRules | null = null,
): TripTarget {
  if (!recurrenceSchedules(after, trip.serviceDate, trip.direction)) return CANCEL;

  let prescription: PrescriptionRules | undefined;
  if (coversDate(after.prescription, trip.serviceDate)) {
    prescription = after.prescription;
  } else if (!trip.prescriptionValidity || !coversDate(trip.prescriptionValidity, trip.serviceDate)) {
    if (!fallback) return CANCEL;
    prescription = fallback;
  }

  let keyMinute: number | undefined;
  if (trip.direction === "OUTBOUND") {
    if (before.appointmentMinute !== after.appointmentMinute && trip.appointmentMinute === before.appointmentMinute) {
      keyMinute = after.appointmentMinute;
    }
  } else {
    const readyBefore = before.appointmentMinute + before.sessionMinutes;
    const readyAfter = after.appointmentMinute + after.sessionMinutes;
    if (readyBefore !== readyAfter && trip.readyMinute === readyBefore) keyMinute = readyAfter;
  }

  const destination =
    before.facilityId !== after.facilityId && trip.facilityId === before.facilityId
      ? { facilityId: after.facilityId, place: after.facility }
      : undefined;

  return { kind: "update", prescription, keyMinute, destination };
}

/** Recurrences moved to a renewed prescription: trips inside its validity are attached to it. */
export function renewalTarget(trip: SyncTrip, renewal: PrescriptionRules & DateRange): TripTarget {
  return coversDate(renewal, trip.serviceDate) ? { kind: "update", prescription: renewal } : NO_CHANGE;
}

// ---------------------------------------------------------------- summary

export type SyncSummary = {
  updated: number;
  cancelled: number;
  /** Trips taken out of their route (counted in updated or cancelled too). */
  detached: number;
  /** Trips of today already in a route, left untouched. */
  deferred: number;
  /** Trips generated from the recurrences over the horizon (lib/trips/completion.ts). */
  created: number;
  /** Trips the application had cancelled, brought back once the cause was gone. */
  revived: number;
};

export const EMPTY_SYNC: SyncSummary = { updated: 0, cancelled: 0, detached: 0, deferred: 0, created: 0, revived: 0 };

export function addSummaries(a: SyncSummary, b: SyncSummary): SyncSummary {
  return {
    updated: a.updated + b.updated,
    cancelled: a.cancelled + b.cancelled,
    detached: a.detached + b.detached,
    deferred: a.deferred + b.deferred,
    created: a.created + b.created,
    revived: a.revived + b.revived,
  };
}

/** The summary plus what completing the horizon did. */
export function withCompletion(summary: SyncSummary, completion: { created: number; revived: number }): SyncSummary {
  return { ...summary, created: summary.created + completion.created, revived: summary.revived + completion.revived };
}

export function isEmptySync(s: SyncSummary): boolean {
  return s.updated + s.cancelled + s.detached + s.deferred + s.created + s.revived === 0;
}

/** "1 course à venir" / "4 courses à venir" (open trips from today on). */
export function openTripsLabel(count: number): string {
  return count === 1 ? "1 course à venir" : `${count} courses à venir`;
}

/** French account of what happened to the trips, or null when nothing did. */
export function describeSync(s: SyncSummary): string | null {
  const sentences: string[] = [];
  const done: string[] = [];
  if (s.created > 0) done.push(`${s.created} créée${s.created > 1 ? "s" : ""}`);
  if (s.revived > 0) done.push(`${s.revived} rétablie${s.revived > 1 ? "s" : ""}`);
  if (s.updated > 0) done.push(`${s.updated} mise${s.updated > 1 ? "s" : ""} à jour`);
  if (s.cancelled > 0) done.push(`${s.cancelled} annulée${s.cancelled > 1 ? "s" : ""}`);
  if (done.length > 0) sentences.push(`Courses à venir : ${done.join(", ")}.`);
  if (s.detached > 0) {
    sentences.push(
      s.detached === 1
        ? "1 course a été retirée de sa tournée : réoptimisez la journée concernée."
        : `${s.detached} courses ont été retirées de leur tournée : réoptimisez les journées concernées.`,
    );
  }
  if (s.deferred > 0) {
    sentences.push(
      s.deferred === 1
        ? "1 course d'aujourd'hui, déjà dans une tournée, n'a pas été modifiée : ajustez-la dans Courses et prévenez le chauffeur."
        : `${s.deferred} courses d'aujourd'hui, déjà dans une tournée, n'ont pas été modifiées : ajustez-les dans Courses et prévenez les chauffeurs.`,
    );
  }
  return sentences.length > 0 ? sentences.join(" ") : null;
}

/** Query parameter carrying the summary across the redirect after a save. */
export const SYNC_PARAM = "courses";

export function encodeSync(s: SyncSummary): string | null {
  if (isEmptySync(s)) return null;
  const head = `${s.updated}-${s.cancelled}-${s.detached}-${s.deferred}`;
  return s.created + s.revived > 0 ? `${head}-${s.created}-${s.revived}` : head;
}

/** "u-c-d-f" (before generation was counted) or "u-c-d-f-created-revived". */
export function decodeSync(value: string | null | undefined): SyncSummary | null {
  const match = /^(\d{1,5})-(\d{1,5})-(\d{1,5})-(\d{1,5})(?:-(\d{1,5})-(\d{1,5}))?$/.exec(value ?? "");
  if (!match) return null;
  const [updated, cancelled, detached, deferred, created, revived] = match.slice(1).map((n) => Number(n ?? 0)) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const summary = { updated, cancelled, detached, deferred, created, revived };
  return isEmptySync(summary) ? null : summary;
}

/** `path` with the sync summary as query parameter (before the #fragment). */
export function withSyncNotice(path: string, s: SyncSummary): string {
  const encoded = encodeSync(s);
  if (!encoded) return path;
  const [base = path, hash] = path.split("#", 2);
  return `${base}${base.includes("?") ? "&" : "?"}${SYNC_PARAM}=${encoded}${hash !== undefined ? `#${hash}` : ""}`;
}
