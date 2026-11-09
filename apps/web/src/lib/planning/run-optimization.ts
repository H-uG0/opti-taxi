/**
 * "Optimiser demain" end to end: guards, request, optimizer call, saving.
 * Shared by the planning server actions (callers check auth): optimize,
 * move, restore the previous plan, confirm or discard a pending one.
 *
 * Saving replaces every route of the day, so it never happens silently with
 * a worse or invalid plan (lib/planning/plan-compare.ts): such a plan is kept
 * in its run (AWAITING_CONFIRMATION, details.pending) until the regulator
 * replaces the routes with it (« Remplacer quand même ») or keeps them.
 */
import "server-only";
import type { Prisma } from "@prisma/client";
import { audit } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/domain/settings";
import { logError } from "@/lib/log";
import {
  buildOptimizeRequest,
  isStaleRun,
  loadOptimizeInput,
  type BuildResult,
  type OptimizeInput,
} from "@/lib/optimizer/build-request";
import { evaluate, optimize, type OptimizerResult } from "@/lib/optimizer/client";
import type { OptimizeRequest, PlanResponse } from "@/lib/optimizer/contract";
import {
  FIELD_TRIP_STATUSES,
  PlanBlockedError,
  replanBlockReason,
  savePlan,
  type SavePlanResult,
} from "@/lib/optimizer/persist";
import { readPendingPlan, readRunDetails, runDetailsJson, withoutPending, type RunKind } from "@/lib/optimizer/run-details";
import { formatLongDate, fromIsoDate, todayIso, toIsoDate } from "@/lib/time";
import { tariffGapNote } from "./format";
import { withBeforeCommit } from "./before-commit";
import { lockPlanningDay } from "./day-lock";
import { emptyPlanIssue } from "./empty-plan";
import { notLockedOn } from "./lock";
import { movePlacementIssue, moveRequestIssue, resolveTripRefs, tripRef, type MoveTarget } from "./move";
import {
  comparisonQuestion,
  DEFAULT_REPLACE_THRESHOLDS,
  NOT_KEPT_PREFIX,
  replaceConcerns,
  restorableRoutes,
  type PlanComparison,
} from "./plan-compare";
import { requestHash } from "./version";

export type RunOutcome =
  | { ok: true; message: string; runId: string }
  | {
      ok: false;
      error: string;
      /** The requested move cannot be carried out; the saved planning is unchanged. */
      moveRejected?: boolean;
      /** The plan computed is worse than (or as invalid as) the routes in place: it waits for the regulator's word. */
      needsConfirmation?: boolean;
    };

export type RunOptions = {
  /** « Déplacer vers… » : save the plan only if it serves this trip with this vehicle. */
  move?: MoveTarget;
};

/**
 * Budget of the planning transactions (a change and its audit event): the
 * same as savePlan, whose row locks they may have to wait for.
 */
export const PLANNING_TX_OPTIONS = { maxWait: 15_000, timeout: 60_000 } as const;

export const OPTIMIZATION_IN_PROGRESS_ERROR =
  "Une optimisation de cette date est en cours : attendez la fin du calcul puis rechargez la page.";

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

function seconds(ms: number): string {
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(ms / 1000)} s`;
}

/**
 * RUNNING runs of serviceDate, split into live ones and ones interrupted by
 * a crash or restart. Each run is judged on the solver budget of the trips
 * it sent (see isStaleRun), not on the current settings alone.
 */
async function runningRuns(
  client: Pick<Prisma.TransactionClient, "optimizationRun">,
  serviceDate: Date,
  solverTimeLimitSec: number,
): Promise<{ live: string[]; stale: string[] }> {
  const runs = await client.optimizationRun.findMany({
    where: { serviceDate, status: "RUNNING" },
    select: { id: true, startedAt: true, tripsCount: true },
  });
  const now = new Date();
  const live: string[] = [];
  const stale: string[] = [];
  for (const run of runs) (isStaleRun(run, solverTimeLimitSec, now) ? stale : live).push(run.id);
  return { live, stale };
}

/**
 * Why the routes of isoDate cannot be recomputed right now, or null: past
 * date, validated planning, or a day already started by the drivers (the
 * routes would be deleted with the drivers' pick-up / drop-off timestamps).
 * savePlan checks the same rule again, under row locks, before writing.
 */
export async function replanBlocker(isoDate: string): Promise<string | null> {
  if (isoDate < todayIso()) return `Le ${formatLongDate(isoDate)} est passé : son planning n'est plus modifiable.`;
  const serviceDate = fromIsoDate(isoDate);
  const [validatedRoutes, startedTrips, completedStops] = await Promise.all([
    db.route.count({ where: { serviceDate, status: "VALIDATED" } }),
    db.trip.count({ where: { serviceDate, status: { in: [...FIELD_TRIP_STATUSES] } } }),
    db.routeStop.count({ where: { completedAt: { not: null }, route: { serviceDate } } }),
  ]);
  return replanBlockReason(isoDate, { validatedRoutes, startedTrips, completedStops });
}

