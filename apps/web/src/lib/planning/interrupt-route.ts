/**
 * « Hors service ou indisponible à partir de HH:MM » (DAY-03), server side: records the partial
 * unavailability (VehicleUnavailability or StaffAbsence from that time, lib/fleet/partial-day.ts), closes
 * the route there (interruption.ts) and hands the trips left to the regulator: those not picked up go back
 * « à replacer », a patient on board gets a continuation trip (Trip.continuesTripId) from the place the
 * regulator gave or the last stop done (their trip closed as INTERRUPTED, its pickup kept done on the route).
 * A trip already closed (patient absent, cancelled, interrupted before) is never touched again, and a route
 * with nothing left to do is refused. Everything in one transaction under the planning lock of the date,
 * where the route's crew and the computations of the date are read again; traced: the unavailability,
 * route.interrupt (details: vehicleId, who, fromMinute, counts), trip.detach and trip.unlock for each trip
 * taken off, trip.cancel (reason INTERRUPTED) and trip.create (details.interrupts) for each patient on
 * board. The stops done never change. On a validated plan the regulator is asked first (the drivers'
 * roadmaps change at once). Then the totals of the route cut are evaluated again (refreshCutRoute): the
 * trips taken off no longer count on it. The callers check auth and give the stops a fresh look (refreshPages).
 */
import "server-only";
import type { AbsenceKind, SharingStatus, VehicleUnavailabilityKind } from "@prisma/client";
import { audit, type AuditActor } from "@/lib/audit";
import { db } from "@/lib/db";
import { logError } from "@/lib/log";
import { buildOptimizeRequest, loadOptimizeInput } from "@/lib/optimizer/build-request";
import { evaluate } from "@/lib/optimizer/client";
import { formatLongDate, fromIsoDate, minuteOfDay, todayIso, toIsoDate } from "@/lib/time";
import { lockPlanningDay } from "./day-lock";
import {
  continuationData,
  continuationNote,
  continuationPlace,
  interruptionMessage,
  planInterruption,
  type ContinuationPlace,
  type InterruptWho,
} from "./interruption";
import { optimizationInProgress, OPTIMIZATION_IN_PROGRESS_ERROR, PLANNING_TX_OPTIONS } from "./run-optimization";

export type InterruptInput = {
  routeId: string;
  who: InterruptWho;
  fromMinute: number;
  /** Motive of the unavailability: of the vehicle (VEHICLE), of the person otherwise. */
  kind: VehicleUnavailabilityKind | AbsenceKind;
  note: string | null;
  /** Where the vehicle stopped (« Lieu de l'interruption »), null: the last stop done. */
  place: ContinuationPlace | null;
  /** The question of a validated plan, answered (null: not yet). */
  confirmed: string | null;
};

export type InterruptOutcome =
  | { ok: true; message: string; toPlace: string[]; warning?: boolean }
  | { ok: false; error: string; stale?: boolean; needsConfirmation?: boolean };

const ROUTE_GONE_ERROR = "Tournée introuvable (réoptimisée entre-temps ?) : rechargez la page.";
const CREW_CHANGED_ERROR = "L'équipage de cette tournée a changé entre-temps : rechargez la page.";

/** The question asked before closing a route of a validated plan (same family as placeQuestion). */
export function interruptQuestion(vehicleLabel: string): string {
  return `Planning validé : la feuille de route de ${vehicleLabel} change dès l'enregistrement, prévenez son équipage. Clore la tournée quand même ?`;
}

class Refused extends Error {
  constructor(readonly outcome: Extract<InterruptOutcome, { ok: false }>) {
    super(outcome.error);
  }
}

