/**
 * One simulated day, in the order things happen at V:
 * 1. the week's trips are generated from the recurrences (the Friday before);
 * 2. the day before: sessions cancelled by phone, refusals already known,
 *    « Optimiser demain » (16:30 – 17:00), phone calls to the patients the plan
 *    shares, a re-optimization after each round with a refusal (planning.ts),
 *    the trips no plan could place handed over to a partner company, then
 *    « Valider le planning »;
 * 3. on the day: cancellations (the trip leaves its route, which is
 *    recomputed), absent patients and the statuses tapped by the crews.
 *
 * Every write goes through the app's own modules (trip generation, request
 * builder, savePlan, sharing decision, detach, route refresh); only the
 * instants are set to when things would have happened. Like the app, a
 * sharing answer keeps the regulator account that recorded it, a status the
 * crew account that tapped it, and the audit events of these actions
 * (audit.ts) are written in the transaction of the change. A day that cannot be
 * completed (no solution, refusals beyond the cap) is removed, never left
 * half-written. The Prisma client is the script's own: nothing here is
 * server-only.
 */
import type { Prisma, PrismaClient, TripStatus } from "@prisma/client";
import { isLateCancellation, userCancellation } from "@/lib/domain/cancellation";
import { isSameEpisode } from "@/lib/domain/no-show";
import { planTripsFromRecurrences, type RecurrenceForGeneration } from "@/lib/domain/trip-generation";
import { buildOptimizeRequest, loadOptimizeInput } from "@/lib/optimizer/build-request";
import type { PlanResponse } from "@/lib/optimizer/contract";
import { savePlan } from "@/lib/optimizer/persist";
import { withBeforeCommit } from "@/lib/planning/before-commit";
import { removeTripStops } from "@/lib/planning/detach";
import { refreshRoutes } from "@/lib/planning/refresh-routes";
import { fromIsoDate, toIsoDate } from "@/lib/time";
import { liftAuditGuard, restoreAuditGuard } from "../audit-guard";
import type { Rng } from "../seed/random";
import {
  answerInstants,
  dayClosingInstant,
  firstRunStart,
  handOverInstants,
  knownRefusalInstants,
  parisInstant,
  rerunStart,
  runFinish,
  tripGenerationInstant,
  validationInstant,
} from "./calendar";
import { DayAuditTrail, sharingAuditAction, stopAuditAction, type AuditActor } from "./audit";
import type { AnyFacilityKey } from "../seed/data";
import {
  AFTER_NO_SHOW_NOTE,
  AFTER_NO_SHOW_REASON,
  cancellationsBeforePlanning,
  crewRecordsStatuses,
  decideDayEvents,
  fieldStatusUpdates,
  patientCancellationReason,
  simulateRouteTimes,
  stopRecorder,
} from "./field";
import { rngFor } from "./hash";
import { historyRunId, historyTripId } from "./ids";
import { withTimeLimit, type OptimizerClient } from "./optimizer";
import { planOneOffDay, type DestinationRow, type PoolPatientRow } from "./one-off";
import { foreignRowsWhere, simulatedRowsWhere } from "./ownership";
import { planStaffEvents, type StaffMember } from "./staff";
import { tripsToLock } from "./tweaks";
import { handOverCancellation, MAX_RUNS_PER_DAY, nextPlanningStep, unplacedTripIds } from "./planning";
import { emptyDayReport, type DayReport, type ForeignRowCounts } from "./report";
import { answerData, isHabitualRefuser, knownRefusal, sharingAnswer, UNANSWERED } from "./sharing";

/** What a cancelled trip loses, as with « Annuler » in « Courses »: its route, its planned results and its lock. */
const CLEARED_PLANNING = {
  routeId: null,
  plannedPickupMinute: null,
  plannedDropoffMinute: null,
  shared: false,
  detourKm: null,
  estimatedRevenue: null,
  lockedVehicleId: null,
} satisfies Prisma.TripUncheckedUpdateManyInput;