/**
 * True while an optimization of isoDate is running (runs interrupted by a
 * crash do not count). Pass the transaction holding the planning lock of the
 * date (lockPlanningDay) to rely on the answer until it commits.
 */
export async function optimizationInProgress(
  isoDate: string,
  client: Pick<Prisma.TransactionClient, "optimizationRun"> = db,
): Promise<boolean> {
  const { solverTimeLimitSec } = await getSettings(db);
  const { live } = await runningRuns(client, fromIsoDate(isoDate), solverTimeLimitSec);
  return live.length > 0;
}

/** Why savePlan's guard kept the routes in place. */
class ReplaceRefused extends Error {
  constructor(
    readonly reason: "confirm" | "move" | "gone" | "stale",
    message: string,
    readonly comparison: PlanComparison | null = null,
    readonly version: string | null = null,
  ) {
    super(message);
    this.name = "ReplaceRefused";
  }
}

const NOT_PENDING_ERROR = "Ce calcul n'attend plus de confirmation (déjà traité ou remplacé par un autre) : rechargez la page.";
const INPUT_CHANGED_ERROR = `${NOT_KEPT_PREFIX} : les données du jour ont changé depuis (course, verrou, équipage, véhicule ou paramètre). Relancez l'optimisation.`;
const PLAN_CHANGED_SINCE_ERROR = `${NOT_KEPT_PREFIX} : le planning en place a changé depuis. Relancez l'optimisation.`;

/** The request of isoDate, or why there is nothing to compute. */
async function prepareRequest(
  isoDate: string,
  adjust: (input: OptimizeInput) => OptimizeInput = (input) => input,
): Promise<{ ok: true; input: OptimizeInput; build: BuildResult } | { ok: false; error: string }> {
  const blocker = await replanBlocker(isoDate);
  if (blocker) return { ok: false, error: blocker };
  const input = adjust(await loadOptimizeInput(db, isoDate));
  const build = buildOptimizeRequest(input);
  const { request } = build;
  if (request.trips.length === 0) {
    const excluded = build.excludedTrips.length;
    return {
      ok: false,
      error:
        excluded > 0
          ? `Aucune course exploitable le ${formatLongDate(isoDate)} : ${plural(excluded, "course incomplète", "courses incomplètes")} (voir la liste).`
          : `Aucune course à planifier le ${formatLongDate(isoDate)}. Générez d'abord les courses de la semaine.`,
    };
  }
  if (request.vehicles.length === 0) {
    return {
      ok: false,
      error: "Aucun véhicule disponible ce jour : vérifiez les chauffeurs attitrés, leurs jours de travail et les équipiers des ambulances.",
    };
  }
  return { ok: true, input, build };
}

/**
 * Creates the RUNNING run of a computation, under the planning lock of the
 * date: two clicks (two regulators, two tabs) never start two computations
 * of the same date. Runs interrupted by a restart are closed, and a plan
 * still waiting for confirmation is dropped (a newer computation follows).
 * Null when a computation of the date is already running.
 */
