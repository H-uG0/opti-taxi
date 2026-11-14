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
import { isSeatedOnly, keepsVehicleType } from "@/lib/planning/exceptional-ambulance";
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
  /** A « recours exceptionnel à une ambulance » is in force (isExceptionalAmbulanceTrip): seated only, locked on an ambulance. */
  exceptionalAmbulance: boolean;
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
  /** The trip loses its lock (another day, or a vehicle type its prescription no longer allows): traced trip.unlock. */
  unlocked: boolean;
  /** The exceptional ambulance ends with it (data clears it): traced trip.exceptional_ambulance_withdrawn. */
  exceptionalWithdrawn: boolean;
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
 * another day drops its lock (another day's vehicles) and so ends an
 * exceptional ambulance; notes, a time or a place change keep them (TAR-03).
 * A trip of a recurrence keeps the session it serves (occurrenceDate). Notes
 * never move a trip.
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
  // An exceptional ambulance holds while the trip stays on its day, seated only and locked on it: its lock
  // and its route on that ambulance are kept. A lock on a vehicle type the prescription no longer allows cannot be.
  const exceptional = trip.exceptionalAmbulance && !moved && isSeatedOnly(allowed);
  if (trip.lockedVehicleType !== null && !keepsVehicleType(trip.lockedVehicleType, allowed, exceptional)) data.lockedVehicleId = null;
  const unlocked = trip.lockedVehicleId !== null && data.lockedVehicleId === null;
  const exceptionalWithdrawn = trip.exceptionalAmbulance && !exceptional;
  if (exceptionalWithdrawn) Object.assign(data, { exceptionalAmbulanceAt: null, exceptionalAmbulanceById: null });

  const routed = trip.routeId !== null;
  const vehicleRefused = trip.routeVehicleType !== null && !keepsVehicleType(trip.routeVehicleType, allowed, exceptional);
  const sharingBroken = trip.shared && !isShareable({ sharingAllowed, sharingStatus });
  const detach = routed && (moved || placeChanged || vehicleRefused || sharingBroken);
  if (detach) {
    Object.assign(data, DETACHED);
    if (trip.status === "ASSIGNED") data.status = "PLANNED";
  }
  return { changes, data, detach, checkFit: routed && !detach && changes.includes("time"), unlocked, exceptionalWithdrawn };
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

/** Another trip of the same recurrence and leg, on the new date or serving its session (dates "YYYY-MM-DD"). */
export type RecurrenceTripNearby = {
  status: TripStatus;
  cancellationOrigin: "USER" | "SYSTEM" | null;
  serviceDate: string;
  /** The session it serves (its own date unless moved). */
  occurrenceDate: string;
};

/** A trip a person cancelled (never brought back by the application), or closed as patient absent, leaves its day free. */
function leavesDayFree(trip: RecurrenceTripNearby): boolean {
  return (trip.status === "CANCELLED" && trip.cancellationOrigin === "USER") || trip.status === "NO_SHOW";
}

/**
 * Why a trip of a recurrence cannot move to `newDate`: the recurrence already
 * has a trip of this leg on that day (its own, or one moved there; a trip the
 * application cancelled may come back), or plans one there (the session of
 * that day, not generated yet), which would send two vehicles. A session of
 * that day whose trip was moved to another day, cancelled by a person or
 * closed as patient absent leaves the day free, and a trip may always go back
 * to the day of its own session when no other trip took it. Null when the
 * move is possible.
 */
export function recurrenceMoveBlocker(
  move: {
    newDate: string;
    /** The new date is the day of the session the trip serves. */
    ownSession: boolean;
    /** The recurrence plans this leg on the new date. */
    schedulesThatDay: boolean;
    /** The recurrence's other trips of this leg on the new date or serving its session. */
    others: readonly RecurrenceTripNearby[];
  },
  formattedDate: string,
): string | null {
  if (move.others.some((t) => t.serviceDate === move.newDate && !leavesDayFree(t))) {
    return `La récurrence a déjà une course le ${formattedDate} pour ce trajet\u00a0: modifiez plutôt celle-ci, ou annulez-la d'abord.`;
  }
  if (move.ownSession || !move.schedulesThatDay) return null;
  // The session of that day: served elsewhere (moved), or freed, or not generated yet.
  if (move.others.some((t) => t.occurrenceDate === move.newDate)) return null;
  return `La récurrence prévoit déjà une séance le ${formattedDate} pour ce trajet\u00a0: choisissez un autre jour, ou modifiez la récurrence.`;
}
