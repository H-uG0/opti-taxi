"use server";

import type { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { audit, type AuditEntry } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  loadCrewRules,
  loadDayVehicleInputs,
  loadExceptionalAmbulanceGrid,
  personName,
  resolveVehicleAvailability,
} from "@/lib/optimizer/build-request";
import { logError } from "@/lib/log";
import { DATABASE_ERROR, PLAN_CHANGED_ERROR, planningErrorMessage, UNEXPECTED_ERROR } from "@/lib/planning/action-errors";
import { lockMessage, tripsToLock, tripsToUnlock, unlockMessage, type LockScope, type ScopeTrip } from "@/lib/planning/bulk-lock";
import { lockPlanningDay } from "@/lib/planning/day-lock";
import { loadPlanningDay } from "@/lib/planning/load";
import { applyTripPlace, findTripPlaces, type FindPlacesOutcome } from "@/lib/planning/place-trip";
import { DRAFT_MAX_MOVES } from "@/lib/planning/draft";
import { checkDraftPlan, saveDraftPlan, type CheckDraftOutcome } from "@/lib/planning/draft-plan";
import { LOCKED, lockAction, notLockedOn } from "@/lib/planning/lock";
import {
  confirmPendingRun,
  discardPendingRun,
  dropPendingRuns,
  NOT_PENDING_ERROR,
  OPTIMIZATION_IN_PROGRESS_ERROR,
  optimizationInProgress,
  PLANNING_TX_OPTIONS,
  previewPendingSelection,
  replanBlocker,
  restorePreviousPlan,
  runOptimization,
  unassignedByLastPlan,
  withdrawLapsedProposals,
  type PreviewOutcome,
  type RunOutcome,
} from "@/lib/planning/run-optimization";
import { EXCEPTIONAL_AMBULANCE_REASON, exceptionalAmbulanceIssue } from "@/lib/planning/exceptional-ambulance";
import { validationIssues, validationQuestion } from "@/lib/planning/validation";
import { checkRouteCrewChange, remainingPart } from "@/lib/staff/route-crew";
import { loadPlanVersion, STALE_PLAN_ERROR } from "@/lib/planning/version";
import { VEHICLE_TYPE_SHORT } from "@/lib/labels";
import { formatLongDate, fromIsoDate, isIsoDate, todayIso, toIsoDate } from "@/lib/time";

export type PlanningActionResult =
  | {
      ok: true;
      message: string;
      /** Done, but something is left to look at (violations, trips not placed, locks kept): the toast stays, in amber. */
      warning?: boolean;
    }
  | {
      ok: false;
      error: string;
      needsConfirmation?: boolean;
      /** The page shows a plan that changed since: offer to reload it. */
      stale?: boolean;
      /**
       * Problems the form shows next to its fields (« Changer l'équipage »:
       * "driver", "crewMate", "form"); the banner then stays quiet.
       */
      fieldErrors?: Partial<Record<string, string>>;
      /** The draft no longer holds as it is (a move refused, the plan changed): check it again on the plan of the moment. */
      recheck?: boolean;
    };

const dateSchema = z.string().refine((value) => isIsoDate(value));
const idSchema = z.string().trim().min(1).max(64);

const INVALID_DATE: PlanningActionResult = { ok: false, error: "Date invalide." };
const STALE_PLAN: PlanningActionResult = { ok: false, error: STALE_PLAN_ERROR, stale: true };
const UNKNOWN_TRIP: PlanningActionResult = { ok: false, error: "Course introuvable (supprimée entre-temps\u202f?)." };

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
    const message = planningErrorMessage(error);
    // Both ask to reload the page: the banner offers « Recharger ».
    const reload = message === PLAN_CHANGED_ERROR || message === UNEXPECTED_ERROR;
    return reload ? { ok: false, error: message, stale: true } : { ok: false, error: message };
  }
}

/** The action's answer to a computation's outcome. */
function toResult(outcome: RunOutcome): PlanningActionResult {
  if (outcome.ok) return { ok: true, message: outcome.message, ...(outcome.warning ? { warning: true } : {}) };
  if (outcome.needsConfirmation) return { ok: false, error: outcome.error, needsConfirmation: true };
  return outcome.stale ? { ok: false, error: outcome.error, stale: true } : { ok: false, error: outcome.error };
}

