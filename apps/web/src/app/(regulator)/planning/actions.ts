"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { loadDayVehicleInputs, personName, resolveVehicleAvailability } from "@/lib/optimizer/build-request";
import { logError } from "@/lib/log";
import { planningErrorMessage } from "@/lib/planning/action-errors";
import { lockPlanningDay } from "@/lib/planning/day-lock";
import { loadPlanningDay } from "@/lib/planning/load";
import { LOCKED, lockAction, notLockedOn } from "@/lib/planning/lock";
import {
  confirmPendingRun,
  discardPendingRun,
  dropPendingRuns,
  OPTIMIZATION_IN_PROGRESS_ERROR,
  optimizationInProgress,
  PLANNING_TX_OPTIONS,
  replanBlocker,
  restorePreviousPlan,
  runOptimization,
  type RunOutcome,
} from "@/lib/planning/run-optimization";
import { validationIssues, validationQuestion } from "@/lib/planning/validation";
import { loadPlanVersion, STALE_PLAN_ERROR } from "@/lib/planning/version";
import { VEHICLE_TYPE_SHORT } from "@/lib/labels";
import { formatLongDate, fromIsoDate, isIsoDate, todayIso, toIsoDate } from "@/lib/time";

export type PlanningActionResult =
  | { ok: true; message: string }
  | {
      ok: false;
      error: string;
      needsConfirmation?: boolean;
      /** The page shows a plan that changed since: offer to reload it. */
      stale?: boolean;
    };

const dateSchema = z.string().refine((value) => isIsoDate(value));
const idSchema = z.string().trim().min(1).max(64);

const INVALID_DATE: PlanningActionResult = { ok: false, error: "Date invalide." };
const STALE_PLAN: PlanningActionResult = { ok: false, error: STALE_PLAN_ERROR, stale: true };
const UNKNOWN_TRIP: PlanningActionResult = { ok: false, error: "Course introuvable (supprimée entre-temps ?)." };