export async function interruptRoute(input: InterruptInput, user: AuditActor, now: Date = new Date()): Promise<InterruptOutcome> {
  const route = await db.route.findUnique({
    where: { id: input.routeId },
    select: { id: true, serviceDate: true, vehicleId: true, driverId: true, crewMateId: true, vehicle: { select: { label: true, type: true } } },
  });
  if (!route) return { ok: false, error: ROUTE_GONE_ERROR, stale: true };
  const isoDate = toIsoDate(route.serviceDate);
  const today = todayIso(now);
  if (isoDate < today) return { ok: false, error: `Le ${formatLongDate(isoDate)} est passé : son planning n'est plus modifiable.` };
  if (input.who === "CREW_MATE" && route.vehicle.type !== "AMBULANCE") return { ok: false, error: "Seule une ambulance a un équipier." };
  if (await optimizationInProgress(isoDate)) return { ok: false, error: OPTIMIZATION_IN_PROGRESS_ERROR };
  const nowMinute = isoDate === today ? minuteOfDay(now) : null;
  const vehicleLabel = route.vehicle.label;

  let outcome;
  try {
    outcome = await db.$transaction(async (tx) => {
      // Serialized with the computations, placements and validations of the date; a driver's status in flight waits.
      await lockPlanningDay(tx, isoDate);
      await tx.$queryRaw`SELECT "id" FROM "Route" WHERE "id" = ${route.id} FOR UPDATE`;
      // Read again under the locks: a computation started, or a crew changed, since the first read.
      if (await optimizationInProgress(isoDate, tx)) throw new Refused({ ok: false, error: OPTIMIZATION_IN_PROGRESS_ERROR });
      const locked = await tx.route.findUnique({ where: { id: route.id }, select: { driverId: true, crewMateId: true, status: true } });
      if (!locked) throw new Refused({ ok: false, error: ROUTE_GONE_ERROR, stale: true });
      if (locked.driverId !== route.driverId || locked.crewMateId !== route.crewMateId) {
        throw new Refused({ ok: false, error: CREW_CHANGED_ERROR, stale: true });
      }
      const personId = input.who === "DRIVER" ? locked.driverId : input.who === "CREW_MATE" ? locked.crewMateId : null;
      if (input.who !== "VEHICLE" && !personId) {
        throw new Refused({ ok: false, error: input.who === "DRIVER" ? "Cette tournée n'a pas de chauffeur." : "Cette tournée n'a pas d'équipier." });
      }
      const validated = (await tx.route.count({ where: { serviceDate: route.serviceDate, status: "VALIDATED" } })) > 0;
      const question = validated ? interruptQuestion(vehicleLabel) : null;
      if (question !== null && input.confirmed !== question) throw new Refused({ ok: false, error: question, needsConfirmation: true });

      await tx.$queryRaw`SELECT "id" FROM "RouteStop" WHERE "routeId" = ${route.id} ORDER BY "id" FOR UPDATE`;
      const stops = await tx.routeStop.findMany({
        where: { routeId: route.id },
        select: {
          id: true,
          tripId: true,
          kind: true,
          sequence: true,
          startMinute: true,
          departureMinute: true,
          completedAt: true,
          lat: true,
          lng: true,
          address: true,
          trip: { select: { status: true, direction: true } },
        },
      });
      // The statuses read under the locks: a trip closed meanwhile (patient absent, cancelled) is never interrupted.
      const statuses = new Map(stops.map((stop) => [stop.tripId, stop.trip.status]));
      const plan = planInterruption({ stops, statusOf: (id) => statuses.get(id), fromMinute: input.fromMinute, nowMinute });
      if (plan.nothingLeft) {
        throw new Refused({ ok: false, error: `La tournée de ${vehicleLabel} n'a plus rien à faire : rien à interrompre (rechargez la page).`, stale: true });
      }

      const serviceDate = fromIsoDate(isoDate);
      if (input.who === "VEHICLE") {
        const created = await tx.vehicleUnavailability.create({
          data: {
            vehicleId: route.vehicleId,
            kind: input.kind as VehicleUnavailabilityKind,
            startDate: serviceDate,
            endDate: serviceDate,
            startMinute: input.fromMinute,
            note: input.note,
          },
          select: { id: true },
        });
        await audit(tx, user, {
          action: "vehicle_unavailability.create",
          entity: "VehicleUnavailability",
          entityId: created.id,
          details: { vehicleId: route.vehicleId, kind: input.kind, startDate: isoDate, endDate: isoDate, startMinute: input.fromMinute },
        });
      } else {
        const created = await tx.staffAbsence.create({
          data: { driverId: personId!, kind: input.kind as AbsenceKind, startDate: serviceDate, endDate: serviceDate, startMinute: input.fromMinute, note: input.note },
          select: { id: true },
        });
        // Ids only: the reason (sick leave…) stays on the absence itself.
        await audit(tx, user, { action: "staff_absence.create", entity: "StaffAbsence", entityId: created.id, details: { driverId: personId! } });
      }

      if (plan.removedStopIds.length > 0) await tx.routeStop.deleteMany({ where: { id: { in: plan.removedStopIds } } });

      // Trips not picked up: back without a vehicle, unlocked from this one (it cannot take them any more).
      const detached = await tx.trip.findMany({
        where: { id: { in: plan.detachedTripIds } },
        select: { id: true, status: true, sharingStatus: true, lockedVehicleId: true },
      });
      for (const trip of detached) {
        const sharing: { sharingStatus?: SharingStatus; sharingProposedAt?: null } =
          trip.sharingStatus === "PROPOSED" ? { sharingStatus: "NOT_PROPOSED", sharingProposedAt: null } : {};
        const unlocked = trip.lockedVehicleId === route.vehicleId;
        await tx.trip.update({
          where: { id: trip.id },
          data: {
            routeId: null,
            status: trip.status === "ASSIGNED" ? "PLANNED" : trip.status,
            plannedPickupMinute: null,
            plannedDropoffMinute: null,
            shared: false,
            ...sharing,
            ...(unlocked ? { lockedVehicleId: null } : {}),
          },
        });
        await audit(tx, user, { action: "trip.detach", entity: "Trip", entityId: trip.id, serviceDate: isoDate, details: { cause: "route_interrupted" } });
        if (unlocked) await audit(tx, user, { action: "trip.unlock", entity: "Trip", entityId: trip.id, serviceDate: isoDate });
      }

      // Patients on board: picked up again where the vehicle stopped, by a trip of their own.
      const lastDone = stops.find((stop) => stop.id === plan.lastDoneStopId) ?? null;
      const continuations: string[] = [];
      const interrupted = await tx.trip.findMany({ where: { id: { in: plan.interruptedTripIds } } });
      for (const trip of interrupted) {
        const place = continuationPlace({
          given: input.place,
          lastDone: lastDone ? { ...lastDone, direction: lastDone.trip.direction } : null,
          ownPickup: { address: trip.pickupAddress, lat: trip.pickupLat, lng: trip.pickupLng },
          tripId: trip.id,
          vehicleLabel,
          fromMinute: input.fromMinute,
        });
        const created = await tx.trip.create({
          data: continuationData({ trip, place, fromMinute: input.fromMinute, nowMinute, vehicleLabel, who: input.who }),
          select: { id: true },
        });
        continuations.push(created.id);
        await tx.trip.update({
          where: { id: trip.id },
          data: {
            status: "CANCELLED",
            cancellationReason: "INTERRUPTED",
            cancellationOrigin: "USER",
            cancellationNote: continuationNote(vehicleLabel, input.who, input.fromMinute),
            cancelledAt: now,
            cancelledById: user.id,
            lateCancellation: false,
            ...(trip.lockedVehicleId === route.vehicleId ? { lockedVehicleId: null } : {}),
          },
        });
        await audit(tx, user, [
          { action: "trip.cancel", entity: "Trip", entityId: trip.id, serviceDate: isoDate, details: { reason: "INTERRUPTED" } },
          { action: "trip.create", entity: "Trip", entityId: created.id, serviceDate: isoDate, details: { interrupts: trip.id } },
        ]);
      }

      // The route ends where the vehicle stopped (its stops done) or at the time it leaves service; a break planned
      // after that end is no longer on the route.
      const end = Math.max(input.fromMinute, plan.lastKeptDeparture ?? input.fromMinute);
      const stored = await tx.route.findUnique({ where: { id: route.id }, select: { breakStartMinute: true } });
      const breakGone = stored?.breakStartMinute != null && stored.breakStartMinute >= end;
      await tx.route.update({
        where: { id: route.id },
        data: { endMinute: end, ...(breakGone ? { breakStartMinute: null, breakEndMinute: null } : {}) },
      });
      await audit(tx, user, {
        action: "route.interrupt",
        entity: "Route",
        entityId: route.id,
        serviceDate: isoDate,
        details: {
          vehicleId: route.vehicleId,
          who: input.who,
          fromMinute: input.fromMinute,
          detached: plan.detachedTripIds.length,
          interrupted: plan.interruptedTripIds.length,
          ...(input.place ? { placeGiven: true } : {}),
        },
      });
      // The patients waiting by the vehicle first: the most urgent.
      return { plan, toPlace: [...continuations, ...plan.detachedTripIds], keptStopIds: plan.keptStopIds };
    }, PLANNING_TX_OPTIONS);
  } catch (error) {
    if (error instanceof Refused) return error.outcome;
    throw error;
  }

  await refreshCutRoute(route.id, route.vehicleId, isoDate, outcome.keptStopIds);
  const message = interruptionMessage({ vehicleLabel, who: input.who, fromMinute: input.fromMinute, plan: outcome.plan });
  return { ok: true, message, toPlace: outcome.toPlace, ...(outcome.toPlace.length > 0 ? { warning: true } : {}) };
}