/** Locks only matter for the next optimization: none on a past date. */
function pastDateError(isoDate: string): PlanningActionResult | null {
  return isoDate < todayIso() ? { ok: false, error: `Le ${formatLongDate(isoDate)} est passé\u00a0: son planning n'est plus modifiable.` } : null;
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
 * « Placer les non affectées » : a computation where every trip already in a
 * route is sent locked on its vehicle for that computation only (nothing is
 * written on the trips), so that only the trips without a vehicle are placed
 * and no other trip changes vehicle. Saved like any computation (comparison
 * with the routes in place, audit event plan.optimize with details.mode).
 */
export async function placeUnassigned(date: string): Promise<PlanningActionResult> {
  const user = await requireUser("REGULATOR");
  return guarded("placeUnassigned", async () => {
    const parsed = dateSchema.safeParse(date);
    if (!parsed.success) return INVALID_DATE;

    const outcome = await runOptimization(parsed.data, user, { placeOnly: true });
    refreshPages();
    return toResult(outcome);
  });
}

/**
 * « Déplacer vers… » : lock the trip on another vehicle, then re-optimize the
 * rest of the day. When the optimizer cannot serve the trip with that vehicle,
 * or the new plan waits for confirmation, the new plan is not saved and the
 * previous lock is restored (runOptimization; a confirmed plan sets it again).
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
        direction: true,
        patient: { select: { firstName: true, lastName: true } },
      },
    });
    if (!trip) return UNKNOWN_TRIP;
    if (trip.status === "CANCELLED" || trip.status === "NO_SHOW") {
      return { ok: false, error: "Cette course est annulée\u00a0: elle ne peut pas être déplacée." };
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
        error: skip ? `${skip.label} est indisponible ce jour\u00a0: ${skip.reason}.` : "Véhicule introuvable ou désactivé.",
      };
    }
    if (!trip.allowedVehicleTypes.includes(target.type)) {
      const allowed = trip.allowedVehicleTypes.map((t) => VEHICLE_TYPE_SHORT[t]).join(" ou ");
      return {
        ok: false,
        error: `Véhicule non autorisé\u00a0: la prescription impose ${allowed || "un autre type"}, pas ${VEHICLE_TYPE_SHORT[target.type]}.`,
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
    const lockedThere = `Course de ${who} figée sur ${target.label}, mais le planning n'a pas été recalculé`;
    let outcome: RunOutcome;
    try {
      // A refused move, or one whose plan waits for confirmation, puts the previous lock back
      // (traced as the lock or unlock it amounts to).
      outcome = await runOptimization(isoDate, user, {
        move: {
          tripId: trip.id,
          vehicleId: target.id,
          vehicleLabel: target.label,
          patientName: who,
          direction: trip.direction,
          ...(moved ? { previousLock: trip.lockedVehicleId } : {}),
        },
      });
    } catch (error) {
      // The lock is committed already (and maybe undone since): never answer that nothing was saved.
      if (!moved) throw error;
      logError("[planning] moveTrip failed after the lock", error);
      refreshPages();
      const why =
        planningErrorMessage(error) === DATABASE_ERROR ? "la base de données n'a pas répondu à temps" : "erreur inattendue";
      return {
        ok: false,
        error:
          `Déplacement de la course de ${who} vers ${target.label} interrompu (${why})\u00a0: elle est peut-être restée figée ` +
          `sur ${target.label}. Rechargez la page pour voir l'état réel du planning.`,
        stale: true,
      };
    }
    refreshPages();
    if (!outcome.ok && (outcome.moveRejected || outcome.needsConfirmation)) return toResult(outcome);
    if (!outcome.ok) return { ok: false, error: `${lockedThere}\u00a0: ${outcome.error}` };
    return {
      ok: true,
      message: `Course de ${who} déplacée et figée sur ${target.label}. ${outcome.message}`,
      ...(outcome.warning ? { warning: true } : {}),
    };
  });
}

/**
 * « Où placer cette course ? » (INS-01): the best place of the trip in each vehicle's route in
 * place, from the optimizer's POST /insert, nothing written. Read only: the panel shows trips the
 * page already traced (plan.view); the answer names vehicles and trips by id.
 */
export async function findPlaces(tripId: string): Promise<FindPlacesOutcome> {
  await requireUser("REGULATOR");
  const id = idSchema.safeParse(tripId);
  if (!id.success) return { ok: false, error: "Course introuvable (supprimée entre-temps\u202f?).", stale: true };
  try {
    return await findTripPlaces(id.data);
  } catch (error) {
    unstable_rethrow(error);
    logError("[planning] findPlaces failed", error);
    return { ok: false, error: planningErrorMessage(error) };
  }
}

/**
 * « Appliquer » a place of « Où placer cette course ? »: only the target route and, for a move,
 * the source route are rewritten, the trip locked on its new vehicle, traced (trip.move,
 * details.mode "insert"); the rest of the day does not move. `version`: the plan version the
 * places were computed on; `confirmed`: the question answered on a validated or started day.
 */
export async function placeTrip(
  tripId: string,
  vehicleId: string,
  version: string,
  confirmed: string | null,
): Promise<PlanningActionResult> {
  const user = await requireUser("REGULATOR");
  return guarded("placeTrip", async () => {
    const args = z
      .object({ tripId: idSchema, vehicleId: idSchema, version: z.string().min(1).max(64), confirmed: z.string().max(2000).nullable() })
      .safeParse({ tripId, vehicleId, version, confirmed });
    if (!args.success) return { ok: false, error: "Place invalide\u00a0: relancez «\u202fOù placer cette course\u202f?\u202f»." };
    const outcome = await applyTripPlace(args.data.tripId, args.data.vehicleId, args.data.version, args.data.confirmed, user);
    if (outcome.ok) refreshPages();
    return outcome;
  });
}

const draftMovesSchema = z
  .array(z.object({ tripId: idSchema, toVehicleId: idSchema.nullable() }))
  .min(1)
  .max(DRAFT_MAX_MOVES);

/**
 * The drag-and-drop draft of the timeline (INS-03), « Vérifier »: the moves replayed on the plan of
 * the moment by the optimizer (/insert for each trip dropped on a vehicle, /evaluate of the day),
 * nothing written. Read only: it names trips and vehicles by id, the page already traced plan.view.
 */
export async function checkDraft(date: string, moves: { tripId: string; toVehicleId: string | null }[]): Promise<CheckDraftOutcome> {
  await requireUser("REGULATOR");
  const args = z.object({ date: dateSchema, moves: draftMovesSchema }).safeParse({ date, moves });
  if (!args.success) return { ok: false, error: "Brouillon invalide\u00a0: annulez-le et recommencez." };
  try {
    return await checkDraftPlan(args.data.date, args.data.moves);
  } catch (error) {
    unstable_rethrow(error);
    logError("[planning] checkDraft failed", error);
    return { ok: false, error: planningErrorMessage(error) };
  }
}

/**
 * « Enregistrer » the draft: only the routes it changes are written (the stops that stay keep their
 * ids), each moved trip locked on its new vehicle (unlocked when put in « À placer »), one trip.move
 * event per trip (details.mode « draft »). `version`: the plan version the draft was shown on;
 * `confirmed`: the question answered on a validated or started day.
 */
export async function saveDraft(
  date: string,
  version: string,
  moves: { tripId: string; toVehicleId: string | null }[],
  confirmed: string | null,
): Promise<PlanningActionResult> {
  const user = await requireUser("REGULATOR");
  return guarded("saveDraft", async () => {
    const args = z
      .object({ date: dateSchema, version: z.string().min(1).max(64), moves: draftMovesSchema, confirmed: z.string().max(2000).nullable() })
      .safeParse({ date, version, moves, confirmed });
    if (!args.success) return { ok: false, error: "Brouillon invalide\u00a0: annulez-le et recommencez." };
    const outcome = await saveDraftPlan(args.data.date, args.data.version, args.data.moves, args.data.confirmed, user);
    if (outcome.ok) refreshPages();
    return outcome;
  });
}

/**
 * « Recours exceptionnel à une ambulance » (TAR-03, protocol of 24 September
 * 2025): a seated (TAP) trip the last optimization left without a vehicle goes
 * to an ambulance of the day, billed at the VSL tariff, the measure traced on
 * the trip. Never automatic: the regulator picks the trip and the ambulance;
 * the trip is locked on it, then the day is re-optimized as for « Déplacer
 * vers… ». The measure stays only with a plan that serves the trip there,
 * saved or waiting for confirmation: on any other outcome (refused by the
 * optimizer, optimizer unreachable, computation already running…), the lock
 * and the proposal are both withdrawn and the regulator is told so.
 */
export async function proposeExceptionalAmbulance(tripId: string, vehicleId: string): Promise<PlanningActionResult> {
  const user = await requireUser("REGULATOR");
  return guarded("proposeExceptionalAmbulance", async () => {
    const ids = z.object({ tripId: idSchema, vehicleId: idSchema }).safeParse({ tripId, vehicleId });
    if (!ids.success) return { ok: false, error: "Course ou véhicule invalide." };

    const trip = await db.trip.findUnique({
      where: { id: ids.data.tripId },
      select: {
        id: true,
        serviceDate: true,
        status: true,
        payer: true,
        allowedVehicleTypes: true,
        lockedVehicleId: true,
        routeId: true,
        direction: true,
        exceptionalAmbulanceAt: true,
        exceptionalAmbulanceById: true,
        patient: { select: { firstName: true, lastName: true } },
      },
    });
    if (!trip) return UNKNOWN_TRIP;
    const isoDate = toIsoDate(trip.serviceDate);
    const past = pastDateError(isoDate);
    if (past) return past;
    // A last resort: only for a trip the last computation could not give to any taxi or VSL.
    const leftByOptimizer = (await unassignedByLastPlan(isoDate)).has(trip.id);
    const issue = exceptionalAmbulanceIssue({ ...trip, assigned: trip.routeId !== null, leftByOptimizer });
    if (issue) return { ok: false, error: issue };

    const blocker = await replanBlocker(isoDate);
    if (blocker) return { ok: false, error: blocker };
    const { available, skipped } = resolveVehicleAvailability(await loadDayVehicleInputs(db, isoDate), isoDate);
    const target = available.find((v) => v.id === ids.data.vehicleId);
    if (!target || target.type !== "AMBULANCE") {
      const skip = skipped.find((s) => s.vehicleId === ids.data.vehicleId);
      return { ok: false, error: skip ? `${skip.label} est indisponible ce jour\u00a0: ${skip.reason}.` : "Ambulance introuvable ou indisponible ce jour." };
    }
    // Billed at the VSL tariff: without a VSL grid that day, the optimizer would estimate it at the ambulance's.
    if (!(await loadExceptionalAmbulanceGrid(db, isoDate, target))) {
      return {
        ok: false,
        error: `Aucune grille VSL en vigueur le ${formatLongDate(isoDate)} pour facturer ce recours au tarif VSL\u00a0: créez-la dans Grilles tarifaires, puis recommencez.`,
      };
    }
    if (await optimizationInProgress(isoDate)) return { ok: false, error: OPTIMIZATION_IN_PROGRESS_ERROR };

    const who = personName(trip.patient);
    const traced = { entity: "Trip", entityId: trip.id, serviceDate: isoDate } as const;
    const proposedAt = new Date();
    // Still unassigned when written: the proposal and the lock together, traced with the ambulance and the reason.
    const proposed = await db.$transaction(async (tx) => {
      const { count } = await tx.trip.updateMany({
        where: { id: trip.id, routeId: null, status: { in: ["PLANNED", "ASSIGNED"] } },
        data: { exceptionalAmbulanceAt: proposedAt, exceptionalAmbulanceById: user.id, lockedVehicleId: target.id },
      });
      if (count > 0) {
        await audit(tx, user, {
          action: "trip.exceptional_ambulance",
          ...traced,
          details: { vehicleId: target.id, reason: EXCEPTIONAL_AMBULANCE_REASON },
        });
      }
      return count > 0;
    }, PLANNING_TX_OPTIONS);
    if (!proposed) return { ok: false, error: "Cette course a changé entre-temps\u00a0: rechargez la page.", stale: true };

    // Puts the trip back as it was: its lock (if still the one written above: a refused move already put it
    // back) and its proposal (if still this one). Never once a plan gave the trip a route.
    const relocked = trip.lockedVehicleId !== target.id;
    const withdraw = () =>
      db.$transaction(async (tx) => {
        const events: AuditEntry[] = [];
        if (relocked) {
          const { count } = await tx.trip.updateMany({
            where: { id: trip.id, routeId: null, lockedVehicleId: target.id },
            data: { lockedVehicleId: trip.lockedVehicleId },
          });
          if (count > 0) events.push({ action: lockAction(trip.lockedVehicleId), ...traced });
        }
        const { count } = await tx.trip.updateMany({
          where: { id: trip.id, routeId: null, exceptionalAmbulanceAt: proposedAt },
          data: { exceptionalAmbulanceAt: trip.exceptionalAmbulanceAt, exceptionalAmbulanceById: trip.exceptionalAmbulanceById },
        });
        if (count > 0) events.push({ action: "trip.exceptional_ambulance_withdrawn", ...traced });
        if (events.length > 0) await audit(tx, user, events);
      }, PLANNING_TX_OPTIONS);
    const notKept = `Le recours exceptionnel à ${target.label} est retiré\u00a0: la course de ${who} reste sans véhicule.`;

    let outcome: RunOutcome;
    try {
      outcome = await runOptimization(isoDate, user, {
        move: {
          tripId: trip.id,
          vehicleId: target.id,
          vehicleLabel: target.label,
          patientName: who,
          direction: trip.direction,
          ...(relocked ? { previousLock: trip.lockedVehicleId } : {}),
        },
      });
    } catch (error) {
      logError("[planning] proposeExceptionalAmbulance failed after the lock", error);
      const undone = await withdraw().then(
        () => true,
        (undoError: unknown) => {
          logError("[planning] withdrawing an exceptional ambulance failed", undoError);
          return false;
        },
      );
      refreshPages();
      const why = planningErrorMessage(error) === DATABASE_ERROR ? "la base de données n'a pas répondu à temps" : "erreur inattendue";
      return {
        ok: false,
        error: undone
          ? `Recours à ${target.label} interrompu (${why}). ${notKept} Rechargez la page pour voir l'état réel du planning.`
          : `Recours à ${target.label} interrompu (${why})\u00a0: la course est peut-être restée figée sur l'ambulance. Rechargez la page pour voir l'état réel du planning.`,
        stale: true,
      };
    }
    // A plan waiting for confirmation keeps the proposal (it is rebuilt with it): confirmed, the trip goes to the
    // ambulance; discarded or replaced, the proposal is withdrawn (withdrawLapsedProposals).
    if (!outcome.ok && !outcome.needsConfirmation) {
      await withdraw();
      refreshPages();
      return { ok: false, error: `${outcome.error} ${notKept}`, ...(outcome.stale ? { stale: true } : {}) };
    }
    refreshPages();
    if (!outcome.ok) return toResult(outcome);
    return {
      ok: true,
      message: `Course de ${who} confiée à ${target.label}\u00a0: recours exceptionnel, facturé au tarif VSL. ${outcome.message}`,
      ...(outcome.warning ? { warning: true } : {}),
    };
  });
}

const selectionSchema = z.object({
  refusedVehicleIds: z.array(idSchema).max(300),
  key: z.string().min(1).max(128),
});

/**
 * « Tout accepter », « Remplacer quand même » : saves the plan computed by run `runId`, which
 * waited because it serves fewer trips, breaks more rules or loses margin compared with the routes
 * in place (lib/planning/plan-compare.ts), or for the regulator to review what it changes.
 * `selection` (« Enregistrer la sélection »): the vehicles that keep their route in place, and the
 * key of the day « Vérifier la sélection » showed.
 */
export async function confirmPlan(
  runId: string,
  selection?: { refusedVehicleIds: string[]; key: string },
): Promise<PlanningActionResult> {
  const user = await requireUser("REGULATOR");
  return guarded("confirmPlan", async () => {
    const id = idSchema.safeParse(runId);
    if (!id.success) return { ok: false, error: "Calcul introuvable\u00a0: rechargez la page.", stale: true };
    const chosen = selection === undefined ? null : selectionSchema.safeParse(selection);
    if (chosen && !chosen.success) return { ok: false, error: "Sélection invalide\u00a0: vérifiez-la de nouveau." };
    const outcome = await confirmPendingRun(id.data, user, chosen?.data);
    refreshPages();
    return toResult(outcome);
  });
}

/**
 * « Vérifier la sélection » (INS-02): the day a pending re-optimization makes when the vehicles of
 * `refusedVehicleIds` keep their route in place, re-checked by the optimizer's /evaluate; nothing
 * written. Read only: it names trips the page already traced (plan.view).
 */
export async function previewPlanSelection(runId: string, refusedVehicleIds: string[]): Promise<PreviewOutcome> {
  await requireUser("REGULATOR");
  const args = z.object({ runId: idSchema, refused: z.array(idSchema).min(1).max(300) }).safeParse({ runId, refused: refusedVehicleIds });
  if (!args.success) return { ok: false, error: "Sélection invalide\u00a0: rechargez la page.", stale: true };
  try {
    return await previewPendingSelection(args.data.runId, args.data.refused);
  } catch (error) {
    unstable_rethrow(error);
    logError("[planning] previewPlanSelection failed", error);
    return { ok: false, error: planningErrorMessage(error) };
  }
}

/** « Garder le planning actuel » : the plan waiting for confirmation is dropped. */
export async function discardPlan(runId: string): Promise<PlanningActionResult> {
  const user = await requireUser("REGULATOR");
  return guarded("discardPlan", async () => {
    const id = idSchema.safeParse(runId);
    if (!id.success) return { ok: false, error: "Calcul introuvable\u00a0: rechargez la page.", stale: true };
    const dropped = await discardPendingRun(id.data, async (tx, isoDate) => {
      await audit(tx, user, { action: "plan.discard", entity: "OptimizationRun", entityId: id.data, serviceDate: isoDate });
      // An exceptional ambulance proposed with that plan is not kept either.
      await withdrawLapsedProposals(tx, user, isoDate);
    });
    refreshPages();
    return dropped
      ? { ok: true, message: "Calcul écarté\u00a0: le planning en place est conservé." }
      : { ok: false, error: NOT_PENDING_ERROR, stale: true };
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
      return { ok: false, error: "Cette course est annulée\u00a0: rien à figer." };
    }
    if (!trip.route) {
      return { ok: false, error: "Cette course n'est sur aucune tournée\u00a0: utilisez «\u202fOù placer cette course\u202f?\u202f» pour la placer et la figer." };
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
    return { ok: true, message: `Course figée sur ${trip.route.vehicle.label}\u00a0: elle y restera à la prochaine optimisation.` };
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
    const traced = { entity: "Trip", entityId: trip.id, serviceDate: toIsoDate(trip.serviceDate) } as const;
    // Conditional writes: two concurrent « Défiger » change the row, and trace it, once.
    const withdrawn = await db.$transaction(async (tx) => {
      const events: AuditEntry[] = [];
      const { count } = await tx.trip.updateMany({ where: { id: trip.id, ...LOCKED }, data: { lockedVehicleId: null } });
      if (count > 0) events.push({ action: "trip.unlock", ...traced });
      // An exceptional ambulance holds only while the trip is locked on it: withdrawn with the lock.
      const proposal = await tx.trip.updateMany({
        where: { id: trip.id, exceptionalAmbulanceAt: { not: null } },
        data: { exceptionalAmbulanceAt: null, exceptionalAmbulanceById: null },
      });
      if (proposal.count > 0) events.push({ action: "trip.exceptional_ambulance_withdrawn", ...traced });
      if (events.length > 0) await audit(tx, user, events);
      return proposal.count > 0;
    }, PLANNING_TX_OPTIONS);
    refreshPages();
    return {
      ok: true,
      message: withdrawn
        ? "Course défigée et recours exceptionnel à l'ambulance retiré\u00a0: la prochaine optimisation la confiera à un taxi ou un VSL, ou la laissera sans véhicule."
        : "Course défigée\u00a0: la prochaine optimisation pourra la changer de véhicule.",
    };
  });
}

const scopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("route"), vehicleId: idSchema }),
  z.object({ kind: z.literal("depot"), depotId: idSchema }),
  z.object({ kind: z.literal("day") }),
]);