export type DayContext = {
  prisma: PrismaClient;
  seed: number;
  /** Recurrences covering the simulated dates, with patient, facility and prescription. */
  recurrences: RecurrenceForGeneration[];
  optimizer: OptimizerClient;
  /** Solver time limit override (s), null = the request the app would send. */
  budgetSec: number | null;
  /** Regulator account credited with the runs, the sharing answers and the validation. */
  regulatorId: string;
  /** Driver id -> id of its user account: who taps the statuses (stopRecorder). */
  driverAccounts: ReadonlyMap<string, string>;
  /** Setting lateCancellationHours: a cancellation closer than this to the pickup is late. */
  lateCancellationHours: number;
  /** The seed's occasional patients (one-off care, one-off.ts) and the facilities they go to, by seed key. */
  pool: readonly PoolPatientRow[];
  facilities: ReadonlyMap<AnyFacilityKey, DestinationRow>;
  /** Active people and vehicles: absences and vehicles off the road of the day (staff.ts). */
  staff: readonly StaffMember[];
  vehicleIds: readonly string[];
};

export type RowCounts = { trips: number; routes: number; runs: number };

/** What clearing a date removed: its rows, and the audit events of its simulated actions. */
export type ClearedRows = RowCounts & { events: number };

function regulator(ctx: DayContext): AuditActor {
  return { id: ctx.regulatorId, role: "REGULATOR" };
}

// ---------------------------------------------------------------------------
// Ownership: what the simulation created on a date, and what it did not (filters in ownership.ts)

/**
 * Rows of the date the simulation did not create, and changes the app recorded
 * on it (audit events, reads excepted): when there is any, the date is left untouched.
 */
export async function foreignRows(prisma: PrismaClient, isoDate: string): Promise<ForeignRowCounts> {
  const where = foreignRowsWhere(fromIsoDate(isoDate));
  const [trips, routes, runs, events] = await Promise.all([
    prisma.trip.count({ where: where.trips }),
    prisma.route.count({ where: where.routes }),
    prisma.optimizationRun.count({ where: where.runs }),
    prisma.auditEvent.count({ where: where.events }),
  ]);
  return { trips, routes, runs, events };
}

/**
 * Dates between `from` and `to` holding rows the simulation did not create or
 * a change recorded by the app (one query per model): pickSimulationDates
 * passes over them.
 */
export async function foreignDates(prisma: PrismaClient, from: string, to: string): Promise<Set<string>> {
  const where = foreignRowsWhere({ gte: fromIsoDate(from), lte: fromIsoDate(to) });
  const groups = await Promise.all([
    prisma.trip.groupBy({ by: ["serviceDate"], where: where.trips }),
    prisma.route.groupBy({ by: ["serviceDate"], where: where.routes }),
    prisma.optimizationRun.groupBy({ by: ["serviceDate"], where: where.runs }),
    prisma.auditEvent.groupBy({ by: ["serviceDate"], where: where.events }),
  ]);
  // The range filter leaves out events without a service date; the type does not know it.
  return new Set(groups.flat().flatMap((row) => (row.serviceDate ? [toIsoDate(row.serviceDate)] : [])));
}

/**
 * Deletes what a previous simulation created on the date (stops cascade with
 * routes and trips). Its own audit events only ("hist-" ids): the append-only
 * trigger is lifted for this transaction alone (audit-guard.ts).
 */
export async function clearSimulatedDay(prisma: PrismaClient, isoDate: string): Promise<ClearedRows> {
  const where = simulatedRowsWhere(fromIsoDate(isoDate));
  const [, routes, trips, , , , runs, events] = await prisma.$transaction([
    liftAuditGuard(prisma),
    prisma.route.deleteMany({ where: where.routes }),
    prisma.trip.deleteMany({ where: where.trips }),
    prisma.prescription.deleteMany({ where: where.prescriptions }),
    prisma.staffAbsence.deleteMany({ where: where.absences }),
    prisma.vehicleUnavailability.deleteMany({ where: where.unavailabilities }),
    prisma.optimizationRun.deleteMany({ where: where.runs }),
    prisma.auditEvent.deleteMany({ where: where.events }),
    restoreAuditGuard(prisma),
  ]);
  return { trips: trips.count, routes: routes.count, runs: runs.count, events: events.count };
}

