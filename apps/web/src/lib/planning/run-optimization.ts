/**
 * "Optimiser demain" end to end: guards, request, optimizer call, saving.
 * Shared by the optimizeDay and moveTrip server actions (callers check auth).
 */
import "server-only";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/domain/settings";
import { buildOptimizeRequest, loadOptimizeInput } from "@/lib/optimizer/build-request";
import { optimize } from "@/lib/optimizer/client";
import {
  FIELD_TRIP_STATUSES,
  PlanBlockedError,
  replanBlockReason,
  savePlan,
  type SavePlanResult,
} from "@/lib/optimizer/persist";
import { formatLongDate, fromIsoDate, todayIso } from "@/lib/time";
import { movePlacementIssue, moveRequestIssue, type MoveTarget } from "./move";

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

/** A RUNNING run older than its time limit plus this margin is considered interrupted (server restart, crash). */
const STALE_RUN_MARGIN_SEC = 120;

export const OPTIMIZATION_IN_PROGRESS_ERROR =
  "Une optimisation de cette date est en cours : attendez la fin du calcul (quelques secondes) puis rechargez la page.";

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

function seconds(ms: number): string {
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(ms / 1000)} s`;
}

function staleBefore(timeLimitSec: number): Date {
  return new Date(Date.now() - (timeLimitSec + STALE_RUN_MARGIN_SEC) * 1000);
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
  const running = await db.optimizationRun.count({
    where: { serviceDate: fromIsoDate(isoDate), status: "RUNNING", startedAt: { gte: staleBefore(solverTimeLimitSec) } },
  });
  return running > 0;
}

export async function runOptimization(isoDate: string, userId: string, options: RunOptions = {}): Promise<RunOutcome> {
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
  if (options.move) {
    const issue = moveRequestIssue(build, options.move);
    if (issue) return { ok: false, error: issue, moveRejected: true };
  }

  const serviceDate = fromIsoDate(isoDate);
  const timeLimitSec = request.settings.timeLimitSec;
  await db.optimizationRun.updateMany({
    where: { serviceDate, status: "RUNNING", startedAt: { lt: staleBefore(timeLimitSec) } },
    data: { status: "FAILED", finishedAt: new Date(), error: "Optimisation interrompue (serveur redémarré ou arrêté)." },
  });
  const running = await db.optimizationRun.count({ where: { serviceDate, status: "RUNNING" } });
  if (running > 0) return { ok: false, error: OPTIMIZATION_IN_PROGRESS_ERROR };

  const requester = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
  const run = await db.optimizationRun.create({
    data: {
      serviceDate,
      status: "RUNNING",
      requestedById: requester?.id ?? null,
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
  if (options.move) {
    const labels = new Map(request.vehicles.map((v) => [v.id, v.label]));
    const issue = movePlacementIssue(plan, options.move, labels);
    if (issue) return { ...(await fail(issue, meta)), moveRejected: true };
  }

  let saved: SavePlanResult;
  try {
    saved = await savePlan(db, { runId: run.id, isoDate, request, response: plan });
  } catch (error) {
    if (error instanceof PlanBlockedError) return fail(error.message, meta);
    console.error("[planning] saving the plan failed", error);
    return fail("Le planning calculé n'a pas pu être enregistré (erreur de base de données). Relancez l'optimisation.", meta);
  }

  const parts = [
    `${saved.served}/${saved.served + saved.unassigned} courses servies`,
    plural(saved.routes, "tournée"),
    `calcul ${seconds(plan.meta.wallTimeMs)}`,
  ];
  if (plan.meta.matrixSource === "haversine") parts.push("distances estimées à vol d'oiseau");
  const violations = plan.validation.violations.length;
  if (violations > 0) parts.push(`${plural(violations, "violation")} à vérifier`);
  return { ok: true, runId: run.id, message: `Planning optimisé : ${parts.join(" · ")}.` };
}
