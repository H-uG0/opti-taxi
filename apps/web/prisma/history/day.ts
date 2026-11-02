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
 * instants are set to when things would have happened. A day that cannot be
 * completed (no solution, refusals beyond the cap) is removed, never left
 * half-written. The Prisma client is the script's own: nothing here is
 * server-only.
 */
import type { Prisma, PrismaClient, TripStatus } from "@prisma/client";
import { planTripsFromRecurrences, type RecurrenceForGeneration } from "@/lib/domain/trip-generation";
import { buildOptimizeRequest, loadOptimizeInput } from "@/lib/optimizer/build-request";
import type { PlanResponse } from "@/lib/optimizer/contract";
import { savePlan } from "@/lib/optimizer/persist";
import { removeTripStops } from "@/lib/planning/detach";
import { refreshRoutes } from "@/lib/planning/refresh-routes";
import { fromIsoDate } from "@/lib/time";
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
import { cancellationsBeforePlanning, decideDayEvents, fieldStatusUpdates, simulateRouteTimes } from "./field";
import { rngFor } from "./hash";
import { historyRunId, historyTripId } from "./ids";
import { withTimeLimit, type OptimizerClient } from "./optimizer";
import { foreignRowsWhere, simulatedRowsWhere } from "./ownership";
import { handOverNotes, MAX_RUNS_PER_DAY, nextPlanningStep, unplacedTripIds } from "./planning";
import { emptyDayReport, type DayReport } from "./report";
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
  /** Regulator account credited with the runs. */
  regulatorId: string | null;
};

export type RowCounts = { trips: number; routes: number; runs: number };

// ---------------------------------------------------------------------------
// Ownership: what the simulation created on a date, and what it did not (filters in ownership.ts)

/** Rows of the date the simulation did not create: when there is any, the date is left untouched. */
export async function foreignRows(prisma: PrismaClient, isoDate: string): Promise<RowCounts> {
  const where = foreignRowsWhere(fromIsoDate(isoDate));
  const [trips, routes, runs] = await Promise.all([
    prisma.trip.count({ where: where.trips }),
    prisma.route.count({ where: where.routes }),
    prisma.optimizationRun.count({ where: where.runs }),
  ]);
  return { trips, routes, runs };
}

/** Deletes what a previous simulation created on the date (stops cascade with routes and trips). */
export async function clearSimulatedDay(prisma: PrismaClient, isoDate: string): Promise<RowCounts> {
  const where = simulatedRowsWhere(fromIsoDate(isoDate));
  const [routes, trips, runs] = await prisma.$transaction([
    prisma.route.deleteMany({ where: where.routes }),
    prisma.trip.deleteMany({ where: where.trips }),
    prisma.optimizationRun.deleteMany({ where: where.runs }),
  ]);
  return { trips: trips.count, routes: routes.count, runs: runs.count };
}

/** A day that cannot be completed is removed rather than left half-written, and reported as skipped. */
async function giveUpDay(prisma: PrismaClient, isoDate: string, reason: string): Promise<DayReport> {
  await clearSimulatedDay(prisma, isoDate);
  return emptyDayReport(isoDate, `${reason} (jour retiré)`);
}

// ---------------------------------------------------------------------------
// The day before

type RunOutcome = { ok: true; finishedAt: Date } | { ok: false; error: string };

/** « Optimiser demain », as lib/planning/run-optimization.ts runs it, started at `startedAt`. */
async function optimizeOnce(ctx: DayContext, isoDate: string, round: number, startedAt: Date, rng: Rng): Promise<RunOutcome> {
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

  // Trips the plan newly shares become PROPOSED at `finishedAt`.
  await savePlan(prisma, { runId, isoDate, request, response: plan, now: finishedAt });
  // savePlan stamps the real clock: the run happened the day before.
  await prisma.optimizationRun.update({ where: { id: runId }, data: { startedAt, finishedAt } });
  return { ok: true, finishedAt };
}