/** Routes, trips and sharing statuses feed several pages (courses, arrivées partagées, chauffeurs…). */
function refreshPages() {
  revalidatePath("/", "layout");
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

/**
 * Runs an action body: an unexpected error (database time-out, lost race)
 * becomes { ok: false } with a message the regulator can act on, instead of a
 * failed request read as « connexion perdue ». Next.js redirects (expired
 * session) go through.
 */
async function guarded(action: string, body: () => Promise<PlanningActionResult>): Promise<PlanningActionResult> {
  try {
    return await body();
  } catch (error) {
    unstable_rethrow(error);
    logError(`[planning] ${action} failed`, error);
    return { ok: false, error: planningErrorMessage(error) };
  }
}

/** The action's answer to a computation's outcome. */
function toResult(outcome: RunOutcome): PlanningActionResult {
  if (outcome.ok) return { ok: true, message: outcome.message };
  return outcome.needsConfirmation ? { ok: false, error: outcome.error, needsConfirmation: true } : { ok: false, error: outcome.error };
}

/** Locks only matter for the next optimization: none on a past date. */
function pastDateError(isoDate: string): PlanningActionResult | null {
  return isoDate < todayIso() ? { ok: false, error: `Le ${formatLongDate(isoDate)} est passé : son planning n'est plus modifiable.` } : null;
}

/** « Optimiser demain » / « Réoptimiser » : recompute every route of the date, keeping locked trips on their vehicle. */
export async function optimizeDay(date: string): Promise<PlanningActionResult> {
  const user = await requireUser("REGULATOR");
  return guarded("optimizeDay", async () => {
    const parsed = dateSchema.safeParse(date);
    if (!parsed.success) return INVALID_DATE;

    const outcome = await runOptimization(parsed.data, user);
    refreshPages();
    return toResult(outcome);
  });
}

/**
 * « Déplacer vers… » : lock the trip on another vehicle, then re-optimize the
 * rest of the day. When the optimizer cannot serve the trip with that vehicle,
 * the new plan is not saved and the previous lock is restored.
 */
export async function moveTrip(tripId: string, vehicleId: string): Promise<PlanningActionResult> {
  const user = await requireUser("REGULATOR");
  return guarded("moveTrip", async () => {
    const ids = z.object({ tripId: idSchema, vehicleId: idSchema }).safeParse({ tripId, vehicleId });
    if (!ids.success) return { ok: false, error: "Course ou véhicule invalide." };

    const trip = await db.trip.findUnique({
      where: { id: ids.data.tripId },
      select: {
        id: true,
        serviceDate: true,
        status: true,
        allowedVehicleTypes: true,
        lockedVehicleId: true,
        patient: { select: { firstName: true, lastName: true } },
      },
    });
    if (!trip) return UNKNOWN_TRIP;
    if (trip.status === "CANCELLED" || trip.status === "NO_SHOW") {
      return { ok: false, error: "Cette course est annulée : elle ne peut pas être déplacée." };
    }
    if (trip.status === "PICKED_UP" || trip.status === "DROPPED_OFF") {
      return { ok: false, error: "Cette course est déjà commencée ou terminée." };
    }

    const isoDate = toIsoDate(trip.serviceDate);
    const blocker = await replanBlocker(isoDate);
    if (blocker) return { ok: false, error: blocker };

    const { available, skipped } = resolveVehicleAvailability(await loadDayVehicleInputs(db, isoDate), isoDate);
    const target = available.find((v) => v.id === ids.data.vehicleId);
    if (!target) {
      const skip = skipped.find((s) => s.vehicleId === ids.data.vehicleId);
      return {
        ok: false,
        error: skip ? `${skip.label} est indisponible ce jour : ${skip.reason}.` : "Véhicule introuvable ou inactif.",
      };
    }
    if (!trip.allowedVehicleTypes.includes(target.type)) {
      const allowed = trip.allowedVehicleTypes.map((t) => VEHICLE_TYPE_SHORT[t]).join(" ou ");
      return {
        ok: false,
        error: `Véhicule non autorisé : la prescription impose ${allowed || "un autre type"}, pas ${VEHICLE_TYPE_SHORT[target.type]}.`,
      };
    }

    if (await optimizationInProgress(isoDate)) return { ok: false, error: OPTIMIZATION_IN_PROGRESS_ERROR };

    const who = personName(trip.patient);
    const traced = { entity: "Trip", entityId: trip.id, serviceDate: isoDate } as const;
    // Already locked on the target: nothing to write or trace, the day is still re-optimized.
    const moved = await db.$transaction(async (tx) => {
      const { count } = await tx.trip.updateMany({
        where: { id: trip.id, ...notLockedOn(target.id) },
        data: { lockedVehicleId: target.id },
      });
      if (count > 0) await audit(tx, user, { action: "trip.move", ...traced });
      return count > 0;
    }, PLANNING_TX_OPTIONS);
    const outcome = await runOptimization(isoDate, user, {
      move: { tripId: trip.id, vehicleId: target.id, vehicleLabel: target.label, patientName: who },
    });
    if (!outcome.ok && (outcome.moveRejected || outcome.needsConfirmation)) {
      // Undo the lock this move set (unless it was changed meanwhile) so the next optimization does not keep the trip unassigned.
      // A plan waiting for confirmation sets it again when confirmed (confirmPendingRun).
      // The undo is a change of its own, traced as the lock or unlock it amounts to.
      if (moved) {
        const previousLock = trip.lockedVehicleId;
        await db.$transaction(async (tx) => {
          const { count } = await tx.trip.updateMany({
            where: { id: trip.id, lockedVehicleId: target.id },
            data: { lockedVehicleId: previousLock },
          });
          if (count > 0) await audit(tx, user, { action: lockAction(previousLock), ...traced });
        }, PLANNING_TX_OPTIONS);
      }
      refreshPages();
      return toResult(outcome);
    }
    refreshPages();
    if (!outcome.ok) {
      return { ok: false, error: `Course de ${who} figée sur ${target.label}, mais le planning n'a pas été recalculé : ${outcome.error}` };
    }
    return { ok: true, message: `Course de ${who} déplacée et figée sur ${target.label}. ${outcome.message}` };
  });
}

/**
 * « Remplacer quand même » : saves the plan computed by run `runId`, which
 * waited because it serves fewer trips, breaks more rules or loses margin
 * compared with the routes in place (lib/planning/plan-compare.ts).
 */
export async function confirmPlan(runId: string): Promise<PlanningActionResult> {
  const user = await requireUser("REGULATOR");
  return guarded("confirmPlan", async () => {
    const id = idSchema.safeParse(runId);
    if (!id.success) return { ok: false, error: "Calcul introuvable : rechargez la page." };
    const outcome = await confirmPendingRun(id.data, user);
    refreshPages();
    return toResult(outcome);
  });
}

/** « Garder le planning actuel » : the plan waiting for confirmation is dropped. */
export async function discardPlan(runId: string): Promise<PlanningActionResult> {
  const user = await requireUser("REGULATOR");
  return guarded("discardPlan", async () => {
    const id = idSchema.safeParse(runId);
    if (!id.success) return { ok: false, error: "Calcul introuvable : rechargez la page." };
    const dropped = await discardPendingRun(id.data, (tx, isoDate) =>
      audit(tx, user, { action: "plan.discard", entity: "OptimizationRun", entityId: id.data, serviceDate: isoDate }),
    );
    refreshPages();
    return dropped
      ? { ok: true, message: "Calcul écarté : le planning en place est conservé." }
      : { ok: false, error: "Ce calcul n'attend plus de confirmation (déjà traité ou remplacé par un autre) : rechargez la page." };
  });
}

/**
 * « Revenir au planning précédent » : the routes replaced by the last
 * computation come back, re-timed with today's data (/evaluate), while the
 * day can still be re-planned. Refused on a stale page.
 */
export async function restorePlan(date: string, shownVersion: string): Promise<PlanningActionResult> {
  const user = await requireUser("REGULATOR");
  return guarded("restorePlan", async () => {
    const parsed = dateSchema.safeParse(date);
    if (!parsed.success) return INVALID_DATE;
    if (typeof shownVersion !== "string" || (await loadPlanVersion(db, parsed.data)) !== shownVersion) return STALE_PLAN;
    const outcome = await restorePreviousPlan(parsed.data, user);
    refreshPages();
    return toResult(outcome);
  });
}

/**
 * « Figer » : keep the trip on the vehicle of its current route at the next
 * optimization. `shownVehicleId` is the vehicle the page shows it on: when the
 * trip is on another one now (re-optimized meanwhile), nothing is locked.
 */
export async function lockTrip(tripId: string, shownVehicleId: string): Promise<PlanningActionResult> {
  const user = await requireUser("REGULATOR");
  return guarded("lockTrip", async () => {
    const id = idSchema.safeParse(tripId);
    if (!id.success) return UNKNOWN_TRIP;
    const shown = idSchema.safeParse(shownVehicleId);
    if (!shown.success) return STALE_PLAN;

    const trip = await db.trip.findUnique({
      where: { id: id.data },
      select: {
        id: true,
        serviceDate: true,
        status: true,
        route: { select: { vehicleId: true, vehicle: { select: { label: true } } } },
      },
    });
    if (!trip) return UNKNOWN_TRIP;
    const past = pastDateError(toIsoDate(trip.serviceDate));
    if (past) return past;
    if (trip.status === "CANCELLED" || trip.status === "NO_SHOW") {
      return { ok: false, error: "Cette course est annulée : rien à figer." };
    }
    if (!trip.route) {
      return { ok: false, error: "Cette course n'est sur aucune tournée : utilisez « Déplacer vers… » pour la placer et la figer." };
    }
    const vehicleId = trip.route.vehicleId;
    if (vehicleId !== shown.data) return STALE_PLAN;
    // Still on that vehicle's route when written (a re-optimization may have moved it since the read).
    // Traced only when the lock changes (not when already locked there, e.g. from a stale panel).
    const locked = await db.$transaction(async (tx) => {
      const { count } = await tx.trip.updateMany({
        where: { id: trip.id, route: { is: { vehicleId } }, ...notLockedOn(vehicleId) },
        data: { lockedVehicleId: vehicleId },
      });
      if (count > 0) {
        await audit(tx, user, { action: "trip.lock", entity: "Trip", entityId: trip.id, serviceDate: toIsoDate(trip.serviceDate) });
        return true;
      }
      const now = await tx.trip.findUnique({ where: { id: trip.id }, select: { lockedVehicleId: true } });
      return now?.lockedVehicleId === vehicleId;
    }, PLANNING_TX_OPTIONS);
    if (!locked) return STALE_PLAN;
    refreshPages();
    return { ok: true, message: `Course figée sur ${trip.route.vehicle.label} : elle y restera à la prochaine optimisation.` };
  });
}

/** « Défiger » : let the optimizer move the trip again. */
export async function unlockTrip(tripId: string): Promise<PlanningActionResult> {
  const user = await requireUser("REGULATOR");
  return guarded("unlockTrip", async () => {
    const id = idSchema.safeParse(tripId);
    if (!id.success) return UNKNOWN_TRIP;

    const trip = await db.trip.findUnique({ where: { id: id.data }, select: { id: true, serviceDate: true } });
    if (!trip) return UNKNOWN_TRIP;
    const past = pastDateError(toIsoDate(trip.serviceDate));
    if (past) return past;
    // Conditional write: two concurrent « Défiger » change the row, and trace it, once.
    await db.$transaction(async (tx) => {
      const { count } = await tx.trip.updateMany({ where: { id: trip.id, ...LOCKED }, data: { lockedVehicleId: null } });
      if (count > 0) {
        await audit(tx, user, { action: "trip.unlock", entity: "Trip", entityId: trip.id, serviceDate: toIsoDate(trip.serviceDate) });
      }
    }, PLANNING_TX_OPTIONS);
    refreshPages();
    return { ok: true, message: "Course défigée : la prochaine optimisation pourra la changer de véhicule." };
  });
}

/**
 * « Valider le planning » : every route of the date becomes VALIDATED. When
 * the plan carries something to fix (route planned before a change of vehicle
 * or crew, overdue inspection or insurance, unassigned trip, violation, return
 * to check, trip to review), the regulator must confirm explicitly
 * (`confirmed`): validationIssues, the same list as the page's « À traiter ».
 */
export async function validateDay(date: string, confirmed: boolean, shownVersion: string): Promise<PlanningActionResult> {
  const user = await requireUser("REGULATOR");
  return guarded("validateDay", async () => {
    const parsed = dateSchema.safeParse(date);
    if (!parsed.success) return INVALID_DATE;
    const isoDate = parsed.data;
    if (isoDate < todayIso()) return { ok: false, error: `Le ${formatLongDate(isoDate)} est passé.` };
    // The running optimization would replace the routes right after their validation.
    if (await optimizationInProgress(isoDate)) return { ok: false, error: OPTIMIZATION_IN_PROGRESS_ERROR };

    // Refused at once on a stale page: never ask to confirm the issues of a plan the regulator did not see.
    if (typeof shownVersion !== "string" || (await loadPlanVersion(db, isoDate)) !== shownVersion) return STALE_PLAN;

    const serviceDate = fromIsoDate(isoDate);
    // The same view as the page: unassigned trips, violations, trips and routes to review.
    const [routes, view] = await Promise.all([db.route.count({ where: { serviceDate } }), loadPlanningDay(isoDate)]);
    if (routes === 0) return { ok: false, error: "Aucune tournée à valider : lancez d'abord l'optimisation." };

    const issues = validationIssues(view);
    if (issues.length > 0 && confirmed !== true) {
      return { ok: false, needsConfirmation: true, error: validationQuestion(issues) };
    }

    // Under the planning lock of the date: no computation can start between the checks and the write,
    // and the plan validated is the one the regulator saw (same version), whose issues were listed above.
    const outcome = await db.$transaction(async (tx) => {
      await lockPlanningDay(tx, isoDate);
      if (await optimizationInProgress(isoDate, tx)) return "running" as const;
      if ((await loadPlanVersion(tx, isoDate)) !== shownVersion) return "stale" as const;
      const { count } = await tx.route.updateMany({
        where: { serviceDate, status: "PROPOSED" },
        data: { status: "VALIDATED", validatedAt: new Date() },
      });
      if (count > 0) await audit(tx, user, { action: "plan.validate", entity: "Route", entityId: null, serviceDate: isoDate });
      // A computation still waiting for confirmation could no longer replace a validated plan.
      await dropPendingRuns(tx, serviceDate, "le planning a été validé.");
      return "validated" as const;
    }, PLANNING_TX_OPTIONS);
    if (outcome === "running") return { ok: false, error: OPTIMIZATION_IN_PROGRESS_ERROR };
    if (outcome === "stale") return STALE_PLAN;
    refreshPages();
    return { ok: true, message: `Planning du ${formatLongDate(isoDate)} validé (${plural(routes, "tournée")}).` };
  });
}

/** « Rouvrir » : back to PROPOSED so the day can be adjusted and re-optimized. */
export async function reopenDay(date: string): Promise<PlanningActionResult> {
  const user = await requireUser("REGULATOR");
  return guarded("reopenDay", async () => {
    const parsed = dateSchema.safeParse(date);
    if (!parsed.success) return INVALID_DATE;
    const isoDate = parsed.data;
    if (isoDate < todayIso()) return { ok: false, error: `Le ${formatLongDate(isoDate)} est passé.` };
    if (await optimizationInProgress(isoDate)) return { ok: false, error: OPTIMIZATION_IN_PROGRESS_ERROR };

    const count = await db.$transaction(async (tx) => {
      const reopened = await tx.route.updateMany({
        where: { serviceDate: fromIsoDate(isoDate), status: "VALIDATED" },
        data: { status: "PROPOSED", validatedAt: null },
      });
      if (reopened.count > 0) await audit(tx, user, { action: "plan.reopen", entity: "Route", entityId: null, serviceDate: isoDate });
      return reopened.count;
    }, PLANNING_TX_OPTIONS);
    if (count === 0) return { ok: false, error: "Aucune tournée validée à rouvrir ce jour." };
    refreshPages();
    return { ok: true, message: `Planning du ${formatLongDate(isoDate)} rouvert : vous pouvez l'ajuster et le réoptimiser.` };
  });
}