async function startRun(
  isoDate: string,
  user: Pick<SessionUser, "id">,
  request: OptimizeRequest,
  solverTimeLimitSec: number,
): Promise<string | null> {
  const serviceDate = fromIsoDate(isoDate);
  const run = await db.$transaction(async (tx) => {
    await lockPlanningDay(tx, isoDate);
    const { live, stale } = await runningRuns(tx, serviceDate, solverTimeLimitSec);
    if (stale.length > 0) {
      await tx.optimizationRun.updateMany({
        where: { id: { in: stale }, status: "RUNNING" },
        data: { status: "FAILED", finishedAt: new Date(), error: "Optimisation interrompue (serveur redémarré ou arrêté)." },
      });
    }
    if (live.length > 0) return null;
    await dropPendingRuns(tx, serviceDate, "un nouveau calcul a été lancé.");
    // The account was just re-read by requireUser: it exists, as requestedById and AuditEvent.userId require.
    return tx.optimizationRun.create({
      data: {
        serviceDate,
        status: "RUNNING",
        requestedById: user.id,
        tripsCount: request.trips.length,
        lockedCount: request.trips.filter((t) => t.lockedVehicleId).length,
      },
      select: { id: true },
    });
  }, PLANNING_TX_OPTIONS);
  return run?.id ?? null;
}

/**
 * Plans of serviceDate still waiting for confirmation become FAILED (« Calcul
 * non retenu : <why> »), their stored plan dropped: a newer computation, or a
 * validation, made them pointless. Run in the transaction holding the planning lock.
 */
export async function dropPendingRuns(
  tx: Pick<Prisma.TransactionClient, "optimizationRun">,
  serviceDate: Date,
  why: string,
): Promise<void> {
  const pending = await tx.optimizationRun.findMany({
    where: { serviceDate, status: "AWAITING_CONFIRMATION" },
    select: { id: true, details: true },
  });
  for (const old of pending) {
    await tx.optimizationRun.update({
      where: { id: old.id },
      data: { status: "FAILED", error: `${NOT_KEPT_PREFIX} : ${why}`, details: withoutPending(old.details) },
    });
  }
}

async function failRun(runId: string, error: string, extra: { matrixSource?: string; wallTimeMs?: number } = {}) {
  await db.optimizationRun.update({
    where: { id: runId },
    data: { status: "FAILED", finishedAt: new Date(), error, ...extra },
  });
  return { ok: false as const, error };
}

const AUDIT_ACTION: Record<RunKind, "plan.optimize" | "plan.restore"> = {
  optimize: "plan.optimize",
  move: "plan.optimize",
  restore: "plan.restore",
};

/** "Planning optimisé : 62/64 courses servies · 10 tournées · calcul 10 s · …". */
function successMessage(kind: RunKind, saved: SavePlanResult, plan: PlanResponse, build: BuildResult): string {
  const parts = [`${saved.served}/${saved.served + saved.unassigned} courses servies`, plural(saved.routes, "tournée")];
  if (kind !== "restore") parts.push(`calcul ${seconds(plan.meta.wallTimeMs)}`);
  if (plan.meta.matrixSource === "haversine") parts.push("distances estimées à vol d'oiseau");
  if (plan.meta.trafficSource !== "none") parts.push("trafic pris en compte");
  const tariffNote = tariffGapNote(build.tariffGaps);
  if (tariffNote) parts.push(tariffNote);
  const violations = plan.validation.violations.length;
  if (violations > 0) parts.push(`${plural(violations, "violation")} à vérifier`);
  const what = kind === "restore" ? "Planning précédent rétabli" : "Planning optimisé";
  return `${what} : ${parts.join(" · ")}.`;
}

/**
 * Saves the computed plan of run `runId`, unless it is worse than (or as
 * invalid as) the routes in place: it then waits for the regulator's word
 * (AWAITING_CONFIRMATION). A move that leaves other trips without a vehicle
 * is refused outright.
 */
