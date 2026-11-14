/**
 * A vehicle out of service, or its crew unavailable, from a time of the day (DAY-03): what becomes of
 * its route. Pure: the server step (interrupt-route.ts) reads the route and writes the outcome.
 *
 * - What was done stays (the stops done never change).
 * - From now or earlier (a breakdown): every trip not picked up yet leaves the route (« à replacer »);
 *   a patient on board is picked up again where the vehicle last stopped, by a trip of its own (the
 *   continuation), and their trip is closed as interrupted (its pickup stays done on the route).
 * - From a later time (the garage at 14:00, a person leaving at 15:00): the trips planned to end
 *   before then stay, the others leave; a patient on board now stays (dropped before, or the regulator
 *   sees the shift end).
 * - A trip already closed (the patient was absent, a cancellation, an earlier interruption) is a fact:
 *   its stops done stay, a stop of it left to do (the dropoff of an absent patient) leaves the route, and
 *   it is never interrupted nor taken off again.
 */
import type { Payer, Prisma, SharingStatus, StopKind, TripDirection, TripStatus, VehicleType } from "@prisma/client";
import { formatMinute } from "@/lib/time";
import { isStopDone } from "./stop-done";

export type InterruptStop = {
  id: string;
  tripId: string;
  kind: StopKind;
  sequence: number;
  startMinute: number;
  departureMinute: number;
  completedAt: Date | null;
};

export type InterruptionPlan = {
  keptStopIds: string[];
  removedStopIds: string[];
  /** Trips taken off the route, back without a vehicle (« à replacer »), in route order. */
  detachedTripIds: string[];
  /** Patients on board picked up again by a continuation trip, in route order. */
  interruptedTripIds: string[];
  /** Patients on board kept on the vehicle (an unavailability from a later time). */
  keptOnBoardTripIds: string[];
  /** The last stop done, where a patient on board is picked up again (null: nothing done). */
  lastDoneStopId: string | null;
  /** Departure of the last stop kept (null: none): the route ends there. */
  lastKeptDeparture: number | null;
  /** Nothing left to do on the route (every stop done, or of a trip closed): there is nothing to interrupt. */
  nothingLeft: boolean;
};

/**
 * A return continuation is picked up within this long of its readyMin (contract README « Course de reprise »: the
 * optimizer's window, no wait rule at the facility); the timeline draws it so.
 */
export const CONTINUATION_PICKUP_WINDOW_MIN = 120;

/** Statuses of a trip closed for good: its stops are history, never interrupted nor taken off the route. */
const CLOSED_STATUSES: readonly TripStatus[] = ["NO_SHOW", "CANCELLED"];

/**
 * What happens to a route whose vehicle (or crew) is unavailable from `fromMinute`, at `nowMinute`
 * (null for a later date: nothing is under way).
 */