/** The regulator calls every patient whose trip is proposed for sharing and records the answer. */
async function answerProposals(
  prisma: PrismaClient,
  serviceDate: Date,
  after: Date,
  rng: Rng,
): Promise<{ refused: number; lastAt: Date | null }> {
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
  let refused = 0;
  const writes = proposed.map((trip, index) => {
    const answer = sharingAnswer(trip);
    if (answer.decision === "REFUSED") refused++;
    // Guarded on the answer read above, like the « Courses » action.
    return prisma.trip.updateMany({
      where: { id: trip.id, sharingStatus: trip.sharingStatus, sharingRespondedAt: trip.sharingRespondedAt },
      data: answerData(trip, answer, instants[index] ?? after),
    });
  });
  await prisma.$transaction(writes);
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
  serviceDate: Date,
  after: Date,
  rng: Rng,
): Promise<{ handedOver: number; lastAt: Date | null }> {
  const trips = await prisma.trip.findMany({
    where: simulatedRowsWhere(serviceDate).trips,
    select: { id: true, status: true, routeId: true, notes: true },
  });
  const ids = unplacedTripIds(trips);
  if (ids.length === 0) return { handedOver: 0, lastAt: null };
  const byId = new Map(trips.map((trip) => [trip.id, trip]));
  const instants = handOverInstants(after, ids.length, rng);
  await prisma.$transaction(
    ids.map((id) => {
      const trip = byId.get(id);
      return prisma.trip.updateMany({
        where: { id, status: trip?.status, routeId: null },
        data: { ...CLEARED_PLANNING, status: "CANCELLED", notes: handOverNotes(trip?.notes ?? null) },
      });
    }),
  );
  return { handedOver: ids.length, lastAt: instants.at(-1) ?? null };
}

// ---------------------------------------------------------------------------
// The day itself

type FieldOutcome = { noShows: number; late: number; refreshed: number; notRefreshed: number };