async function finishRun(args: {
  kind: RunKind;
  isoDate: string;
  user: Pick<SessionUser, "id" | "role">;
  runId: string;
  input: OptimizeInput;
  build: BuildResult;
  plan: PlanResponse;
  move?: MoveTarget;
}): Promise<RunOutcome> {
  const { kind, isoDate, user, runId, build, plan, move } = args;
  const { request } = build;
  const meta = { matrixSource: plan.meta.matrixSource, wallTimeMs: plan.meta.wallTimeMs };
  // Move messages name the trip by its id (stored as is); the regulator reads the patient's name.
  const shown = (text: string) => (move ? resolveTripRefs(text, (id) => (id === move.tripId ? move.patientName : null)) : text);

  if (plan.status === "NO_SOLUTION") {
    return failRun(
      runId,
      `Aucune solution trouvée en ${request.settings.timeLimitSec} s. Augmentez le temps de calcul dans les paramètres ou vérifiez les horaires des chauffeurs et des courses.`,
      meta,
    );
  }
  // Saving replaces every route of the day: never with a plan that serves nothing.
  const emptyIssue = emptyPlanIssue(plan);
  if (emptyIssue) return failRun(runId, emptyIssue, meta);
  if (move) {
    const labels = new Map(request.vehicles.map((v) => [v.id, v.label]));
    const issue = movePlacementIssue(plan, move, labels);
    if (issue) {
      await failRun(runId, issue, meta);
      return { ok: false, error: shown(issue), moveRejected: true };
    }
  }

  const thresholds = args.input.replan ?? DEFAULT_REPLACE_THRESHOLDS;
  let saved: SavePlanResult;
  try {
    // The event commits with the saved plan, or rolls back with it (kept routes, blocked day, database error).
    const traced = withBeforeCommit(db, (tx) =>
      audit(tx, user, { action: AUDIT_ACTION[kind], entity: "OptimizationRun", entityId: runId, serviceDate: isoDate }),
    );
    saved = await savePlan(traced, {
      runId,
      isoDate,
      request,
      response: plan,
      crews: build.crews,
      kind,
      check: ({ comparison, version }) => {
        if (move) {
          const others = comparison.lostTripIds.filter((id) => id !== move.tripId);
          if (others.length > 0) {
            const named = others.slice(0, 3).map(tripRef).join(", ");
            const more = others.length > 3 ? ` et ${others.length - 3} autre${others.length > 4 ? "s" : ""}` : "";
            throw new ReplaceRefused(
              "move",
              `Déplacement refusé : le nouveau calcul laisserait sans véhicule ${plural(others.length, "autre course", "autres courses")} (${named}${more}). Le planning n'a pas été modifié.`,
            );
          }
        }
        const concerns = replaceConcerns(comparison, thresholds);
        if (concerns.length > 0) {
          const question = comparisonQuestion(comparison, concerns, kind === "restore" ? "Le planning précédent" : "Ce calcul");
          const prefix = move ? `Déplacement de ${tripRef(move.tripId)} vers ${move.vehicleLabel} : ` : "";
          throw new ReplaceRefused("confirm", `${prefix}${question}`, comparison, version);
        }
      },
    });
  } catch (error) {
    if (error instanceof ReplaceRefused && error.reason === "move") {
      await failRun(runId, error.message, meta);
      return { ok: false, error: shown(error.message), moveRejected: true };
    }
    if (error instanceof ReplaceRefused && error.comparison && error.version) {
      // Kept in its run until the regulator decides (confirmPendingRun / discardPendingRun).
      await db.optimizationRun.update({
        where: { id: runId },
        data: {
          status: "AWAITING_CONFIRMATION",
          finishedAt: new Date(),
          ...meta,
          unassignedCount: plan.unassigned.length,
          valid: plan.validation.valid,
          kpis: plan.kpis,
          details: runDetailsJson(plan, {
            kind,
            comparison: error.comparison,
            question: error.message,
            pending: {
              response: plan,
              requestHash: requestHash(request),
              basedOnVersion: error.version,
              move: move ? { tripId: move.tripId, vehicleId: move.vehicleId, vehicleLabel: move.vehicleLabel } : null,
            },
          }),
        },
      });
      return { ok: false, needsConfirmation: true, error: shown(error.message) };
    }
    if (error instanceof PlanBlockedError) return failRun(runId, error.message, meta);
    logError("[planning] saving the plan failed", error, { runId, serviceDate: isoDate });
    return failRun(runId, "Le planning calculé n'a pas pu être enregistré (erreur de base de données). Relancez l'optimisation.", meta);
  }
  return { ok: true, runId, message: successMessage(kind, saved, plan, build) };
}

/**
 * Runs the optimization of isoDate for `user` (the signed-in regulator).
 * Every request leaves its OptimizationRun row (requestedById, status, error).
 * The "plan.optimize" audit event is written in savePlan's transaction, with
 * the routes it replaces: it exists exactly when the plan of the day changed.
 * A failed run, or a move the optimizer could not carry out, changes nothing
 * and leaves its FAILED run only; a plan worse than the routes in place
 * leaves its run AWAITING_CONFIRMATION.
 */