/** The trips of `isoDate` a lock of `scope` may change, and the scope's name (vehicle label, depot name). */
async function loadLockScope(
  tx: Prisma.TransactionClient,
  isoDate: string,
  scope: LockScope,
): Promise<{ trips: ScopeTrip[]; inScope: (vehicleId: string) => boolean; name: string | null; routeId: string | null } | null> {
  const serviceDate = fromIsoDate(isoDate);
  let vehicleIds: Set<string> | null = null;
  let name: string | null = null;
  let routeId: string | null = null;
  if (scope.kind === "route") {
    const route = await tx.route.findFirst({
      where: { serviceDate, vehicleId: scope.vehicleId },
      select: { id: true, vehicle: { select: { label: true } } },
    });
    if (!route) return null;
    vehicleIds = new Set([scope.vehicleId]);
    name = route.vehicle.label;
    routeId = route.id;
  } else if (scope.kind === "depot") {
    const depot = await tx.depot.findUnique({ where: { id: scope.depotId }, select: { name: true, vehicles: { select: { id: true } } } });
    if (!depot) return null;
    vehicleIds = new Set(depot.vehicles.map((v) => v.id));
    name = depot.name;
  }
  const ids = vehicleIds ? [...vehicleIds] : null;
  const rows = await tx.trip.findMany({
    where: {
      serviceDate,
      ...(ids ? { OR: [{ route: { is: { vehicleId: { in: ids } } } }, { lockedVehicleId: { in: ids } }] } : {}),
    },
    select: { id: true, status: true, lockedVehicleId: true, exceptionalAmbulanceAt: true, route: { select: { vehicleId: true } } },
  });
  return {
    trips: rows.map((t) => ({
      id: t.id,
      status: t.status,
      lockedVehicleId: t.lockedVehicleId,
      routeVehicleId: t.route?.vehicleId ?? null,
      exceptionalAmbulance: t.exceptionalAmbulanceAt !== null,
    })),
    inScope: (vehicleId) => vehicleIds === null || vehicleIds.has(vehicleId),
    name,
    routeId,
  };
}

