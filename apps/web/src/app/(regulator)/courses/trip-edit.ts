/**
 * « Modifier la course » beyond its time: date, one-off address on the home
 * side, care facility (or free address of a private trip), time and notes. A
 * trip of a recurrence keeps its link: it still serves the session of its
 * recurrence (occurrenceDate), even moved to another day, and a later change
 * of the recurrence leaves what was changed by hand (trip-sync.ts).
 *
 * Pure planning step, unit-tested: the server action (actions.ts, updateTrip)
 * loads the trip, resolves the places and the prescription, asks `planTripEdit`
 * what to write, and applies it in a guarded transaction.
 */
import type { Prisma, SharingStatus, TripDirection, TripStatus, VehicleType } from "@prisma/client";
import { isShareable, nextSharingStatus } from "@/lib/domain/rules";
import { fromIsoDate } from "@/lib/time";

export type Place = { address: string; lat: number; lng: number };

/** The trip as stored (dates "YYYY-MM-DD"). */
export type EditableTrip = {
  id: string;
  status: TripStatus;
  serviceDate: string;
  occurrenceDate: string | null;
  recurrenceId: string | null;
  direction: TripDirection;
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
  oneOffAddress: boolean;
  notes: string | null;
  routeId: string | null;
  routeVehicleType: VehicleType | null;
  lockedVehicleId: string | null;
  lockedVehicleType: VehicleType | null;
};

/** What the regulator asked for, places and prescription resolved by the action. */
export type TripEdit = {
  serviceDate: string;
  /** Appointment (outbound) or end of session (return). */
  keyMinute: number;
  /** Home side: the patient's home, or an address for this trip only. */
  home: { place: Place; oneOff: boolean };
  /** Care side: a facility, or a free address (private trip, facilityId null). */
  care: { facilityId: string | null; place: Place };
  notes: string | null;
  /** Rules of the prescription the trip uses on the new date (CPAM): another PMT of the chain when the date moved off its own. */
  prescription: { id: string; allowedVehicleTypes: VehicleType[]; sharingAllowed: boolean } | null;
};

/** What changed, for the audit trail (names only, never the values) and the message. */
export type EditChange = "date" | "time" | "home" | "facility" | "care_place" | "notes" | "prescription";

export type EditPlan = {
  changes: EditChange[];
  data: Prisma.TripUncheckedUpdateManyInput;
  /** The trip leaves its route (date, place, vehicle type or sharing no longer match its planned stops). */
  detach: boolean;
  /** Only the time changed on a routed trip: the route keeps it if its planned stop still fits (schedule-fit.ts). */
  checkFit: boolean;
};

/** Planning results that no longer hold once the trip leaves its route. */
const DETACHED = {
  routeId: null,
  plannedPickupMinute: null,
  plannedDropoffMinute: null,
  shared: false,
  detourKm: null,
  estimatedRevenue: null,
} satisfies Prisma.TripUncheckedUpdateManyInput;

function samePlace(a: Place, b: Place): boolean {
  return a.address === b.address && a.lat === b.lat && a.lng === b.lng;
}

function sameTypes(a: readonly VehicleType[], b: readonly VehicleType[]): boolean {
  return a.length === b.length && a.every((t) => b.includes(t));
}

/**
 * The write of an edit. A routed trip whose date or places change leaves its
 * route (its stops are removed, the routes left recomputed); one whose time
 * alone changes stays there if its planned stop still fits. Moving a trip to
 * another day drops its lock (another day's vehicles). A trip of a recurrence
 * keeps the session it serves (occurrenceDate). Notes never move a trip.
 */