export async function runOptimization(
  isoDate: string,
  user: Pick<SessionUser, "id" | "role">,
  options: RunOptions = {},
): Promise<RunOutcome> {
  const prepared = await prepareRequest(isoDate);
  if (!prepared.ok) return { ok: false, error: prepared.error };
  const { input, build } = prepared;
  const { move } = options;
  if (move) {
    const issue = moveRequestIssue(build, move);
    if (issue) return { ok: false, error: resolveTripRefs(issue, (id) => (id === move.tripId ? move.patientName : null)), moveRejected: true };
  }

  const runId = await startRun(isoDate, user, build.request, input.settings.solverTimeLimitSec);
  if (!runId) return { ok: false, error: OPTIMIZATION_IN_PROGRESS_ERROR };
  const result: OptimizerResult<PlanResponse> = await optimize(build.request);
  if (!result.ok) return failRun(runId, result.error);
  return finishRun({ kind: move ? "move" : "optimize", isoDate, user, runId, input, build, plan: result.data, move });
}

/**
 * « Revenir au planning précédent » : the stop sequences the current routes
 * replaced (details.previous of the run that saved them) are re-timed by the
 * optimizer's /evaluate with today's data, then saved like a computation
 * (same comparison with the routes in place). Trips cancelled or vehicles
 * unavailable since are left out. Only while the day can be re-planned.
 */
export async function restorePreviousPlan(isoDate: string, user: Pick<SessionUser, "id" | "role">): Promise<RunOutcome> {
  const planRun = await db.optimizationRun.findFirst({
    where: { serviceDate: fromIsoDate(isoDate), status: "SUCCESS" },
    orderBy: { startedAt: "desc" },
    select: { id: true, details: true, kpis: true },
  });
  const previous = planRun ? readRunDetails(planRun)?.previous : undefined;
  if (!previous || previous.routes.length === 0) return { ok: false, error: "Aucun planning précédent à rétablir pour ce jour." };

  const prepared = await prepareRequest(isoDate);
  if (!prepared.ok) return { ok: false, error: prepared.error };
  const { input, build } = prepared;
  const routes = restorableRoutes(
    previous,
    new Set(build.request.vehicles.map((v) => v.id)),
    new Set(build.request.trips.map((t) => t.id)),
  );
  if (routes.length === 0) {
    return { ok: false, error: "Le planning précédent ne peut plus être rétabli : ses véhicules ou ses courses ne sont plus à planifier ce jour." };
  }

  const runId = await startRun(isoDate, user, build.request, input.settings.solverTimeLimitSec);
  if (!runId) return { ok: false, error: OPTIMIZATION_IN_PROGRESS_ERROR };
  const result = await evaluate({ ...build.request, routes });
  if (!result.ok) return failRun(runId, result.error);
  return finishRun({ kind: "restore", isoDate, user, runId, input, build, plan: result.data });
}

/**
 * « Remplacer quand même » : saves the plan of run `runId`, waiting for
 * confirmation, if the day's data still builds the same request and the
 * routes in place are still those it was compared with. A move sets its lock
 * again, in the same transaction.
 */