/**
 * The totals of the route cut (km, revenue, cost, margin), evaluated again on what it still carries: the trips
 * taken off are counted on the routes that take them, never twice. The stops done and their times stay; the stops
 * of trips closed (patient absent, the patient on board picked up again) are history, not evaluated. Written only
 * while the route still has the stops evaluated. When the optimizer cannot be reached, the stored totals stay
 * (as refresh-routes.ts does): the next computation of the day sets them.
 */
async function refreshCutRoute(routeId: string, vehicleId: string, isoDate: string, keptStopIds: readonly string[]): Promise<void> {
  try {
    const { request } = buildOptimizeRequest(await loadOptimizeInput(db, isoDate));
    const sent = new Set(request.trips.map((trip) => trip.id));
    const stops = await db.routeStop.findMany({ where: { routeId }, select: { id: true, tripId: true, kind: true, sequence: true }, orderBy: { sequence: "asc" } });
    const carried = stops.filter((stop) => sent.has(stop.tripId));
    const empty = { distanceKm: 0, emptyKm: 0, revenue: 0, cost: 0, margin: 0 };
    let totals = empty;
    if (carried.length > 0 && request.vehicles.some((vehicle) => vehicle.id === vehicleId)) {
      const { date, settings, vehicles, trips, tariffs } = request;
      const result = await evaluate({
        date,
        settings,
        vehicles,
        trips,
        tariffs,
        routes: [{ vehicleId, stops: carried.map(({ tripId, kind }) => ({ tripId, kind })) }],
      });
      if (!result.ok) {
        console.warn("[planning] totals of the route cut not recomputed", { serviceDate: isoDate, reason: result.reason ?? "error" });
        return;
      }
      const row = result.data.routes.find((evaluated) => evaluated.vehicleId === vehicleId);
      if (!row) return;
      totals = { distanceKm: row.distanceKm, emptyKm: row.emptyKm, revenue: row.revenue, cost: row.cost, margin: row.margin };
    } else if (carried.length > 0) {
      return; // a vehicle no longer sent (cut before its shift): its totals wait for the next computation
    }
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Route" WHERE "id" = ${routeId} FOR UPDATE`;
      const now = await tx.routeStop.findMany({ where: { routeId }, select: { id: true } });
      const same = now.length === keptStopIds.length && now.every((stop) => keptStopIds.includes(stop.id));
      if (same) await tx.route.update({ where: { id: routeId }, data: totals });
    }, PLANNING_TX_OPTIONS);
  } catch (error) {
    logError("[planning] recomputing the totals of the route cut failed", error, { serviceDate: isoDate });
  }
}
