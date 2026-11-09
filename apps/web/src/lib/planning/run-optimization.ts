/**
 * "Optimiser demain" end to end: guards, request, optimizer call, saving.
 * Shared by the optimizeDay and moveTrip server actions (callers check auth).
 */
import "server-only";
import { audit } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/domain/settings";
import { logError } from "@/lib/log";
import { buildOptimizeRequest, isStaleRun, loadOptimizeInput } from "@/lib/optimizer/build-request";
import { optimize } from "@/lib/optimizer/client";
import {
  FIELD_TRIP_STATUSES,
  PlanBlockedError,
  replanBlockReason,
  savePlan,
  type SavePlanResult,
} from "@/lib/optimizer/persist";
import { formatLongDate, fromIsoDate, todayIso } from "@/lib/time";
import { tariffGapNote } from "./format";
import { withBeforeCommit } from "./before-commit";
import { emptyPlanIssue } from "./empty-plan";
import { movePlacementIssue, moveRequestIssue, resolveTripRefs, type MoveTarget } from "./move";

export type RunOutcome =
  | { ok: true; message: string; runId: string }
  | {
      ok: false;
      error: string;
      /** The requested move cannot be carried out; the saved planning is unchanged. */
      moveRejected?: boolean;
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
async function runningRuns(serviceDate: Date, solverTimeLimitSec: number): Promise<{ live: string[]; stale: string[] }> {
  const runs = await db.optimizationRun.findMany({
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

/** True while an optimization of isoDate is running (runs interrupted by a crash do not count). */
export async function optimizationInProgress(isoDate: string): Promise<boolean> {
  const { solverTimeLimitSec } = await getSettings(db);
  const { live } = await runningRuns(fromIsoDate(isoDate), solverTimeLimitSec);
  return live.length > 0;
}

/**
 * Runs the optimization of isoDate for `user` (the signed-in regulator).
 * Every request leaves its OptimizationRun row (requestedById, status, error).
 * The "plan.optimize" audit event is written in savePlan's transaction, with
 * the routes it replaces: it exists exactly when the plan of the day changed.
 * A failed run, or a move the optimizer could not carry out, changes nothing
 * and leaves its FAILED run only.
 */
export async function runOptimization(
  isoDate: string,
  user: Pick<SessionUser, "id" | "role">,
  options: RunOptions = {},
): Promise<RunOutcome> {
  const blocker = await replanBlocker(isoDate);
  if (blocker) return { ok: false, error: blocker };

  const input = await loadOptimizeInput(db, isoDate);
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
  // Move messages name the trip by its id (stored as is); the regulator reads the patient's name.
  const { move } = options;
  const shown = (text: string) =>
    move ? resolveTripRefs(text, (id) => (id === move.tripId ? move.patientName : null)) : text;
  if (options.move) {
    const issue = moveRequestIssue(build, options.move);
    if (issue) return { ok: false, error: shown(issue), moveRejected: true };
  }

  const serviceDate = fromIsoDate(isoDate);
  // Budget scaled with the trips sent (effectiveTimeLimitSec), not the bare setting.
  const timeLimitSec = request.settings.timeLimitSec;
  const { live, stale } = await runningRuns(serviceDate, input.settings.solverTimeLimitSec);
  if (stale.length > 0) {
    await db.optimizationRun.updateMany({
      where: { id: { in: stale }, status: "RUNNING" },
      data: { status: "FAILED", finishedAt: new Date(), error: "Optimisation interrompue (serveur redémarré ou arrêté)." },
    });
  }
  if (live.length > 0) return { ok: false, error: OPTIMIZATION_IN_PROGRESS_ERROR };

  // The account was just re-read by requireUser: it exists, as requestedById and AuditEvent.userId require.
  const run = await db.optimizationRun.create({
    data: {
      serviceDate,
      status: "RUNNING",
      requestedById: user.id,
      tripsCount: request.trips.length,
      lockedCount: request.trips.filter((t) => t.lockedVehicleId).length,
    },
    select: { id: true },
  });

  const fail = async (error: string, extra: { matrixSource?: string; wallTimeMs?: number } = {}) => {
    await db.optimizationRun.update({
      where: { id: run.id },
      data: { status: "FAILED", finishedAt: new Date(), error, ...extra },
    });
    return { ok: false as const, error };
  };

  const result = await optimize(request);
  if (!result.ok) return fail(result.error);
  const plan = result.data;
  const meta = { matrixSource: plan.meta.matrixSource, wallTimeMs: plan.meta.wallTimeMs };
  if (plan.status === "NO_SOLUTION") {
    return fail(
      `Aucune solution trouvée en ${timeLimitSec} s. Augmentez le temps de calcul dans les paramètres ou vérifiez les horaires des chauffeurs et des courses.`,
      meta,
    );
  }
  // Saving replaces every route of the day: never with a plan that serves nothing.
  const emptyIssue = emptyPlanIssue(plan);
  if (emptyIssue) return fail(emptyIssue, meta);
  if (options.move) {
    const labels = new Map(request.vehicles.map((v) => [v.id, v.label]));
    const issue = movePlacementIssue(plan, options.move, labels);
    if (issue) {
      await fail(issue, meta);
      return { ok: false, error: shown(issue), moveRejected: true };
    }
  }

  let saved: SavePlanResult;
  try {
    // The event commits with the saved plan, or rolls back with it (blocked day, database error).
    const traced = withBeforeCommit(db, (tx) =>
      audit(tx, user, { action: "plan.optimize", entity: "OptimizationRun", entityId: run.id, serviceDate: isoDate }),
    );
    saved = await savePlan(traced, { runId: run.id, isoDate, request, response: plan, crews: build.crews });
  } catch (error) {
    if (error instanceof PlanBlockedError) return fail(error.message, meta);
    logError("[planning] saving the plan failed", error, { runId: run.id, serviceDate: isoDate });
    return fail("Le planning calculé n'a pas pu être enregistré (erreur de base de données). Relancez l'optimisation.", meta);
  }

  const parts = [
    `${saved.served}/${saved.served + saved.unassigned} courses servies`,
    plural(saved.routes, "tournée"),
    `calcul ${seconds(plan.meta.wallTimeMs)}`,
  ];
  if (plan.meta.matrixSource === "haversine") parts.push("distances estimées à vol d'oiseau");
  if (plan.meta.trafficSource !== "none") parts.push("trafic pris en compte");
  const tariffNote = tariffGapNote(build.tariffGaps);
  if (tariffNote) parts.push(tariffNote);
  const violations = plan.validation.violations.length;
  if (violations > 0) parts.push(`${plural(violations, "violation")} à vérifier`);
  return { ok: true, runId: run.id, message: `Planning optimisé : ${parts.join(" · ")}.` };
}