/**
 * The audit event of a bulk lock or unlock: one per action, on the route, the
 * depot or the day, naming the trips actually changed (details.tripIds) and,
 * in the same order, the vehicle each was locked on or unlocked from
 * (details.vehicleIds): the trail answers « who locked or unlocked this trip »
 * once the route is gone.
 */
function lockScopeEvent(
  action: "plan.lock" | "plan.unlock",
  isoDate: string,
  scope: LockScope,
  routeId: string | null,
  changed: ReadonlyArray<{ tripId: string; vehicleId: string }>,
): AuditEntry {
  const trips = {
    trips: changed.length,
    tripIds: changed.map((c) => c.tripId),
    vehicleIds: changed.map((c) => c.vehicleId),
  };
  if (scope.kind === "route") {
    return { action, entity: "Route", entityId: routeId, serviceDate: isoDate, details: { scope: "route", vehicleId: scope.vehicleId, ...trips } };
  }
  if (scope.kind === "depot") {
    return { action, entity: "Depot", entityId: scope.depotId, serviceDate: isoDate, details: { scope: "depot", ...trips } };
  }
  return { action, entity: "Route", entityId: null, serviceDate: isoDate, details: { scope: "day", ...trips } };
}

/**
 * « Figer la tournée », « Figer le dépôt », « Figer toute la journée » : every
 * active trip of the scope's routes not locked yet is locked on the vehicle of
 * its route, in one transaction and one audit event (plan.lock). A trip already
 * locked keeps its lock. Under the planning lock of the date, on the version
 * the regulator saw, and never while a computation of the date runs.
 */