export function planInterruption(args: {
  stops: readonly InterruptStop[];
  statusOf: (tripId: string) => TripStatus | undefined;
  fromMinute: number;
  nowMinute: number | null;
}): InterruptionPlan {
  const { statusOf, fromMinute, nowMinute } = args;
  const stops = [...args.stops].sort((a, b) => a.sequence - b.sequence);
  const immediate = nowMinute !== null && fromMinute <= nowMinute;
  const byTrip = new Map<string, { pickup?: InterruptStop; dropoff?: InterruptStop }>();
  for (const stop of stops) {
    const entry = byTrip.get(stop.tripId) ?? {};
    if (stop.kind === "PICKUP") entry.pickup ??= stop;
    else entry.dropoff ??= stop;
    byTrip.set(stop.tripId, entry);
  }
  const done = (stop: InterruptStop | undefined) => stop !== undefined && isStopDone(stop, statusOf(stop.tripId));
  const closed = (tripId: string) => CLOSED_STATUSES.includes(statusOf(tripId) as TripStatus);
  const removed = new Set<string>();
  const detached: string[] = [];
  const interrupted: string[] = [];
  const keptOnBoard: string[] = [];
  for (const [tripId, { pickup, dropoff }] of byTrip) {
    if (closed(tripId)) {
      // A fact: its stops done stay; a stop of it left to do (an absent patient's dropoff) is not driven.
      for (const stop of [pickup, dropoff]) if (stop && !done(stop)) removed.add(stop.id);
      continue;
    }
    const pickedUp = done(pickup) || done(dropoff);
    const droppedOff = done(dropoff);
    if (pickedUp && droppedOff) continue;
    if (pickedUp) {
      if (immediate) {
        interrupted.push(tripId);
        if (dropoff) removed.add(dropoff.id);
      } else {
        keptOnBoard.push(tripId);
      }
      continue;
    }
    // Not picked up yet: kept only when the route ends it before the unavailability.
    const endsBefore = !immediate && dropoff !== undefined && dropoff.departureMinute <= fromMinute;
    if (endsBefore) continue;
    detached.push(tripId);
    for (const stop of [pickup, dropoff]) if (stop) removed.add(stop.id);
  }
  const kept = stops.filter((stop) => !removed.has(stop.id));
  const lastDone = [...stops].reverse().find((stop) => done(stop)) ?? null;
  return {
    keptStopIds: kept.map((stop) => stop.id),
    removedStopIds: stops.filter((stop) => removed.has(stop.id)).map((stop) => stop.id),
    detachedTripIds: detached,
    interruptedTripIds: interrupted,
    keptOnBoardTripIds: keptOnBoard,
    lastDoneStopId: lastDone?.id ?? null,
    lastKeptDeparture: kept.length > 0 ? Math.max(...kept.map((stop) => stop.departureMinute)) : null,
    nothingLeft: stops.every((stop) => done(stop) || closed(stop.tripId)),
  };
}

/** The trip a patient on board was riding, as the continuation copies it. */
export type InterruptedTrip = {
  id: string;
  serviceDate: Date;
  direction: TripDirection;
  patientId: string;
  prescriptionId: string | null;
  facilityId: string | null;
  payer: Payer;
  allowedVehicleTypes: VehicleType[];
  pickupAddress: string;
  dropoffAddress: string;
  dropoffLat: number;
  dropoffLng: number;
  appointmentMinute: number | null;
  readyMinute: number | null;
  sharingAllowed: boolean;
  sharingStatus: SharingStatus;
  sharingRespondedAt: Date | null;
  sharingRespondedById: string | null;
  sharingNote: string | null;
};

/** Where a continuation picks the patient up again. */
export type ContinuationPlace = { address: string; lat: number; lng: number };

/**
 * Where the patient is picked up again: the place the regulator gave (« Lieu de l'interruption »), else the
 * last stop done. That stop is named when it is the patient's own stop or a facility; another patient's home
 * is never copied onto this patient's trip (data minimisation): a neutral label with its coordinates.
 */
export function continuationPlace(args: {
  given: ContinuationPlace | null;
  lastDone: { tripId: string; kind: StopKind; address: string; lat: number; lng: number; direction: TripDirection } | null;
  ownPickup: { address: string; lat: number; lng: number };
  tripId: string;
  vehicleLabel: string;
  fromMinute: number;
}): ContinuationPlace {
  const { given, lastDone, ownPickup, tripId, vehicleLabel, fromMinute } = args;
  if (given) return given;
  if (!lastDone) return ownPickup;
  const atFacility = (lastDone.direction === "OUTBOUND") === (lastDone.kind === "DROPOFF");
  if (lastDone.tripId === tripId || atFacility) return { address: lastDone.address, lat: lastDone.lat, lng: lastDone.lng };
  return { address: `Lieu de l'interruption (${vehicleLabel}, ${formatMinute(fromMinute)})`, lat: lastDone.lat, lng: lastDone.lng };
}

/** « Taxi 59 (Grenoble) hors service à 11:00, course de reprise créée. »: the note of both trips (never a medical detail). */
export function continuationNote(vehicleLabel: string, who: InterruptWho, fromMinute: number): string {
  return `${vehicleLabel} ${WHO_TEXT[who]} à ${formatMinute(fromMinute)}, course de reprise créée.`;
}