async function simulateField(ctx: DayContext, isoDate: string): Promise<FieldOutcome> {
  const { prisma } = ctx;
  const serviceDate = fromIsoDate(isoDate);
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
    },
    orderBy: { id: "asc" },
  });
  const events = decideDayEvents(trips, isoDate);

  // « Annuler » in « Courses »: the trip leaves its route; the routes it left are then recomputed.
  const leftRoutes = new Set<string>();
  for (const trip of trips) {
    if (!events.cancellations.has(trip.id)) continue;
    const detached = await prisma.$transaction(async (tx) => {
      const updated = await tx.trip.updateMany({
        where: { id: trip.id, status: trip.status },
        data: { ...CLEARED_PLANNING, status: "CANCELLED" },
      });
      return updated.count === 0 ? null : removeTripStops(tx, trip.id);
    });
    for (const routeId of detached?.routeIds ?? []) leftRoutes.add(routeId);
  }
  const refresh = await refreshRoutes(
    { prisma, evaluate: ctx.optimizer.evaluate, now: parisInstant(isoDate, 7 * 60) },
    leftRoutes,
  );

  // The crews' statuses, route by route.
  const routes = await prisma.route.findMany({
    where: { serviceDate },
    select: {
      vehicleId: true,
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
  const droppedOff = new Set<string>();
  let late = 0;
  for (const route of routes) {
    const result = simulateRouteTimes(route.stops, timing, events.noShows, rngFor(ctx.seed, isoDate, "field", route.vehicleId));
    late += result.lateTripIds.length;
    for (const time of result.times) {
      writes.push(
        prisma.routeStop.update({
          where: { id: time.stopId },
          data: { completedAt: parisInstant(isoDate, time.minute, time.second) },
        }),
      );
      if (time.kind === "DROPOFF") droppedOff.add(time.tripId);
    }
  }
  for (const update of fieldStatusUpdates(droppedOff, events.noShows)) writes.push(prisma.trip.updateMany(update));
  await prisma.$transaction(writes);

  // kept: routes left with their stored times (optimizer unavailable or in error), simulated as stored.
  return { noShows: events.noShows.size, late, refreshed: refresh.refreshed, notRefreshed: refresh.kept };
}

// ---------------------------------------------------------------------------

/** Simulates `isoDate` (a past date the caller has cleared of a previous simulation). */
export async function simulateDay(ctx: DayContext, isoDate: string): Promise<DayReport> {
  const { prisma } = ctx;
  const serviceDate = fromIsoDate(isoDate);
  const planning = rngFor(ctx.seed, isoDate, "planning");

  // 1. Trips generated from the recurrences.
  const generatedAt = tripGenerationInstant(isoDate, rngFor(ctx.seed, isoDate, "generation"));
  const trips = planTripsFromRecurrences(ctx.recurrences, isoDate, isoDate).map((trip) => {
    if (!trip.recurrenceId) throw new Error("Course générée sans récurrence");
    return { ...trip, id: historyTripId(isoDate, trip.recurrenceId, trip.direction), createdAt: generatedAt, updatedAt: generatedAt };
  });
  if (trips.length === 0) return emptyDayReport(isoDate, "aucune course prévue par les récurrences");
  await prisma.trip.createMany({ data: trips });

  // 2. The day before: cancellations by phone, then the refusals the regulator already knows.
  const cancelledBefore = cancellationsBeforePlanning(trips, isoDate);
  if (cancelledBefore.size > 0) {
    await prisma.trip.updateMany({ where: { id: { in: [...cancelledBefore] } }, data: { ...CLEARED_PLANNING, status: "CANCELLED" } });
  }
  const firstRunAt = firstRunStart(isoDate, planning);
  const refusers = trips.filter((t) => t.sharingAllowed && !cancelledBefore.has(t.id) && isHabitualRefuser(t.patientId));
  const refusalTimes = knownRefusalInstants(firstRunAt, refusers.length, planning);
  await prisma.$transaction(
    refusers.map((trip, index) =>
      prisma.trip.update({
        where: { id: trip.id },
        data: answerData(UNANSWERED, knownRefusal(trip.patientId), refusalTimes[index] ?? firstRunAt),
      }),
    ),
  );

  // Optimize, call the patients the plan shares, re-optimize after each round with a refusal.
  let startedAt = firstRunAt;
  let lastEventAt = firstRunAt;
  let lastFinishedAt = firstRunAt;
  let runs = 0;
  for (;;) {
    const outcome = await optimizeOnce(ctx, isoDate, runs + 1, startedAt, planning);
    if (!outcome.ok) return giveUpDay(prisma, isoDate, outcome.error);
    runs++;
    lastFinishedAt = outcome.finishedAt;
    lastEventAt = outcome.finishedAt;
    const answers = await answerProposals(prisma, serviceDate, outcome.finishedAt, planning);
    if (answers.lastAt) lastEventAt = answers.lastAt;
    const step = nextPlanningStep(runs, answers.refused);
    if (step === "validate") break;
    if (step === "give-up") {
      return giveUpDay(prisma, isoDate, `partage encore refusé après ${MAX_RUNS_PER_DAY} optimisations`);
    }
    startedAt = rerunStart(lastEventAt, planning);
  }

  // What no plan could place goes to a partner company, then the planning is validated.
  const handOver = await handOverUnplaced(prisma, serviceDate, lastEventAt, planning);
  if (handOver.lastAt) lastEventAt = handOver.lastAt;
  const validatedAt = validationInstant(firstRunAt, lastEventAt, planning);
  await prisma.route.updateMany({ where: { serviceDate, status: "PROPOSED" }, data: { status: "VALIDATED", validatedAt } });

  // 3. The day itself.
  const field = await simulateField(ctx, isoDate);

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
    realized: count("DROPPED_OFF"),
    // Trips still open once the day is over: 0 unless something above went wrong (shown on the day's line).
    unassigned: count("PLANNED") + count("ASSIGNED"),
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