export async function lockRoutes(date: string, scope: LockScope, shownVersion: string): Promise<PlanningActionResult> {
  const user = await requireUser("REGULATOR");
  return guarded("lockRoutes", async () => {
    const parsed = z.object({ date: dateSchema, scope: scopeSchema }).safeParse({ date, scope });
    if (!parsed.success) return { ok: false, error: "Tournées à figer invalides\u00a0: rechargez la page." };
    const isoDate = parsed.data.date;
    const past = pastDateError(isoDate);
    if (past) return past;
    if (typeof shownVersion !== "string" || (await loadPlanVersion(db, isoDate)) !== shownVersion) return STALE_PLAN;

    const outcome = await db.$transaction(async (tx) => {
      await lockPlanningDay(tx, isoDate);
      // The computation running would not see these locks: its plan could put the trips elsewhere.
      if (await optimizationInProgress(isoDate, tx)) return "running" as const;
      if ((await loadPlanVersion(tx, isoDate)) !== shownVersion) return "stale" as const;
      const loaded = await loadLockScope(tx, isoDate, parsed.data.scope);
      if (!loaded) return "stale" as const;
      const plan = tripsToLock(loaded.trips, loaded.inScope);
      const changed: { tripId: string; vehicleId: string }[] = [];
      for (const [vehicleId, ids] of plan.byVehicle) {
        // Still unlocked and still on that vehicle's route when written.
        const rows = await tx.trip.updateManyAndReturn({
          where: { id: { in: ids }, lockedVehicleId: null, route: { is: { vehicleId } } },
          data: { lockedVehicleId: vehicleId },
          select: { id: true },
        });
        for (const row of rows) changed.push({ tripId: row.id, vehicleId });
      }
      if (changed.length > 0) await audit(tx, user, lockScopeEvent("plan.lock", isoDate, parsed.data.scope, loaded.routeId, changed));
      return { message: lockMessage(parsed.data.scope, loaded.name, changed.length, plan), changed: changed.length > 0 };
    }, PLANNING_TX_OPTIONS);
    if (outcome === "running") return { ok: false, error: OPTIMIZATION_IN_PROGRESS_ERROR };
    if (outcome === "stale") return STALE_PLAN;
    if (outcome.changed) refreshPages();
    return { ok: true, message: outcome.message };
  });
}