export function planTripEdit(trip: EditableTrip, edit: TripEdit): EditPlan {
  const changes: EditChange[] = [];
  const data: Prisma.TripUncheckedUpdateManyInput = {};
  const outbound = trip.direction === "OUTBOUND";
  const currentHome: Place = outbound
    ? { address: trip.pickupAddress, lat: trip.pickupLat, lng: trip.pickupLng }
    : { address: trip.dropoffAddress, lat: trip.dropoffLat, lng: trip.dropoffLng };
  const currentCare: Place = outbound
    ? { address: trip.dropoffAddress, lat: trip.dropoffLat, lng: trip.dropoffLng }
    : { address: trip.pickupAddress, lat: trip.pickupLat, lng: trip.pickupLng };
  const write = (side: "home" | "care", place: Place) => {
    const pickup = (side === "home") === outbound;
    if (pickup) Object.assign(data, { pickupAddress: place.address, pickupLat: place.lat, pickupLng: place.lng });
    else Object.assign(data, { dropoffAddress: place.address, dropoffLat: place.lat, dropoffLng: place.lng });
  };

  const moved = edit.serviceDate !== trip.serviceDate;
  if (moved) {
    changes.push("date");
    data.serviceDate = fromIsoDate(edit.serviceDate);
    // The session served stays the one of its recurrence; a one-off trip serves none.
    if (trip.recurrenceId !== null) data.occurrenceDate = fromIsoDate(trip.occurrenceDate ?? trip.serviceDate);
    if (trip.lockedVehicleId !== null) data.lockedVehicleId = null;
  }

  const currentKey = outbound ? trip.appointmentMinute : trip.readyMinute;
  if (currentKey !== edit.keyMinute) {
    changes.push("time");
    if (outbound) data.appointmentMinute = edit.keyMinute;
    else data.readyMinute = edit.keyMinute;
  }

  let placeChanged = false;
  if (!samePlace(currentHome, edit.home.place)) {
    changes.push("home");
    write("home", edit.home.place);
    placeChanged = true;
  }
  if (edit.home.oneOff !== trip.oneOffAddress) {
    if (!changes.includes("home")) changes.push("home");
    data.oneOffAddress = edit.home.oneOff;
  }
  if (edit.care.facilityId !== trip.facilityId) {
    changes.push(edit.care.facilityId === null ? "care_place" : "facility");
    data.facilityId = edit.care.facilityId;
  }
  if (!samePlace(currentCare, edit.care.place)) {
    if (!changes.includes("facility") && !changes.includes("care_place")) changes.push(edit.care.facilityId === null ? "care_place" : "facility");
    write("care", edit.care.place);
    placeChanged = true;
  }

  const notes = edit.notes?.trim() || null;
  if (notes !== (trip.notes ?? null)) {
    changes.push("notes");
    data.notes = notes;
  }

  let allowed = trip.allowedVehicleTypes;
  let sharingAllowed = trip.sharingAllowed;
  let sharingStatus = trip.sharingStatus;
  if (edit.prescription && edit.prescription.id !== trip.prescriptionId) {
    changes.push("prescription");
    data.prescriptionId = edit.prescription.id;
    if (!sameTypes(edit.prescription.allowedVehicleTypes, allowed)) data.allowedVehicleTypes = allowed = edit.prescription.allowedVehicleTypes;
    if (edit.prescription.sharingAllowed !== sharingAllowed) data.sharingAllowed = sharingAllowed = edit.prescription.sharingAllowed;
    const next = nextSharingStatus(sharingStatus, sharingAllowed);
    if (next !== sharingStatus) data.sharingStatus = sharingStatus = next;
  }
  // A lock on a vehicle type the prescription no longer allows cannot be kept.
  if (trip.lockedVehicleType !== null && !allowed.includes(trip.lockedVehicleType)) data.lockedVehicleId = null;

  const routed = trip.routeId !== null;
  const vehicleRefused = trip.routeVehicleType !== null && !allowed.includes(trip.routeVehicleType);
  const sharingBroken = trip.shared && !isShareable({ sharingAllowed, sharingStatus });
  const detach = routed && (moved || placeChanged || vehicleRefused || sharingBroken);
  if (detach) {
    Object.assign(data, DETACHED);
    if (trip.status === "ASSIGNED") data.status = "PLANNED";
  }
  return { changes, data, detach, checkFit: routed && !detach && changes.includes("time") };
}

/** French list of what changed: « date, adresse et consignes ». */
export const EDIT_CHANGE_LABELS: Record<EditChange, string> = {
  date: "date",
  time: "horaire",
  home: "adresse du patient",
  facility: "établissement",
  care_place: "adresse de soins",
  notes: "notes",
  prescription: "prescription",
};

export function describeEditChanges(changes: readonly EditChange[]): string {
  const labels = changes.map((c) => EDIT_CHANGE_LABELS[c]);
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} et ${labels.at(-1)}`;
}

/**
 * Why a trip of a recurrence cannot move to another day: the recurrence
 * already plans this leg that day (its own trip still open, or not generated
 * yet), which would send two vehicles. A session of that day cancelled by a
 * person (never brought back by the application) or closed as patient absent
 * leaves the day free, and a trip may always go back to the day of its own
 * session. Null when the move is possible.
 */
export function recurrenceMoveBlocker(
  move: {
    /** The new date is the day of the session the trip serves. */
    ownSession: boolean;
    /** The recurrence plans this leg on the new date. */
    schedulesThatDay: boolean;
    /** The trip of the recurrence serving the new date's session, if generated. */
    sameSessionTrip: { status: TripStatus; cancellationOrigin: "USER" | "SYSTEM" | null } | null;
  },
  formattedDate: string,
): string | null {
  if (move.ownSession || !move.schedulesThatDay) return null;
  const other = move.sameSessionTrip;
  if (other && ((other.status === "CANCELLED" && other.cancellationOrigin === "USER") || other.status === "NO_SHOW")) return null;
  return other
    ? `La récurrence a déjà une course le ${formattedDate} pour ce trajet : modifiez plutôt celle-ci, ou annulez-la d'abord.`
    : `La récurrence prévoit déjà une séance le ${formattedDate} pour ce trajet : choisissez un autre jour, ou modifiez la récurrence.`;
}