export async function confirmPendingRun(runId: string, user: Pick<SessionUser, "id" | "role">): Promise<RunOutcome> {
  const run = await db.optimizationRun.findUnique({
    where: { id: runId },
    select: { id: true, serviceDate: true, status: true, finishedAt: true, details: true, kpis: true },
  });
  if (!run || run.status !== "AWAITING_CONFIRMATION") return { ok: false, error: NOT_PENDING_ERROR };
  const isoDate = toIsoDate(run.serviceDate);
  const pending = readPendingPlan(run.details);
  const kind = readRunDetails(run)?.kind ?? "optimize";
  if (!pending) return dropPendingRun(run.id, run.details, `${NOT_KEPT_PREFIX} : calcul illisible. Relancez l'optimisation.`);

  const { move } = pending;
  // The lock a move set was put back while the plan waited: the request is rebuilt with it.
  const lockMove = (input: OptimizeInput): OptimizeInput =>
    move ? { ...input, trips: input.trips.map((t) => (t.id === move.tripId ? { ...t, lockedVehicleId: move.vehicleId } : t)) } : input;
  const prepared = await prepareRequest(isoDate, lockMove);
  if (!prepared.ok) return dropPendingRun(run.id, run.details, `${NOT_KEPT_PREFIX} : ${prepared.error}`);
  const { build } = prepared;
  if (requestHash(build.request) !== pending.requestHash) return dropPendingRun(run.id, run.details, INPUT_CHANGED_ERROR);

  let saved: SavePlanResult;
  try {
    const traced = withBeforeCommit(db, async (tx) => {
      await audit(tx, user, {
        action: AUDIT_ACTION[kind],
        entity: "OptimizationRun",
        entityId: run.id,
        serviceDate: isoDate,
        details: { confirmed: true },
      });
      if (move) {
        const { count } = await tx.trip.updateMany({
          where: { id: move.tripId, ...notLockedOn(move.vehicleId) },
          data: { lockedVehicleId: move.vehicleId },
        });
        if (count > 0) await audit(tx, user, { action: "trip.move", entity: "Trip", entityId: move.tripId, serviceDate: isoDate });
      }
    });
    saved = await savePlan(traced, {
      runId: run.id,
      isoDate,
      request: build.request,
      response: pending.response,
      crews: build.crews,
      kind,
      // The computation ended when it was put on hold, not when the regulator confirmed it.
      finishedAt: run.finishedAt ?? undefined,
      check: async ({ tx, version }) => {
        const still = await tx.optimizationRun.findUnique({ where: { id: run.id }, select: { status: true } });
        if (still?.status !== "AWAITING_CONFIRMATION") throw new ReplaceRefused("gone", NOT_PENDING_ERROR);
        if (version !== pending.basedOnVersion) throw new ReplaceRefused("stale", PLAN_CHANGED_SINCE_ERROR);
      },
    });
  } catch (error) {
    if (error instanceof ReplaceRefused && error.reason === "gone") return { ok: false, error: error.message };
    if (error instanceof ReplaceRefused) return dropPendingRun(run.id, run.details, error.message);
    if (error instanceof PlanBlockedError) return dropPendingRun(run.id, run.details, `${NOT_KEPT_PREFIX} : ${error.message}`);
    logError("[planning] saving a confirmed plan failed", error, { runId: run.id, serviceDate: isoDate });
    return { ok: false, error: "Le planning n'a pas pu être enregistré (erreur de base de données). Réessayez." };
  }
  const what = kind === "restore" ? "Planning précédent rétabli" : "Nouveau planning enregistré";
  return { ok: true, runId: run.id, message: `${what} : ${saved.served}/${saved.served + saved.unassigned} courses servies · ${plural(saved.routes, "tournée")}.` };
}

/** Closes a pending run that can no longer be saved (FAILED, its plan dropped), with why. */
async function dropPendingRun(runId: string, details: Prisma.JsonValue | null, error: string): Promise<RunOutcome> {
  await db.optimizationRun.updateMany({
    where: { id: runId, status: "AWAITING_CONFIRMATION" },
    data: { status: "FAILED", error, details: withoutPending(details) },
  });
  return { ok: false, error };
}

/**
 * « Garder le planning actuel » : the pending plan of run `runId` is dropped
 * (FAILED), the routes in place stay. Returns false when it no longer waits.
 * The caller traces it (plan.discard) in `tx`.
 */
export async function discardPendingRun(
  runId: string,
  trace: (tx: Prisma.TransactionClient, isoDate: string) => Promise<void>,
): Promise<boolean> {
  const run = await db.optimizationRun.findUnique({ where: { id: runId }, select: { status: true, details: true, serviceDate: true } });
  if (!run || run.status !== "AWAITING_CONFIRMATION") return false;
  return db.$transaction(async (tx) => {
    const { count } = await tx.optimizationRun.updateMany({
      where: { id: runId, status: "AWAITING_CONFIRMATION" },
      data: { status: "FAILED", error: `${NOT_KEPT_PREFIX} : le planning en place a été conservé.`, details: withoutPending(run.details) },
    });
    if (count > 0) await trace(tx, toIsoDate(run.serviceDate));
    return count > 0;
  }, PLANNING_TX_OPTIONS);
}