/**
 * « Défiger la tournée », « Défiger le dépôt », « Défiger toute la journée » :
 * every lock on one of the scope's vehicles, or on a trip of one of its
 * routes, is removed in one transaction and one audit event (plan.unlock).
 * An exceptional ambulance stays locked (« Défiger » withdraws it: its own
 * panel does it). Under the planning lock of the date, on the version the
 * regulator saw, and never while a computation of the date runs.
 */
export async function unlockRoutes(date: string, scope: LockScope, shownVersion: string): Promise<PlanningActionResult> {
  const user = await requireUser("REGULATOR");
  return guarded("unlockRoutes", async () => {
    const parsed = z.object({ date: dateSchema, scope: scopeSchema }).safeParse({ date, scope });
    if (!parsed.success) return { ok: false, error: "Tournées à défiger invalides\u00a0: rechargez la page." };
    const isoDate = parsed.data.date;
    const past = pastDateError(isoDate);
    if (past) return past;
    if (typeof shownVersion !== "string" || (await loadPlanVersion(db, isoDate)) !== shownVersion) return STALE_PLAN;

    const outcome = await db.$transaction(async (tx) => {
      await lockPlanningDay(tx, isoDate);
      // The computation running was sent these locks: its plan would keep the trips where they were locked.
      if (await optimizationInProgress(isoDate, tx)) return "running" as const;
      if ((await loadPlanVersion(tx, isoDate)) !== shownVersion) return "stale" as const;
      const loaded = await loadLockScope(tx, isoDate, parsed.data.scope);
      if (!loaded) return "stale" as const;
      const plan = tripsToUnlock(loaded.trips, loaded.inScope);
      const rows =
        plan.ids.length > 0
          ? await tx.trip.updateManyAndReturn({
              where: { id: { in: plan.ids }, lockedVehicleId: { not: null }, exceptionalAmbulanceAt: null },
              data: { lockedVehicleId: null },
              select: { id: true },
            })
          : [];
      // The lock each trip had, as read under the planning lock of the date.
      const lockedOn = new Map(loaded.trips.map((t) => [t.id, t.lockedVehicleId ?? ""]));
      const changed = rows.map((row) => ({ tripId: row.id, vehicleId: lockedOn.get(row.id) ?? "" }));
      if (changed.length > 0) await audit(tx, user, lockScopeEvent("plan.unlock", isoDate, parsed.data.scope, loaded.routeId, changed));
      return {
        message: unlockMessage(parsed.data.scope, loaded.name, changed.length, plan),
        changed: changed.length > 0,
        warning: plan.keptExceptional > 0,
      };
    }, PLANNING_TX_OPTIONS);
    if (outcome === "running") return { ok: false, error: OPTIMIZATION_IN_PROGRESS_ERROR };
    if (outcome === "stale") return STALE_PLAN;
    if (outcome.changed) refreshPages();
    return { ok: true, message: outcome.message, ...(outcome.warning ? { warning: true } : {}) };
  });
}

