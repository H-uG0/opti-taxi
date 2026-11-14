/**
 * « Hors service ou indisponible à partir de HH:MM » (DAY-03), server side: records the partial
 * unavailability (VehicleUnavailability or StaffAbsence from that time, lib/fleet/partial-day.ts), closes
 * the route there (interruption.ts) and hands the trips left to the regulator: those not picked up go back
 * « à replacer », a patient on board gets a continuation trip from the place of the last stop done (their
 * trip closed as INTERRUPTED, its pickup kept done on the route). Everything in one transaction under the
 * planning lock of the date, traced: the unavailability, route.interrupt (details: vehicleId, who,
 * fromMinute, counts), trip.detach and trip.unlock for each trip taken off, trip.cancel (reason
 * INTERRUPTED) and trip.create (details.interrupts) for each patient on board. The stops done never change.
 * The callers check auth and give the stops a fresh look (refreshPages).
 */
import "server-only";
import type { AbsenceKind, SharingStatus, VehicleUnavailabilityKind } from "@prisma/client";
import { audit, type AuditActor } from "@/lib/audit";
import { db } from "@/lib/db";
import { formatLongDate, formatMinute, fromIsoDate, minuteOfDay, todayIso, toIsoDate } from "@/lib/time";
import { lockPlanningDay } from "./day-lock";
import { interruptionMessage, planInterruption, type InterruptWho } from "./interruption";
import { optimizationInProgress, OPTIMIZATION_IN_PROGRESS_ERROR, PLANNING_TX_OPTIONS } from "./run-optimization";

export type InterruptInput = {
  routeId: string;
  who: InterruptWho;
  fromMinute: number;
  /** Motive of the unavailability: of the vehicle (VEHICLE), of the person otherwise. */
  kind: VehicleUnavailabilityKind | AbsenceKind;
  note: string | null;
};

export type InterruptOutcome =
  | { ok: true; message: string; toPlace: string[]; warning?: boolean }
  | { ok: false; error: string; stale?: boolean };

/** What the planning says of a continuation trip (never a medical detail). */
function continuationNote(vehicleLabel: string, fromMinute: number): string {
  return `Reprise du patient au lieu du dernier arrêt\u00a0: transport interrompu (${vehicleLabel}, ${formatMinute(fromMinute)}).`;
}

export async function interruptRoute(input: InterruptInput, user: AuditActor, now: Date = new Date()): Promise<InterruptOutcome> {
  const route = await db.route.findUnique({
    where: { id: input.routeId },
    select: { id: true, serviceDate: true, vehicleId: true, driverId: true, crewMateId: true, vehicle: { select: { label: true, type: true } } },
  });
  if (!route) return { ok: false, error: "Tournée introuvable (réoptimisée entre-temps\u202f?)\u00a0: rechargez la page.", stale: true };
  const isoDate = toIsoDate(route.serviceDate);
  const today = todayIso(now);
  if (isoDate < today) return { ok: false, error: `Le ${formatLongDate(isoDate)} est passé\u00a0: son planning n'est plus modifiable.` };
  const personId = input.who === "DRIVER" ? route.driverId : input.who === "CREW_MATE" ? route.crewMateId : null;
  if (input.who !== "VEHICLE" && !personId) {
    return { ok: false, error: input.who === "DRIVER" ? "Cette tournée n'a pas de chauffeur." : "Cette tournée n'a pas d'équipier." };
  }
  if (input.who === "CREW_MATE" && route.vehicle.type !== "AMBULANCE") return { ok: false, error: "Seule une ambulance a un équipier." };
  if (await optimizationInProgress(isoDate)) return { ok: false, error: OPTIMIZATION_IN_PROGRESS_ERROR };
  const nowMinute = isoDate === today ? minuteOfDay(now) : null;

  const outcome = await db.$transaction(async (tx) => {
    // Serialized with the computations, placements and validations of the date; a driver's status in flight waits.
    await lockPlanningDay(tx, isoDate);
    await tx.$queryRaw`SELECT "id" FROM "Route" WHERE "id" = ${route.id} FOR UPDATE`;
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
        trip: { select: { status: true } },
      },
    });
    const statuses = new Map(stops.map((stop) => [stop.tripId, stop.trip.status]));
    const plan = planInterruption({ stops, statusOf: (id) => statuses.get(id), fromMinute: input.fromMinute, nowMinute });

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

    // Patients on board: picked up again where the vehicle last stopped, by a trip of their own.
    const lastDone = stops.find((stop) => stop.id === plan.lastDoneStopId) ?? null;
    const continuations: string[] = [];
    const interrupted = await tx.trip.findMany({ where: { id: { in: plan.interruptedTripIds } } });
    for (const trip of interrupted) {
      const at = lastDone ?? stops.find((stop) => stop.tripId === trip.id && stop.kind === "PICKUP")!;
      const created = await tx.trip.create({
        data: {
          serviceDate: trip.serviceDate,
          direction: trip.direction,
          patientId: trip.patientId,
          prescriptionId: trip.prescriptionId,
          facilityId: trip.facilityId,
          payer: trip.payer,
          allowedVehicleTypes: trip.allowedVehicleTypes,
          // The home side of an outbound is where the patient is picked up: here, the place of the stop.
          oneOffAddress: trip.direction === "OUTBOUND",
          pickupAddress: at.address,
          pickupLat: at.lat,
          pickupLng: at.lng,
          dropoffAddress: trip.dropoffAddress,
          dropoffLat: trip.dropoffLat,
          dropoffLng: trip.dropoffLng,
          appointmentMinute: trip.direction === "OUTBOUND" ? trip.appointmentMinute : null,
          // A return: the patient waits where the vehicle stopped, ready now.
          readyMinute: trip.direction === "RETURN" ? Math.max(trip.readyMinute ?? 0, input.fromMinute) : null,
          sharingAllowed: trip.sharingAllowed,
          sharingStatus: trip.sharingStatus === "NOT_ELIGIBLE" ? "NOT_ELIGIBLE" : "NOT_PROPOSED",
          notes: continuationNote(route.vehicle.label, input.fromMinute),
        },
        select: { id: true },
      });
      continuations.push(created.id);
      await tx.trip.update({
        where: { id: trip.id },
        data: {
          status: "CANCELLED",
          cancellationReason: "INTERRUPTED",
          cancellationOrigin: "USER",
          cancellationNote: continuationNote(route.vehicle.label, input.fromMinute),
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
      },
    });
    return { plan, toPlace: [...plan.detachedTripIds, ...continuations] };
  }, PLANNING_TX_OPTIONS);

  const message = interruptionMessage({ vehicleLabel: route.vehicle.label, who: input.who, fromMinute: input.fromMinute, plan: outcome.plan });
  return { ok: true, message, toPlace: outcome.toPlace, ...(outcome.toPlace.length > 0 ? { warning: true } : {}) };
}