/** A day that cannot be completed is removed rather than left half-written, and reported as skipped. */
async function giveUpDay(prisma: PrismaClient, isoDate: string, reason: string): Promise<DayReport> {
  await clearSimulatedDay(prisma, isoDate);
  return emptyDayReport(isoDate, `${reason} (jour retiré)`);
}

// ---------------------------------------------------------------------------
// The day before

export type RunOutcome = { ok: true; finishedAt: Date } | { ok: false; error: string };

/** « Optimiser demain », as lib/planning/run-optimization.ts runs it, started at `startedAt` (exported for day.test.ts). */
export async function optimizeOnce(
  ctx: DayContext,
  trail: DayAuditTrail,
  isoDate: string,
  round: number,
  startedAt: Date,
  rng: Rng,
): Promise<RunOutcome> {
  const { prisma } = ctx;
  const build = buildOptimizeRequest(await loadOptimizeInput(prisma, isoDate));
  if (build.request.trips.length === 0) return { ok: false, error: "aucune course à envoyer à l'optimiseur" };
  if (build.request.vehicles.length === 0) return { ok: false, error: "aucun véhicule disponible ce jour" };
  const request = withTimeLimit(build.request, ctx.budgetSec);

  const runId = historyRunId(isoDate, round);
  await prisma.optimizationRun.create({
    data: {
      id: runId,
      serviceDate: fromIsoDate(isoDate),
      status: "RUNNING",
      startedAt,
      requestedById: ctx.regulatorId,
      tripsCount: request.trips.length,
      lockedCount: request.trips.filter((t) => t.lockedVehicleId).length,
    },
  });

  let plan: PlanResponse;
  try {
    plan = await ctx.optimizer.optimize(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.optimizationRun.update({ where: { id: runId }, data: { status: "FAILED", finishedAt: startedAt, error: message } });
    throw error;
  }
  const finishedAt = runFinish(startedAt, plan.meta.wallTimeMs, rng);
  if (plan.status === "NO_SOLUTION") {
    const error = `Aucune solution trouvée en ${request.settings.timeLimitSec} s.`;
    await prisma.optimizationRun.update({
      where: { id: runId },
      data: { status: "FAILED", finishedAt, error, matrixSource: plan.meta.matrixSource, wallTimeMs: plan.meta.wallTimeMs },
    });
    return { ok: false, error: `optimisation sans solution (${error})` };
  }

  // As runOptimization: the plan.optimize event commits with the saved plan (or rolls back with it),
  // at the instant of the save. savePlan stamps the run with the real clock: in the same transaction,
  // the run gets back the instants of the day before. Trips the plan newly shares become PROPOSED at `finishedAt`.
  const traced = withBeforeCommit(prisma, async (tx) => {
    await tx.optimizationRun.update({ where: { id: runId }, data: { startedAt, finishedAt } });
    await tx.auditEvent.createMany({ data: [trail.event(regulator(ctx), "plan.optimize", runId, finishedAt)] });
  });
  await savePlan(traced, { runId, isoDate, request, response: plan, crews: build.crews, now: finishedAt });
  return { ok: true, finishedAt };
}

/**
 * The regulator calls every patient whose trip is proposed for sharing and
 * records the answer. Returns the refusals actually saved (exported for day.test.ts).
 */
export async function answerProposals(
  ctx: DayContext,
  trail: DayAuditTrail,
  serviceDate: Date,
  after: Date,
  rng: Rng,
): Promise<{ refused: number; lastAt: Date | null }> {
  const { prisma } = ctx;
  const proposed = await prisma.trip.findMany({
    where: { serviceDate, sharingStatus: "PROPOSED" },
    select: {
      id: true,
      patientId: true,
      direction: true,
      sharingStatus: true,
      sharingProposedAt: true,
      sharingRespondedAt: true,
      sharingNote: true,
    },
    orderBy: [{ plannedPickupMinute: "asc" }, { id: "asc" }],
  });
  const instants = answerInstants(after, proposed.length, rng);
  if (proposed.length === 0) return { refused: 0, lastAt: null };
  const refused = await prisma.$transaction(
    async (tx) => {
      let refusedCount = 0;
      const events: Prisma.AuditEventCreateManyInput[] = [];
      for (const [index, trip] of proposed.entries()) {
        const answer = sharingAnswer(trip);
        const at = instants[index] ?? after;
        // Guarded on the answer read above, like the « Courses » action: an answer recorded meanwhile
        // (in the app) is not overwritten, and no event is written for an answer that was not saved.
        const { count } = await tx.trip.updateMany({
          where: { id: trip.id, sharingStatus: trip.sharingStatus, sharingRespondedAt: trip.sharingRespondedAt },
          data: answerData(trip, answer, at, ctx.regulatorId),
        });
        if (count === 0) continue;
        if (answer.decision === "REFUSED") refusedCount++;
        events.push(trail.event(regulator(ctx), sharingAuditAction(answer.decision), trip.id, at));
      }
      if (events.length > 0) await tx.auditEvent.createMany({ data: events });
      return refusedCount;
    },
    { maxWait: 30_000, timeout: 60_000 },
  );
  return { refused, lastAt: instants.at(-1) ?? null };
}

/**
 * Trips the last optimization left on no route are handed over to a partner
 * company: the regulator calls it, writes it in the trip's note and cancels
 * the trip in « Courses » (same fields as « Annuler »). Returns how many, and
 * the instant of the last call (null when there was none).
 */
async function handOverUnplaced(
  prisma: PrismaClient,
  trail: DayAuditTrail,
  actor: AuditActor,
  serviceDate: Date,
  after: Date,
  rng: Rng,
): Promise<{ handedOver: number; lastAt: Date | null }> {
  const trips = await prisma.trip.findMany({
    where: simulatedRowsWhere(serviceDate).trips,
    select: { id: true, status: true, routeId: true },
  });
  const ids = unplacedTripIds(trips);
  if (ids.length === 0) return { handedOver: 0, lastAt: null };
  const regulatorId = actor.id;
  if (!regulatorId) throw new Error("Remise à un confrère sans compte régulateur");
  const byId = new Map(trips.map((trip) => [trip.id, trip]));
  const instants = handOverInstants(after, ids.length, rng);
  // Each cancellation is traced like « Annuler » (trip.cancel), only when it applied, with the reason « confiée à un confrère ».
  await prisma.$transaction(
    async (tx) => {
      const events: Prisma.AuditEventCreateManyInput[] = [];
      for (const [index, id] of ids.entries()) {
        const trip = byId.get(id);
        const at = instants[index] ?? after;
        const { count } = await tx.trip.updateMany({
          where: { id, status: trip?.status, routeId: null },
          data: { ...CLEARED_PLANNING, status: "CANCELLED", ...handOverCancellation(regulatorId, at) },
        });
        if (count > 0) events.push(trail.event(actor, "trip.cancel", id, at));
      }
      if (events.length > 0) await tx.auditEvent.createMany({ data: events });
    },
    { maxWait: 30_000, timeout: 60_000 },
  );
  return { handedOver: ids.length, lastAt: instants.at(-1) ?? null };
}

/**
 * « Figer » after the first plan: the trips of the patients who ask for their
 * usual driver stay on the vehicle the plan gave them (tweaks.ts), traced
 * trip.lock like the planning's action, a minute or two after the plan.
 */
async function lockPreferredDrivers(ctx: DayContext, trail: DayAuditTrail, serviceDate: Date, after: Date, rng: Rng): Promise<number> {
  const { prisma } = ctx;
  const trips = await prisma.trip.findMany({
    where: { serviceDate, status: "ASSIGNED", routeId: { not: null } },
    select: { id: true, patientId: true, recurrenceId: true, lockedVehicleId: true, route: { select: { vehicleId: true } } },
  });
  const locks = tripsToLock(trips.map((t) => ({ ...t, vehicleId: t.route?.vehicleId ?? null })));
  if (locks.length === 0) return 0;
  let at = new Date(after.getTime() + rng.int(40, 90) * 1000);
  const events: Prisma.AuditEventCreateManyInput[] = [];
  await prisma.$transaction(async (tx) => {
    for (const lock of locks) {
      const { count } = await tx.trip.updateMany({
        where: { id: lock.id, lockedVehicleId: null, route: { is: { vehicleId: lock.vehicleId } } },
        data: { lockedVehicleId: lock.vehicleId },
      });
      if (count === 0) continue;
      events.push(trail.event(regulator(ctx), "trip.lock", lock.id, at));
      at = new Date(at.getTime() + rng.int(10, 30) * 1000);
    }
    if (events.length > 0) await tx.auditEvent.createMany({ data: events });
  });
  return events.length;
}

// ---------------------------------------------------------------------------
// The day itself

type FieldOutcome = { noShows: number; late: number; refreshed: number; notRefreshed: number; unrecorded: number };

async function simulateField(ctx: DayContext, trail: DayAuditTrail, isoDate: string): Promise<FieldOutcome> {
  const { prisma } = ctx;
  const serviceDate = fromIsoDate(isoDate);
  // Crews that record no status today (crewRecordsStatuses): no absence is declared on their routes either.
  const dayRoutes = await prisma.route.findMany({ where: { serviceDate }, select: { id: true, vehicleId: true } });
  const silentRouteIds = new Set(dayRoutes.filter((r) => !crewRecordsStatuses(isoDate, r.vehicleId)).map((r) => r.id));
  const trips = await prisma.trip.findMany({
    where: { serviceDate },
    select: {
      id: true,
      patientId: true,
      recurrenceId: true,
      facilityId: true,
      direction: true,
      status: true,
      routeId: true,
      appointmentMinute: true,
      readyMinute: true,
      plannedPickupMinute: true,
    },
    orderBy: { id: "asc" },
  });
  const events = decideDayEvents(trips, isoDate, silentRouteIds);

  // « Annuler » in « Courses »: the trip leaves its route; the routes it left are then
  // recomputed. Traced trip.cancel early in the morning for a cancellation by phone; a
  // return cancelled because its outbound was declared absent is traced just after that
  // absence, with the crews' statuses below (never before its cause).
  const leftRoutes = new Set<string>();
  const morning = parisInstant(isoDate, 6 * 60 + 30);
  const cancelledAfterNoShow: string[] = [];
  for (const trip of trips) {
    const reason = events.cancellations.get(trip.id);
    if (!reason) continue;
    // A return after an absence is cancelled once the absence is known; its instant is refined below for the trail.
    const fields = userCancellation({
      reason: reason === "AFTER_NO_SHOW" ? AFTER_NO_SHOW_REASON : patientCancellationReason(isoDate, trip.patientId),
      note: reason === "AFTER_NO_SHOW" ? AFTER_NO_SHOW_NOTE : null,
      actorId: ctx.regulatorId,
      now: morning,
      late: isLateCancellation({ ...trip, serviceDate: isoDate }, morning, ctx.lateCancellationHours),
    });
    const detached = await prisma.$transaction(async (tx) => {
      const updated = await tx.trip.updateMany({
        where: { id: trip.id, status: trip.status },
        data: { ...CLEARED_PLANNING, status: "CANCELLED", ...fields },
      });
      if (updated.count === 0) return null;
      if (reason === "AFTER_NO_SHOW") cancelledAfterNoShow.push(trip.id);
      else await tx.auditEvent.createMany({ data: [trail.event(regulator(ctx), "trip.cancel", trip.id, morning)] });
      return removeTripStops(tx, trip.id);
    });
    for (const routeId of detached?.routeIds ?? []) leftRoutes.add(routeId);
  }
  const refresh = await refreshRoutes(
    { prisma, evaluate: ctx.optimizer.evaluate, now: parisInstant(isoDate, 7 * 60) },
    leftRoutes,
  );

  // The crews' statuses, route by route.
  const routes = await prisma.route.findMany({
    where: { serviceDate, id: { notIn: [...silentRouteIds] } },
    select: {
      vehicleId: true,
      driverId: true,
      crewMateId: true,
      stops: {
        select: {
          id: true,
          tripId: true,
          kind: true,
          sequence: true,
          lat: true,
          lng: true,
          arrivalMinute: true,
          startMinute: true,
          departureMinute: true,
        },
      },
    },
    orderBy: { vehicleId: "asc" },
  });
  const timing = new Map(trips.map((t) => [t.id, t]));
  const writes: Prisma.PrismaPromise<unknown>[] = [];
  const audits: Prisma.AuditEventCreateManyInput[] = [];
  const droppedOff = new Set<string>();
  const absentAt = new Map<string, Date>();
  let late = 0;
  for (const route of routes) {
    const result = simulateRouteTimes(route.stops, timing, events.noShows, rngFor(ctx.seed, isoDate, "field", route.vehicleId));
    late += result.lateTripIds.length;
    for (const time of result.times) {
      // The status keeps who tapped it, as the roadmap's status route writes it (stopWrite), with its
      // audit event; simulated statuses are sent live (received when tapped).
      const completedAt = parisInstant(isoDate, time.minute, time.second);
      const completedById = stopRecorder(route, ctx.driverAccounts, time.tripId, time.kind);
      writes.push(
        prisma.routeStop.update({ where: { id: time.stopId }, data: { completedAt, completedById, completedReceivedAt: completedAt } }),
      );
      const action = stopAuditAction(time.kind, events.noShows.has(time.tripId));
      audits.push(trail.event({ id: completedById, role: "DRIVER" }, action, time.tripId, completedAt));
      if (time.kind === "DROPOFF") droppedOff.add(time.tripId);
      if (time.kind === "PICKUP" && events.noShows.has(time.tripId)) absentAt.set(time.tripId, completedAt);
    }
  }
  // Returns cancelled after their outbound's absence: traced, and dated, 3 minutes after « Patient absent ».
  for (const id of cancelledAfterNoShow) {
    const back = timing.get(id);
    const outbound = back && trips.find((t) => t.direction === "OUTBOUND" && absentAt.has(t.id) && isSameEpisode(t, back));
    const absent = outbound ? absentAt.get(outbound.id) : undefined;
    const at = absent ? new Date(absent.getTime() + 3 * 60_000) : morning;
    audits.push(trail.event(regulator(ctx), "trip.cancel", id, at));
    if (back) {
      const late = isLateCancellation({ ...back, serviceDate: isoDate }, at, ctx.lateCancellationHours);
      writes.push(prisma.trip.update({ where: { id }, data: { cancelledAt: at, lateCancellation: late } }));
    }
  }
  for (const update of fieldStatusUpdates(droppedOff, events.noShows)) writes.push(prisma.trip.updateMany(update));
  if (audits.length > 0) writes.push(prisma.auditEvent.createMany({ data: audits }));
  await prisma.$transaction(writes);

  const unrecorded = await prisma.trip.count({ where: { serviceDate, status: "ASSIGNED", routeId: { in: [...silentRouteIds] } } });
  // kept: routes left with their stored times (optimizer unavailable or in error), simulated as stored.
  return { noShows: events.noShows.size, late, refreshed: refresh.refreshed, notRefreshed: refresh.kept, unrecorded };
}

// ---------------------------------------------------------------------------

/** Simulates `isoDate` (a past date the caller has cleared of a previous simulation). */
export async function simulateDay(ctx: DayContext, isoDate: string): Promise<DayReport> {
  const { prisma } = ctx;
  const serviceDate = fromIsoDate(isoDate);
  const planning = rngFor(ctx.seed, isoDate, "planning");
  const trail = new DayAuditTrail(isoDate);

  // 1. Trips generated from the recurrences.
  const generatedAt = tripGenerationInstant(isoDate, rngFor(ctx.seed, isoDate, "generation"));
  const trips: (Prisma.TripCreateManyInput & { id: string })[] = planTripsFromRecurrences(ctx.recurrences, isoDate, isoDate).map((trip) => {
    if (!trip.recurrenceId) throw new Error("Course générée sans récurrence");
    return { ...trip, id: historyTripId(isoDate, trip.recurrenceId, trip.direction), createdAt: generatedAt, updatedAt: generatedAt };
  });
  // The one-off care booked for the day (occasional patients), each with its one-off prescription.
  const oneOff = planOneOffDay(ctx.seed, isoDate, ctx.pool, ctx.facilities);
  trips.push(...oneOff.trips.map((trip) => ({ ...trip, createdAt: generatedAt, updatedAt: generatedAt })));
  if (trips.length === 0) return emptyDayReport(isoDate, "aucune course prévue par les récurrences");
  if (oneOff.prescriptions.length > 0) await prisma.prescription.createMany({ data: oneOff.prescriptions });
  await prisma.trip.createMany({ data: trips });

  // Absences and vehicles off the road that start today, known before the planning (staff.ts).
  const staff = planStaffEvents(isoDate, ctx.staff, ctx.vehicleIds);
  if (staff.absences.length > 0) await prisma.staffAbsence.createMany({ data: staff.absences });
  if (staff.unavailabilities.length > 0) await prisma.vehicleUnavailability.createMany({ data: staff.unavailabilities });

  // 2. The day before: cancellations by phone (traced trip.cancel, a minute apart
  // before the first optimization), then the refusals the regulator already knows.
  const cancelledBefore = cancellationsBeforePlanning(trips, isoDate);
  const firstRunAt = firstRunStart(isoDate, planning);
  if (cancelledBefore.size > 0) {
    const cancelled = trips.filter((trip) => cancelledBefore.has(trip.id));
    const instantOf = (index: number) => new Date(firstRunAt.getTime() - (cancelled.length - index) * 60_000);
    await prisma.$transaction([
      ...cancelled.map((trip, index) =>
        prisma.trip.update({
          where: { id: trip.id },
          data: {
            ...CLEARED_PLANNING,
            status: "CANCELLED",
            ...userCancellation({
              reason: patientCancellationReason(isoDate, trip.patientId),
              note: null,
              actorId: ctx.regulatorId,
              now: instantOf(index),
              late: isLateCancellation(
                { ...trip, serviceDate: isoDate, plannedPickupMinute: null, appointmentMinute: trip.appointmentMinute ?? null, readyMinute: trip.readyMinute ?? null },
                instantOf(index),
                ctx.lateCancellationHours,
              ),
            }),
          },
        }),
      ),
      prisma.auditEvent.createMany({
        data: cancelled.map((trip, index) => trail.event(regulator(ctx), "trip.cancel", trip.id, instantOf(index))),
      }),
    ]);
  }
  const refusers = trips.filter((t) => t.sharingAllowed && !cancelledBefore.has(t.id) && isHabitualRefuser(t.patientId));
  const refusalTimes = knownRefusalInstants(firstRunAt, refusers.length, planning);
  const refusalEvents = refusers.map((trip, index) =>
    trail.event(regulator(ctx), "trip.sharing_refuse", trip.id, refusalTimes[index] ?? firstRunAt),
  );
  await prisma.$transaction([
    ...refusers.map((trip, index) =>
      prisma.trip.update({
        where: { id: trip.id },
        data: answerData(UNANSWERED, knownRefusal(trip.patientId), refusalTimes[index] ?? firstRunAt, ctx.regulatorId),
      }),
    ),
    ...(refusalEvents.length > 0 ? [prisma.auditEvent.createMany({ data: refusalEvents })] : []),
  ]);

  // Optimize, call the patients the plan shares, re-optimize after each round with a refusal.
  let startedAt = firstRunAt;
  let lastEventAt = firstRunAt;
  let lastFinishedAt = firstRunAt;
  let runs = 0;
  let locked = 0;
  for (;;) {
    const outcome = await optimizeOnce(ctx, trail, isoDate, runs + 1, startedAt, planning);
    if (!outcome.ok) return giveUpDay(prisma, isoDate, outcome.error);
    runs++;
    lastFinishedAt = outcome.finishedAt;
    lastEventAt = outcome.finishedAt;
    if (runs === 1) locked = await lockPreferredDrivers(ctx, trail, serviceDate, outcome.finishedAt, planning);
    const answers = await answerProposals(ctx, trail, serviceDate, outcome.finishedAt, planning);
    if (answers.lastAt) lastEventAt = answers.lastAt;
    const step = nextPlanningStep(runs, answers.refused);
    if (step === "validate") break;
    if (step === "give-up") {
      return giveUpDay(prisma, isoDate, `partage encore refusé après ${MAX_RUNS_PER_DAY} optimisations`);
    }
    startedAt = rerunStart(lastEventAt, planning);
  }

  // What no plan could place goes to a partner company, then the planning is validated.
  const handOver = await handOverUnplaced(prisma, trail, regulator(ctx), serviceDate, lastEventAt, planning);
  if (handOver.lastAt) lastEventAt = handOver.lastAt;
  const validatedAt = validationInstant(firstRunAt, lastEventAt, planning);
  // Traced only when a route was validated, like « Valider le planning ».
  await prisma.$transaction(
    async (tx) => {
      const { count } = await tx.route.updateMany({
        where: { serviceDate, status: "PROPOSED" },
        data: { status: "VALIDATED", validatedAt },
      });
      if (count > 0) await tx.auditEvent.createMany({ data: [trail.event(regulator(ctx), "plan.validate", null, validatedAt)] });
    },
    { maxWait: 30_000, timeout: 60_000 },
  );

  // 3. The day itself.
  const field = await simulateField(ctx, trail, isoDate);

  // Rows written now carry the real clock: move them to when they would have been written.
  const own = simulatedRowsWhere(serviceDate);
  await prisma.trip.updateMany({ where: own.trips, data: { createdAt: generatedAt, updatedAt: dayClosingInstant(isoDate) } });
  await prisma.route.updateMany({ where: own.routes, data: { createdAt: lastFinishedAt, updatedAt: validatedAt } });

  const [statuses, shared, refused, accepted] = await Promise.all([
    prisma.trip.groupBy({ by: ["status"], where: { serviceDate }, _count: { _all: true } }),
    prisma.trip.count({ where: { serviceDate, status: "DROPPED_OFF", routeId: { not: null }, shared: true } }),
    prisma.trip.count({ where: { serviceDate, sharingStatus: "REFUSED" } }),
    prisma.trip.count({ where: { serviceDate, sharingStatus: "ACCEPTED" } }),
  ]);
  const count = (status: TripStatus) => statuses.find((row) => row.status === status)?._count._all ?? 0;
  return {
    date: isoDate,
    skipped: null,
    trips: trips.length,
    oneOff: oneOff.trips.length,
    realized: count("DROPPED_OFF"),
    // Trips still open once the day is over, besides those of the crews that recorded nothing:
    // 0 unless something above went wrong (shown on the day's line).
    unassigned: count("PLANNED") + count("ASSIGNED") - field.unrecorded,
    unrecorded: field.unrecorded,
    locked,
    absences: staff.absences.length,
    offRoad: staff.unavailabilities.length,
    handedOver: handOver.handedOver,
    cancelled: count("CANCELLED") - handOver.handedOver,
    noShows: count("NO_SHOW"),
    shared,
    refused,
    accepted,
    runs,
    planningMinutes: (validatedAt.getTime() - firstRunAt.getTime()) / 60_000,
    late: field.late,
    refreshed: field.refreshed,
    notRefreshed: field.notRefreshed,
  };
}