/**
 * « Valider le planning » : every route of the date becomes VALIDATED. When
 * the plan carries something to fix (route planned before a change of vehicle
 * or crew, overdue inspection or insurance, unassigned trip, violation, return
 * to check, trip to review), the regulator must confirm explicitly
 * (`confirmed`: the question the regulator answered, which must still be the
 * one asked): validationIssues, the same list as the page's « À traiter ».
 */
export async function validateDay(date: string, confirmed: string | null, shownVersion: string): Promise<PlanningActionResult> {
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
    if (routes === 0) return { ok: false, error: "Aucune tournée à valider\u00a0: lancez d'abord l'optimisation." };

    const issues = validationIssues(view);
    // Asked again when the issues changed since the question the regulator confirmed (absence, unavailability…).
    const question = issues.length > 0 ? validationQuestion(issues) : null;
    if (question !== null && confirmed !== question) return { ok: false, needsConfirmation: true, error: question };

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
      // A computation still waiting for confirmation could no longer replace a validated plan,
      // nor bring the exceptional ambulance it was computed with.
      await dropPendingRuns(tx, serviceDate, "le planning a été validé.");
      await withdrawLapsedProposals(tx, user, isoDate);
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
    return { ok: true, message: `Planning du ${formatLongDate(isoDate)} rouvert\u00a0: vous pouvez l'ajuster et le réoptimiser.` };
  });
}

const optionalIdSchema = z.union([z.literal(""), idSchema]).transform((value) => (value === "" ? null : value));

/** What « Changer l'équipage » did, said to the regulator. */
function routeCrewChangedText(outcome: {
  label: string;
  added: (string | null)[];
  withoutAccount: (string | null)[];
  removed: (string | null)[];
  released: string[];
  notes: string[];
}): string {
  const list = (names: readonly (string | null)[]) => names.filter((n): n is string => n !== null).join(" et ");
  const effects: string[] = [];
  if (outcome.added.length > 0) {
    const many = outcome.added.length > 1;
    effects.push(`${list(outcome.added)} ${many ? "voient" : "voit"} la tournée sur ${many ? "leur" : "sa"} feuille de route dès maintenant`);
  }
  if (outcome.removed.length > 0) effects.push(`${list(outcome.removed)} n'y ${outcome.removed.length > 1 ? "ont" : "a"} plus accès`);
  const parts = [
    effects.length > 0 ? `Équipage de ${outcome.label} changé\u00a0: ${effects.join(", ")}.` : `Équipage de ${outcome.label} changé.`,
  ];
  if (outcome.withoutAccount.length > 0) {
    const many = outcome.withoutAccount.length > 1;
    parts.push(
      `${list(outcome.withoutAccount)} n'${many ? "ont" : "a"} pas de compte actif\u00a0: transmettez-${many ? "leur" : "lui"} la tournée (Personnel, fiche de la personne).`,
    );
  }
  if (outcome.released.length > 0) {
    parts.push(
      outcome.released.length > 1
        ? `Les équipages fixés de ${list(outcome.released)} reviennent à la proposition automatique (page Équipages).`
        : `L'équipage fixé de ${list(outcome.released)} revient à la proposition automatique (page Équipages).`,
    );
  }
  parts.push(...outcome.notes);
  return parts.join(" ");
}

/**
 * « Changer l'équipage » of a route on a validated or started day (vehicle
 * panel): a sick driver is replaced without re-optimizing the day. Only the
 * route's driver and crew mate change (lib/staff/route-crew.ts checks the
 * people put on it), never its stops; the crew of the day of that vehicle is
 * fixed to the same people (Équipages and « À traiter » show the route's
 * crew), and the fixed crew of any other vehicle that held one of them goes
 * back to the proposal (a person is on one crew of the day; a vehicle with a
 * route keeps its route crew), which the result message names. The
 * replacement sees the roadmap at once if they have an active account, the
 * person replaced no longer does. Under the planning lock of the date, on the
 * version the regulator saw.
 */