/**
 * The continuation of a trip whose patient was on board when it was interrupted: the same patient, leg,
 * prescription, facility and vehicle types, picked up where the vehicle stopped (`place`). An outbound keeps
 * its appointment; a return is ready from the interruption, or from now when it is recorded later. The
 * refusal to share stays, with its trace (who recorded it, when, the note), and so does « not eligible »;
 * otherwise sharing is proposed again (an acceptance was for the ride interrupted).
 * Never a series' trip (no recurrence: one trip per session of a series), never locked.
 */
export function continuationData(args: {
  trip: InterruptedTrip;
  place: ContinuationPlace;
  fromMinute: number;
  nowMinute: number | null;
  vehicleLabel: string;
  who: InterruptWho;
}): Prisma.TripUncheckedCreateInput {
  const { trip, place, fromMinute, nowMinute, vehicleLabel, who } = args;
  // The patient's refusal (traced) and a prescription without sharing stay; an acceptance was for another ride.
  const kept = trip.sharingStatus === "REFUSED" || trip.sharingStatus === "NOT_ELIGIBLE";
  const sharing = kept
    ? {
        sharingStatus: trip.sharingStatus,
        sharingRespondedAt: trip.sharingRespondedAt,
        sharingRespondedById: trip.sharingRespondedById,
        sharingNote: trip.sharingNote,
      }
    : { sharingStatus: "NOT_PROPOSED" as const };
  return {
    serviceDate: trip.serviceDate,
    direction: trip.direction,
    patientId: trip.patientId,
    prescriptionId: trip.prescriptionId,
    facilityId: trip.facilityId,
    payer: trip.payer,
    allowedVehicleTypes: trip.allowedVehicleTypes,
    // The home side of an outbound is its pickup: here, the place of the interruption, for this trip only.
    oneOffAddress: trip.direction === "OUTBOUND",
    pickupAddress: place.address,
    pickupLat: place.lat,
    pickupLng: place.lng,
    dropoffAddress: trip.dropoffAddress,
    dropoffLat: trip.dropoffLat,
    dropoffLng: trip.dropoffLng,
    appointmentMinute: trip.direction === "OUTBOUND" ? trip.appointmentMinute : null,
    // A return: the patient waits by the vehicle from the interruption, or from now when it is recorded later.
    readyMinute: trip.direction === "RETURN" ? Math.max(trip.readyMinute ?? 0, fromMinute, nowMinute ?? 0) : null,
    sharingAllowed: trip.sharingAllowed,
    ...sharing,
    notes: continuationNote(vehicleLabel, who, fromMinute),
    continuesTripId: trip.id,
    interruptedAtMinute: fromMinute,
  };
}

/** Who becomes unavailable: the vehicle itself, its driver, or the crew mate of an ambulance. */
export type InterruptWho = "VEHICLE" | "DRIVER" | "CREW_MATE";

const WHO_TEXT: Record<InterruptWho, string> = {
  VEHICLE: "hors service",
  DRIVER: "sans chauffeur",
  CREW_MATE: "sans équipier",
};

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

/**
 * « Taxi 3 hors service à partir de 11:20 : 2 courses à replacer, 1 patient à bord repris au lieu du dernier
 * arrêt (course de reprise créée). » What the interruption did, for the regulator.
 */
export function interruptionMessage(args: { vehicleLabel: string; who: InterruptWho; fromMinute: number; plan: InterruptionPlan }): string {
  const { vehicleLabel, who, fromMinute, plan } = args;
  const toPlace = plan.detachedTripIds.length + plan.interruptedTripIds.length;
  const parts: string[] = [];
  parts.push(toPlace > 0 ? `${plural(toPlace, "course", "courses")} à replacer` : "aucune course à replacer");
  if (plan.interruptedTripIds.length > 0) {
    parts.push(
      `${plural(plan.interruptedTripIds.length, "patient à bord attend", "patients à bord attendent")} près du véhicule (${plural(plan.interruptedTripIds.length, "course de reprise créée", "courses de reprise créées")}, à placer en premier)`,
    );
  }
  if (plan.keptOnBoardTripIds.length > 0) {
    parts.push(`${plural(plan.keptOnBoardTripIds.length, "patient à bord reste", "patients à bord restent")} jusqu'à sa dépose`);
  }
  return `${vehicleLabel} ${WHO_TEXT[who]} à partir de ${formatMinute(fromMinute)}\u00a0: ${parts.join(", ")}.`;
}