export async function changeRouteCrew(
  routeId: string,
  driverId: string,
  crewMateId: string,
  shownVersion: string,
): Promise<PlanningActionResult> {
  const user = await requireUser("REGULATOR");
  return guarded("changeRouteCrew", async () => {
    const args = z
      .object({ routeId: idSchema, driverId: optionalIdSchema, crewMateId: optionalIdSchema })
      .safeParse({ routeId, driverId, crewMateId });
    if (!args.success) return { ok: false, error: "Équipage invalide\u00a0: rechargez la page." };
    const found = await db.route.findUnique({ where: { id: args.data.routeId }, select: { serviceDate: true } });
    if (!found) return { ok: false, error: "Tournée introuvable (réoptimisée entre-temps\u202f?).", stale: true };
    const isoDate = toIsoDate(found.serviceDate);
    const past = pastDateError(isoDate);
    if (past) return past;
    // A proposed day changes its crews on Équipages and is re-optimized; this action is for the routes kept as they are.
    if (!(await replanBlocker(isoDate))) {
      return {
        ok: false,
        error: "Planning ni validé ni commencé\u00a0: changez l'équipage sur la page Équipages, puis relancez l'optimisation.",
      };
    }
    if (await optimizationInProgress(isoDate)) return { ok: false, error: OPTIMIZATION_IN_PROGRESS_ERROR };
    if (typeof shownVersion !== "string" || (await loadPlanVersion(db, isoDate)) !== shownVersion) return STALE_PLAN;

    const serviceDate = fromIsoDate(isoDate);
    const outcome = await db.$transaction(async (tx) => {
      await lockPlanningDay(tx, isoDate);
      if ((await loadPlanVersion(tx, isoDate)) !== shownVersion) return { kind: "stale" as const };
      const [route, people, absences, incompatibilities, otherRoutes, rules] = await Promise.all([
        tx.route.findUnique({
          where: { id: args.data.routeId },
          select: {
            id: true,
            vehicleId: true,
            driverId: true,
            crewMateId: true,
            startMinute: true,
            endMinute: true,
            vehicle: { select: { label: true, type: true } },
            stops: { select: { sequence: true, kind: true, startMinute: true, completedAt: true, trip: { select: { status: true } } } },
          },
        }),
        tx.driver.findMany({
          select: {
            id: true,
            firstName: true,
            lastName: true,
            active: true,
            workDays: true,
            qualifications: true,
            depotId: true,
            shiftStartMinute: true,
            shiftEndMinute: true,
          },
        }),
        tx.staffAbsence.findMany({
          where: { startDate: { lte: serviceDate }, endDate: { gte: serviceDate } },
          select: { driverId: true, kind: true, startDate: true, endDate: true },
        }),
        tx.crewIncompatibility.findMany({ select: { driverAId: true, driverBId: true } }),
        tx.route.findMany({
          where: { serviceDate, id: { not: args.data.routeId } },
          select: { driverId: true, crewMateId: true, vehicle: { select: { label: true } } },
        }),
        loadCrewRules(tx),
      ]);
      if (!route) return { kind: "stale" as const };
      const byId = new Map(people.map((p) => [p.id, p]));
      const ambulance = route.vehicle.type === "AMBULANCE";
      const next = { driverId: args.data.driverId, crewMateId: ambulance ? args.data.crewMateId : null };
      const check = checkRouteCrewChange({
        date: isoDate,
        vehicle: route.vehicle,
        current: { driverId: route.driverId, crewMateId: route.crewMateId },
        next,
        remaining: remainingPart(route, route.stops.map((s) => ({ ...s, tripStatus: s.trip.status }))),
        people: byId,
        absences: absences.map((a) => ({ ...a, startDate: toIsoDate(a.startDate), endDate: toIsoDate(a.endDate) })),
        incompatibilities,
        otherRoutes: otherRoutes.map((r) => ({ vehicleLabel: r.vehicle.label, driverId: r.driverId, crewMateId: r.crewMateId })),
        rules,
      });
      const problems = Object.values(check.errors);
      if (problems.length > 0) return { kind: "refused" as const, error: problems.join(" "), fieldErrors: check.errors };

      // Conditional on the crew read above: two regulators changing it at once write it once.
      const { count } = await tx.route.updateMany({
        where: { id: route.id, driverId: route.driverId, crewMateId: route.crewMateId },
        data: next,
      });
      if (count === 0) return { kind: "stale" as const };
      // The fixed crews of other vehicles holding the new people go back to the proposal: a person is on one crew
      // of the day. Clearing only their seat would read as « left empty by the regulator » on that crew.
      const newPeople = [next.driverId, next.crewMateId].filter((id): id is string => id !== null);
      const released = await tx.dayCrew.findMany({
        where: {
          serviceDate,
          vehicleId: { not: route.vehicleId },
          OR: [{ driverId: { in: newPeople } }, { crewMateId: { in: newPeople } }],
        },
        select: { id: true, vehicleId: true, vehicle: { select: { label: true } } },
      });
      if (released.length > 0) await tx.dayCrew.deleteMany({ where: { id: { in: released.map((r) => r.id) } } });
      const dayCrew = await tx.dayCrew.upsert({
        where: { serviceDate_vehicleId: { serviceDate, vehicleId: route.vehicleId } },
        create: { serviceDate, vehicleId: route.vehicleId, ...next, updatedById: user.id },
        update: { ...next, updatedById: user.id },
        select: { id: true },
      });
      await audit(tx, user, [
        {
          action: "route.crew_change",
          entity: "Route",
          entityId: route.id,
          serviceDate: isoDate,
          details: {
            vehicleId: route.vehicleId,
            driverId: { from: route.driverId, to: next.driverId },
            crewMateId: { from: route.crewMateId, to: next.crewMateId },
          },
        },
        {
          action: "day_crew.save",
          entity: "DayCrew",
          entityId: dayCrew.id,
          serviceDate: isoDate,
          details: { vehicleId: route.vehicleId, driverId: next.driverId, crewMateId: next.crewMateId },
        },
        ...released.map((r) => ({
          action: "day_crew.unfix" as const,
          entity: "DayCrew" as const,
          entityId: r.id,
          serviceDate: isoDate,
          details: { vehicleId: r.vehicleId },
        })),
      ]);
      const name = (id: string | null) => {
        const person = id ? byId.get(id) : undefined;
        return person ? personName(person) : null;
      };
      const addedIds = newPeople.filter((id) => id !== route.driverId && id !== route.crewMateId);
      // The roadmap is read with a driver account: someone without an active one has to be told the route.
      const accounts = await tx.user.findMany({
        where: { driverId: { in: addedIds }, role: "DRIVER", active: true },
        select: { driverId: true },
      });
      const withAccount = new Set(accounts.map((a) => a.driverId));
      const removed = [route.driverId, route.crewMateId]
        .filter((id): id is string => id !== null && !newPeople.includes(id))
        .map(name);
      return {
        kind: "changed" as const,
        label: route.vehicle.label,
        added: addedIds.filter((id) => withAccount.has(id)).map(name),
        withoutAccount: addedIds.filter((id) => !withAccount.has(id)).map(name),
        removed,
        released: released.map((r) => r.vehicle.label),
        notes: check.notes,
      };
    }, PLANNING_TX_OPTIONS);

    if (outcome.kind === "stale") return STALE_PLAN;
    if (outcome.kind === "refused") return { ok: false, error: outcome.error, fieldErrors: outcome.fieldErrors };
    refreshPages();
    return { ok: true, message: routeCrewChangedText(outcome) };
  });
}
