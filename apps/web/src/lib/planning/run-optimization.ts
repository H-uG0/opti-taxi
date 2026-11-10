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
import type { OptimizeRequest, PlanResponse, RoutePlan } from "@/lib/optimizer/contract";
import {
  FIELD_TRIP_STATUSES,
  PlanBlockedError,
  replanBlockReason,
  savePlan,
  type SavePlanResult,
} from "@/lib/optimizer/persist";
import {
  readPendingPlan,
  readRunDetails,
  runDetailsJson,
  withoutPending,
  type LockChange,
  type RunKind,
} from "@/lib/optimizer/run-details";
import { formatLongDate, fromIsoDate, todayIso, tomorrowIso, toIsoDate } from "@/lib/time";
import { completeTrips } from "@/lib/trips/completion";
import { tariffGapNote } from "./format";
import { withBeforeCommit } from "./before-commit";
import { lockPlanningDay } from "./day-lock";
import { emptyPlanIssue } from "./empty-plan";
import { isExceptionalAmbulanceTrip } from "./exceptional-ambulance";
import { lockAction } from "./lock";
import { pinAssignedTrips } from "./place-unassigned";
import {
  movePlacementIssue,
  moveRequestIssue,
  resolveTripRefs,
  tripRef,
  tripRefIds,
  type MoveTarget,
  type TripName,
} from "./move";
import {
  changedRoutes,
  comparisonQuestion,
  DEFAULT_REPLACE_THRESHOLDS,
  NOT_KEPT_PREFIX,
  replaceConcerns,
  restorableRoutes,
  routesInPlace,
  type PlanComparison,
  type RouteChanges,
  type RouteFigures,
} from "./plan-compare";
import { loadPlanVersion, requestHash } from "./version";
import { formatPersonName } from "@/lib/names";

export type RunOutcome =
  | {
      ok: true;
      message: string;
      runId: string;
      /** The plan was saved but leaves something to look at (violations, trips not placed, trips that changed vehicle). */
      warning?: boolean;
    }
  | {
      ok: false;
      error: string;
      /** The requested move cannot be carried out; the saved planning is unchanged. */
      moveRejected?: boolean;
      /** The plan computed is worse than (or as invalid as) the routes in place: it waits for the regulator's word. */
      needsConfirmation?: boolean;
      /** The page shows a state that changed since (the plan was handled elsewhere): offer to reload it. */
      stale?: boolean;
    };

export type RunOptions = {
  /** « Déplacer vers… » : save the plan only if it serves this trip with this vehicle. */
  move?: MoveTarget;
  /**
   * « Placer les non affectées » : every trip in a route is sent locked on its
   * vehicle for this computation only (never written), so that only the trips
   * without a vehicle are placed (lib/planning/place-unassigned.ts).
   */
  placeOnly?: boolean;
};

/**
 * Budget of the planning transactions (a change and its audit event): the
 * same as savePlan, whose row locks they may have to wait for.
 */
export const PLANNING_TX_OPTIONS = { maxWait: 15_000, timeout: 60_000 } as const;

export const OPTIMIZATION_IN_PROGRESS_ERROR =
  "Une optimisation de cette date est en cours : attendez la fin du calcul puis rechargez la page.";

export const NO_ROUTES_TO_KEEP_ERROR =
  "Aucune tournée en place ce jour : lancez l'optimisation de la journée, qui place toutes les courses.";
export const NOTHING_TO_PLACE_ERROR = "Aucune course sans véhicule à placer : toutes les courses du jour sont dans une tournée.";

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

/** « Placer les non affectées » when every trip without a vehicle is incomplete (never sent to the optimizer). */
export function incompleteOnlyError(count: number): string {
  return count > 1
    ? `Aucune course à placer : les ${count} courses sans véhicule restantes sont incomplètes (voir « À traiter ») et ne peuvent pas être calculées.`
    : "Aucune course à placer : la course sans véhicule restante est incomplète (voir « À traiter ») et ne peut pas être calculée.";
}

/** « Placer les non affectées » : what the computation was asked to do. */
type Placement = {
  /** Trips without a vehicle it was asked to place. */
  toPlace: ReadonlySet<string>;
  /** Trips in a route when it started, with the vehicle of that route. */
  assignments: ReadonlyMap<string, string>;
};

/** How a placement went: trips placed out of those asked, and trips already placed that changed vehicle. */
type PlacementOutcome = { placed: number; asked: number; moved: number };

function placementOutcome(plan: Pick<PlanResponse, "routes">, placement: Placement): PlacementOutcome {
  const vehicleOf = new Map<string, string>();
  for (const route of plan.routes) for (const stop of route.stops) vehicleOf.set(stop.tripId, route.vehicleId);
  const placed = [...placement.toPlace].filter((id) => vehicleOf.has(id)).length;
  let moved = 0;
  for (const [tripId, before] of placement.assignments) {
    const after = vehicleOf.get(tripId);
    if (after !== undefined && after !== before) moved += 1;
  }
  return { placed, asked: placement.toPlace.size, moved };
}

/**
 * « 2 courses placées sur 3 non affectées, les autres courses restent sur leur
 * véhicule ». A trip already placed changes vehicle only when its route's
 * vehicle can no longer take it (its pin is dropped) or when the regulator
 * locked it on another vehicle: said, never hidden behind « restent ».
 */
function placementText({ placed, asked, moved }: PlacementOutcome): string {
  const what =
    placed > 0
      ? `${plural(placed, "course placée", "courses placées")} sur ${plural(asked, "non affectée", "non affectées")}`
      : asked > 1
        ? `Aucune des ${asked} courses non affectées n'a trouvé de place`
        : "La course non affectée n'a pas trouvé de place";
  const others =
    moved > 0
      ? `${plural(moved, "course déjà placée change", "courses déjà placées changent")} de véhicule (figée ailleurs ou véhicule indisponible)`
      : "les autres courses restent sur leur véhicule";
  return `${what}, ${others}`;
}

/** The plan leaves something to look at: trips not placed, trips that changed vehicle. */
function placementWarning({ placed, asked, moved }: PlacementOutcome): boolean {
  return placed < asked || moved > 0;
}

/**
 * Trips served in place (and still to plan) that a placement would leave
 * without a vehicle: « Placer les non affectées » promises the others stay on
 * their vehicle, so such a plan is never saved, nor offered for confirmation.
 */
function placementLoss(lostTripIds: readonly string[], request: OptimizeRequest): string | null {
  const sent = new Set(request.trips.map((t) => t.id));
  const lost = lostTripIds.filter((id) => sent.has(id));
  if (lost.length === 0) return null;
  const named = lost.slice(0, 3).map(tripRef).join(", ");
  const more = lost.length > 3 ? ` et ${lost.length - 3} autre${lost.length > 4 ? "s" : ""}` : "";
  return (
    `ce placement aurait retiré ${plural(lost.length, "course déjà placée", "courses déjà placées")} de ${lost.length > 1 ? "leur" : "son"} ` +
    `véhicule (${named}${more}). Placez les courses non affectées une à une avec « Déplacer vers… », ou réoptimisez la journée.`
  );
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

/**
 * Trips the plan in place of isoDate (its last saved computation) left
 * without a vehicle: the only ones an exceptional ambulance may be proposed
 * for (TAR-03). Empty before any computation.
 */
export async function unassignedByLastPlan(isoDate: string): Promise<ReadonlySet<string>> {
  const run = await db.optimizationRun.findFirst({
    where: { serviceDate: fromIsoDate(isoDate), status: "SUCCESS" },
    orderBy: { startedAt: "desc" },
    select: { id: true, details: true, kpis: true },
  });
  const details = run ? readRunDetails(run) : null;
  return new Set(details?.unassigned.map((u) => u.tripId) ?? []);
}

/** Trips of isoDate in a route, with the vehicle of that route (« Placer les non affectées »). */
async function loadAssignments(isoDate: string): Promise<Map<string, string>> {
  const rows = await db.trip.findMany({
    where: { serviceDate: fromIsoDate(isoDate), routeId: { not: null } },
    select: { id: true, route: { select: { vehicleId: true } } },
  });
  return new Map(rows.flatMap((row) => (row.route ? [[row.id, row.route.vehicleId] as const] : [])));
}

/**
 * Exceptional ambulance proposals of isoDate no longer in force (TAR-03): the
 * trip is no longer locked on an ambulance (moved, unlocked, the plan that
 * carried it discarded), or its prescription now allows an ambulance. Cleared
 * and traced (trip.exceptional_ambulance_withdrawn) in `tx`: with every plan
 * saved, and when a plan waiting for confirmation is dropped. A proposal
 * whose plan still waits for confirmation keeps its flag (the plan is
 * rebuilt with it), so never call this while one may wait.
 */
export async function withdrawLapsedProposals(tx: Prisma.TransactionClient, user: Actor, isoDate: string): Promise<void> {
  const proposed = await tx.trip.findMany({
    where: { serviceDate: fromIsoDate(isoDate), exceptionalAmbulanceAt: { not: null } },
    select: {
      id: true,
      exceptionalAmbulanceAt: true,
      lockedVehicleId: true,
      allowedVehicleTypes: true,
      lockedVehicle: { select: { type: true } },
    },
  });
  const lapsed = proposed.filter((trip) => !isExceptionalAmbulanceTrip(trip, () => trip.lockedVehicle?.type)).map((trip) => trip.id);
  if (lapsed.length === 0) return;
  await tx.trip.updateMany({
    where: { id: { in: lapsed }, exceptionalAmbulanceAt: { not: null } },
    data: { exceptionalAmbulanceAt: null, exceptionalAmbulanceById: null },
  });
  await audit(
    tx,
    user,
    lapsed.map((id) => ({ action: "trip.exceptional_ambulance_withdrawn" as const, entity: "Trip" as const, entityId: id, serviceDate: isoDate })),
  );
}

/** Why savePlan's guard kept the routes in place. */
class ReplaceRefused extends Error {
  constructor(
    readonly reason: "confirm" | "place" | "gone" | "stale",
    message: string,
    readonly comparison: PlanComparison | null = null,
    readonly version: string | null = null,
  ) {
    super(message);
    this.name = "ReplaceRefused";
  }
}

export const NOT_PENDING_ERROR = "Ce calcul n'attend plus de confirmation (déjà traité ou remplacé par un autre) : rechargez la page.";
const INPUT_CHANGED_ERROR = `${NOT_KEPT_PREFIX} : les données du jour ont changé depuis (courses, courses figées, équipages, véhicules ou paramètres). Relancez l'optimisation.`;
const PLAN_CHANGED_SINCE_ERROR = `${NOT_KEPT_PREFIX} : le planning en place a changé depuis. Relancez l'optimisation.`;

type Actor = Pick<SessionUser, "id" | "role">;

/** The lock moveTrip wrote before the computation, or null when the trip already was locked on the vehicle. */
function moveLockChange(move: MoveTarget | undefined): LockChange | null {
  if (!move || move.previousLock === undefined) return null;
  return { tripId: move.tripId, from: move.previousLock, to: move.vehicleId };
}

function reversed(change: LockChange): LockChange {
  return { tripId: change.tripId, from: change.to, to: change.from };
}

/** The day's input as a plan is computed with `change`: its trip locked on `to`, if still locked on `from`. */
function withLockChange(change: LockChange | null): (input: OptimizeInput) => OptimizeInput {
  if (!change) return (input) => input;
  return (input) => ({
    ...input,
    trips: input.trips.map((t) =>
      t.id === change.tripId && t.lockedVehicleId === change.from ? { ...t, lockedVehicleId: change.to } : t,
    ),
  });
}

/**
 * Writes `change` if the trip is still locked on `from` (conditional: a lock
 * changed meanwhile is left as is), traced as `action`, by default the lock or
 * unlock it amounts to.
 */
async function writeLockChange(
  tx: Prisma.TransactionClient,
  user: Actor,
  isoDate: string,
  change: LockChange,
  action: "trip.move" | "trip.lock" | "trip.unlock" = lockAction(change.to),
): Promise<void> {
  const { count } = await tx.trip.updateMany({
    where: { id: change.tripId, lockedVehicleId: change.from },
    data: { lockedVehicleId: change.to },
  });
  if (count > 0) await audit(tx, user, { action, entity: "Trip", entityId: change.tripId, serviceDate: isoDate });
}

/**
 * A refused move puts back the lock moveTrip set, so the next optimization
 * does not keep the trip unassigned. The undo is a change of its own.
 */
async function undoMoveLock(change: LockChange | null, user: Actor, isoDate: string): Promise<void> {
  if (!change) return;
  await db.$transaction((tx) => writeLockChange(tx, user, isoDate, reversed(change)), PLANNING_TX_OPTIONS);
}

/**
 * A message naming trips by tripRef, as the regulator reads it at once: each
 * trip named by its patient and leg (« l'aller de … »). Never stored.
 */
async function shownMessage(text: string, move?: MoveTarget): Promise<string> {
  const ids = tripRefIds(text);
  if (ids.length === 0) return text;
  const names = new Map<string, TripName>();
  if (move) names.set(move.tripId, { patient: move.patientName, direction: move.direction ?? null });
  const others = ids.filter((id) => !names.has(id));
  if (others.length > 0) {
    try {
      const rows = await db.trip.findMany({
        where: { id: { in: others } },
        select: { id: true, direction: true, patient: { select: { firstName: true, lastName: true } } },
      });
      for (const row of rows) {
        const patient = formatPersonName(row.patient);
        names.set(row.id, { patient, direction: row.direction });
      }
    } catch (error) {
      // The message still goes out, with « une course » for the trips it could not name.
      logError("[planning] naming the trips of a message failed", error);
    }
  }
  return resolveTripRefs(text, (id) => names.get(id) ?? null);
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Before computing a date that can still be planned (tomorrow on), its
 * missing recurring trips are created, and those the application cancelled
 * brought back (lib/trips/completion.ts): the plan never leaves out a regular
 * patient because the trips were not generated. A failure is logged and the
 * computation goes on with the trips in place.
 */
async function completeDayBeforeRun(isoDate: string, user: Actor): Promise<void> {
  if (isoDate < tomorrowIso() || (await replanBlocker(isoDate))) return;
  try {
    await db.$transaction((tx) => completeTrips(tx, user, { from: isoDate, to: isoDate }), PLANNING_TX_OPTIONS);
  } catch (error) {
    logError("[planning] completing the trips before the optimization failed", error, { serviceDate: isoDate });
  }
}

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
          : `Aucune course à planifier le ${formatLongDate(isoDate)} : aucune récurrence ne prévoit de course ce jour (ou leurs prescriptions ont expiré). Saisissez une course ponctuelle, ou vérifiez les prescriptions.`,
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

/** The routes in place of a date: as stored, and as sent to the optimizer (null: none, a start from scratch). */
type RoutesInPlace = { stored: RouteSequences; sent: RoutePlan[] | null };
type RouteSequences = Pick<RouteFigures, "vehicleId" | "stops">[];

/**
 * The routes in place of isoDate as the optimizer's start (routesInPlace): a
 * re-optimization never returns a plan that scores worse than them under the
 * same rules and objective, so recomputing a day where nothing changed seldom
 * asks « Remplacer quand même ? » (still when the plan returned trades a trip
 * served for a patient no longer half-served, or a better margin for a trip).
 * Not part of the request's hash (lib/planning/version.ts): the plan version
 * guards the routes in place. A failure to read them is logged and the
 * computation starts from scratch.
 */
async function loadRoutesInPlace(isoDate: string, request: OptimizeRequest): Promise<RoutesInPlace | null> {
  try {
    const stored = await db.route.findMany({
      where: { serviceDate: fromIsoDate(isoDate) },
      select: { vehicleId: true, stops: { select: { tripId: true, kind: true, sequence: true } } },
    });
    return { stored, sent: routesInPlace(stored, request) };
  } catch (error) {
    logError("[planning] reading the routes in place before the optimization failed", error, { serviceDate: isoDate });
    return null;
  }
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
  /** Locks set by the regulator, when the request carries others (« Placer les non affectées »). */
  lockedCount: number = request.trips.filter((t) => t.lockedVehicleId).length,
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
        lockedCount,
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

async function failRun(
  runId: string,
  error: string,
  extra: { matrixSource?: string; wallTimeMs?: number; details?: Prisma.InputJsonObject } = {},
) {
  await db.optimizationRun.update({
    where: { id: runId },
    data: { status: "FAILED", finishedAt: new Date(), error, ...extra },
  });
  return { ok: false as const, error };
}

/** The first plan computed with OSRM started the traffic calibration over (savePlan): traced like a change of it. */
function auditTrafficReset(tx: Prisma.TransactionClient, user: Actor, runId: string, isoDate: string): Promise<void> {
  return audit(tx, user, {
    action: "traffic.calibration_reset",
    entity: "AppSettings",
    entityId: "1",
    serviceDate: isoDate,
    details: { runId, matrixSource: "osrm" },
  });
}

const AUDIT_ACTION: Record<RunKind, "plan.optimize" | "plan.restore"> = {
  optimize: "plan.optimize",
  move: "plan.optimize",
  restore: "plan.restore",
  place: "plan.optimize",
};

/** Audit details of a saved plan: how it was computed when not a plain optimization. */
function auditDetails(kind: RunKind, confirmed: boolean): { details?: { confirmed?: boolean; mode?: string } } {
  const details = { ...(confirmed ? { confirmed: true } : {}), ...(kind === "place" ? { mode: "place_unassigned" } : {}) };
  return Object.keys(details).length > 0 ? { details } : {};
}

/**
 * "Planning optimisé : 62/64 courses servies · 10 tournées dont 2 modifiées · calcul 10 s · …";
 * « Planning en place conservé, aucun meilleur trouvé : … » when the computation gave back the
 * routes in place (`changes`: against them, null when unknown).
 */
function successMessage(
  kind: RunKind,
  saved: SavePlanResult,
  plan: PlanResponse,
  build: BuildResult,
  changes: RouteChanges | null = null,
  placement: PlacementOutcome | null = null,
): string {
  const kept = kind === "optimize" && changes !== null && changes.changed === 0 && changes.removed === 0 && changes.total > 0;
  let routes = plural(saved.routes, "tournée");
  if (changes && !kept && changes.changed === 0) routes += saved.routes > 1 ? " inchangées" : " inchangée";
  else if (changes && !kept && changes.changed < changes.total) routes += ` dont ${plural(changes.changed, "modifiée")}`;
  const parts = [`${saved.served}/${saved.served + saved.unassigned} courses servies`, routes];
  if (changes && changes.removed > 0) parts.push(plural(changes.removed, "tournée retirée", "tournées retirées"));
  if (kind !== "restore") parts.push(`calcul ${seconds(plan.meta.wallTimeMs)}`);
  if (plan.meta.matrixSource === "haversine") parts.push("distances estimées à vol d'oiseau");
  if (plan.meta.trafficSource !== "none") parts.push("trafic pris en compte");
  const tariffNote = tariffGapNote(build.tariffGaps);
  if (tariffNote) parts.push(tariffNote);
  const violations = plan.validation.violations.length;
  if (violations > 0) parts.push(`${plural(violations, "violation")} à vérifier`);
  if (kind === "place" && placement) return `${placementText(placement)} : ${parts.join(" · ")}.`;
  const what =
    kind === "restore" ? "Planning précédent rétabli" : kept ? "Planning en place conservé, aucun meilleur trouvé" : "Planning optimisé";
  return `${what} : ${parts.join(" · ")}.`;
}

/**
 * Saves the computed plan of run `runId`, unless it is worse than (or as
 * invalid as) the routes in place: it then waits for the regulator's word
 * (AWAITING_CONFIRMATION). A move that leaves other trips without a vehicle
 * waits too, the question naming those trips: a full re-solve often swaps a
 * trip or two, and refusing every such move made « Déplacer vers… » fail most
 * of the time (local insertion, which does not touch the other routes, is the
 * real cure: feat/deplacement-rapide). « Placer les non affectées » that would
 * take a trip served in place off its vehicle is refused outright (the run is
 * closed as not kept, the planning stays): the mode promises the others stay.
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
  /**
   * The trip lock changed with this plan, recorded with it when saved: already
   * written (a move, by moveTrip: undone when the plan is refused or waits for
   * confirmation), or written with the routes (a restoration).
   */
  lock?: { change: LockChange; written: boolean } | null;
  /** The routes in place when the computation started, as stored: the message says how many it changed. */
  inPlace?: RouteSequences | null;
  /** « Placer les non affectées » : the trips it was asked to place, and those already in a route. */
  placement?: Placement | null;
  /** Locks set by the regulator when the request also carries the pins of « Placer les non affectées ». */
  lockedCount?: number;
}): Promise<RunOutcome> {
  const { kind, isoDate, user, runId, build, plan, move } = args;
  const lock = args.lock ?? null;
  const placement = args.placement ?? null;
  const { request } = build;
  const meta = { matrixSource: plan.meta.matrixSource, wallTimeMs: plan.meta.wallTimeMs };
  // Messages name trips by id (stored as is); the regulator reads the patients' names.
  const shown = (text: string) => shownMessage(text, move);
  const undoMove = () => undoMoveLock(lock?.written ? lock.change : null, user, isoDate);

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
      await undoMove();
      return { ok: false, error: await shown(issue), moveRejected: true };
    }
  }

  const thresholds = args.input.replan ?? DEFAULT_REPLACE_THRESHOLDS;
  let saved: SavePlanResult;
  try {
    // The event commits with the saved plan, or rolls back with it (kept routes, blocked day, database error).
    const traced = withBeforeCommit(db, async (tx) => {
      await audit(tx, user, {
        action: AUDIT_ACTION[kind],
        entity: "OptimizationRun",
        entityId: runId,
        serviceDate: isoDate,
        ...auditDetails(kind, false),
      });
      // A restoration puts back, with the routes, the lock the move it undoes had replaced.
      if (lock && !lock.written) await writeLockChange(tx, user, isoDate, lock.change);
      await withdrawLapsedProposals(tx, user, isoDate);
    });
    saved = await savePlan(traced, {
      runId,
      isoDate,
      request,
      response: plan,
      crews: build.crews,
      kind,
      lockChange: lock?.change,
      ...(args.lockedCount !== undefined ? { lockedCount: args.lockedCount } : {}),
      onTrafficReset: (tx) => auditTrafficReset(tx, user, runId, isoDate),
      check: ({ comparison, version }) => {
        if (placement) {
          const loss = placementLoss(comparison.lostTripIds, request);
          if (loss) throw new ReplaceRefused("place", loss);
        }
        // A move that would leave other trips without a vehicle is never applied silently: the question
        // names them. A trip the computation was not given (left out of the request since) is not lost by
        // the move, and routes that can no longer be driven are not counted at all.
        let lostByMove = "";
        if (move) {
          const sent = new Set(request.trips.map((t) => t.id));
          const others = comparison.lostTripIds.filter((id) => id !== move.tripId && sent.has(id));
          if (others.length > 0) {
            const named = others.slice(0, 3).map(tripRef).join(", ");
            const more = others.length > 3 ? ` et ${others.length - 3} autre${others.length > 4 ? "s" : ""}` : "";
            lostByMove = `le nouveau calcul laisserait sans véhicule ${plural(others.length, "autre course", "autres courses")} (${named}${more}). `;
          }
        }
        const concerns = replaceConcerns(comparison, thresholds);
        if (concerns.length > 0 || lostByMove) {
          const subject = kind === "restore" ? "Le planning précédent" : kind === "place" ? "Ce placement" : "Ce calcul";
          const question = comparisonQuestion(comparison, concerns, subject);
          const asked = move
            ? `Déplacement de ${tripRef(move.tripId)} vers ${move.vehicleLabel} : ${lostByMove}${lostByMove ? question : lowerFirst(question)}`
            : question;
          throw new ReplaceRefused("confirm", asked, comparison, version);
        }
      },
    });
  } catch (error) {
    if (error instanceof ReplaceRefused && error.reason === "place") {
      // Not a failure of the computation: its plan is not kept (the banner says « Placement … non retenu », from its kind).
      await failRun(runId, `${NOT_KEPT_PREFIX} : ${error.message}`, { ...meta, details: runDetailsJson(plan, { kind }) });
      return { ok: false, error: await shown(`Planning inchangé : ${error.message}`) };
    }
    if (error instanceof ReplaceRefused && error.comparison && error.version) {
      const { comparison, version: compared, message } = error;
      // Kept in its run until the regulator decides (confirmPendingRun / discardPendingRun). A move's lock
      // is undone meanwhile, in the same transaction, and set again when the plan is confirmed.
      await db.$transaction(async (tx) => {
        await lockPlanningDay(tx, isoDate);
        let basedOnVersion = compared;
        if (lock?.written) {
          // The undo moves Trip.updatedAt, hence the plan's version: the routes compared are still those
          // in place, at the version after the undo, if nothing else changed before it.
          const before = await loadPlanVersion(tx, isoDate);
          await writeLockChange(tx, user, isoDate, reversed(lock.change));
          if (before === compared) basedOnVersion = await loadPlanVersion(tx, isoDate);
        }
        await tx.optimizationRun.update({
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
              comparison,
              question: message,
              pending: {
                response: plan,
                requestHash: requestHash(request),
                basedOnVersion,
                lockChange: lock?.change ?? null,
                ...(kind === "place" ? { placeOnly: true } : {}),
              },
            }),
          },
        });
      }, PLANNING_TX_OPTIONS);
      return { ok: false, needsConfirmation: true, error: await shown(message) };
    }
    if (error instanceof PlanBlockedError) return failRun(runId, error.message, meta);
    logError("[planning] saving the plan failed", error, { runId, serviceDate: isoDate });
    return failRun(runId, "Le planning calculé n'a pas pu être enregistré (erreur de base de données). Relancez l'optimisation.", meta);
  }
  const changes = args.inPlace ? changedRoutes(args.inPlace, plan.routes) : null;
  const placed = placement ? placementOutcome(plan, placement) : null;
  const warning = plan.validation.violations.length > 0 || (placed !== null && placementWarning(placed));
  return {
    ok: true,
    runId,
    message: successMessage(kind, saved, plan, build, changes, placed),
    ...(warning ? { warning: true } : {}),
  };
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
export async function runOptimization(isoDate: string, user: Actor, options: RunOptions = {}): Promise<RunOutcome> {
  await completeDayBeforeRun(isoDate, user);
  // « Placer les non affectées » : the trips in a route go locked on its vehicle, for this computation only.
  const assignments = options.placeOnly ? await loadAssignments(isoDate) : null;
  if (assignments && assignments.size === 0) return { ok: false, error: NO_ROUTES_TO_KEEP_ERROR };
  let pinned: ReadonlySet<string> = new Set();
  const prepared = await prepareRequest(
    isoDate,
    assignments
      ? (day) => {
          const pinnedInput = pinAssignedTrips(day, assignments);
          pinned = pinnedInput.pinned;
          return pinnedInput.input;
        }
      : undefined,
  );
  if (!prepared.ok) return { ok: false, error: prepared.error };
  const { input, build } = prepared;
  const { move } = options;
  const toPlace = assignments ? new Set(build.request.trips.filter((t) => !assignments.has(t.id)).map((t) => t.id)) : null;
  if (assignments && toPlace && toPlace.size === 0) {
    // Trips without a vehicle never sent to the optimizer (incomplete): nothing this computation could place.
    const incomplete = build.excludedTrips.filter((t) => !assignments.has(t.tripId)).length;
    return { ok: false, error: incomplete > 0 ? incompleteOnlyError(incomplete) : NOTHING_TO_PLACE_ERROR };
  }
  const moveLock = moveLockChange(move);
  if (move) {
    const issue = moveRequestIssue(build, move);
    if (issue) {
      await undoMoveLock(moveLock, user, isoDate);
      return { ok: false, error: await shownMessage(issue, move), moveRejected: true };
    }
  }

  const ownLocks = build.request.trips.filter((t) => t.lockedVehicleId && !pinned.has(t.id)).length;
  const runId = await startRun(isoDate, user, build.request, input.settings.solverTimeLimitSec, ownLocks);
  if (!runId) return { ok: false, error: OPTIMIZATION_IN_PROGRESS_ERROR };
  const inPlace = await loadRoutesInPlace(isoDate, build.request);
  const result: OptimizerResult<PlanResponse> = await optimize(
    inPlace?.sent ? { ...build.request, initialRoutes: inPlace.sent } : build.request,
  );
  if (!result.ok) return failRun(runId, result.error);
  return finishRun({
    kind: move ? "move" : toPlace ? "place" : "optimize",
    isoDate,
    user,
    runId,
    input,
    build,
    plan: result.data,
    move,
    lock: moveLock ? { change: moveLock, written: true } : null,
    inPlace: inPlace?.stored,
    placement: assignments && toPlace ? { toPlace, assignments } : null,
    ...(toPlace ? { lockedCount: ownLocks } : {}),
  });
}

/**
 * « Revenir au planning précédent » : the stop sequences the current routes
 * replaced (details.previous of the run that saved them) are re-timed by the
 * optimizer's /evaluate with today's data, then saved like a computation
 * (same comparison with the routes in place). Trips cancelled or vehicles
 * unavailable since are left out. Only while the day can be re-planned.
 * When the routes in place came with a lock change (a move), the lock it
 * replaced is put back with the routes: the trip is not left locked on the
 * vehicle the restored routes no longer put it on.
 */
export async function restorePreviousPlan(isoDate: string, user: Actor): Promise<RunOutcome> {
  const planRun = await db.optimizationRun.findFirst({
    where: { serviceDate: fromIsoDate(isoDate), status: "SUCCESS" },
    orderBy: { startedAt: "desc" },
    select: { id: true, details: true, kpis: true },
  });
  const planDetails = planRun ? readRunDetails(planRun) : null;
  const previous = planDetails?.previous;
  if (!previous || previous.routes.length === 0) return { ok: false, error: "Aucun planning précédent à rétablir pour ce jour." };
  const relock = planDetails?.lockChange ? reversed(planDetails.lockChange) : null;

  const prepared = await prepareRequest(isoDate, withLockChange(relock));
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
  return finishRun({
    kind: "restore",
    isoDate,
    user,
    runId,
    input,
    build,
    plan: result.data,
    lock: relock ? { change: relock, written: false } : null,
  });
}

/**
 * « Remplacer quand même » : saves the plan of run `runId`, waiting for
 * confirmation, if the day's data still builds the same request and the
 * routes in place are still those it was compared with. The lock the plan
 * was computed with (a move's, a restored one) is written in the same
 * transaction.
 */
export async function confirmPendingRun(runId: string, user: Actor): Promise<RunOutcome> {
  const run = await db.optimizationRun.findUnique({
    where: { id: runId },
    select: { id: true, serviceDate: true, status: true, finishedAt: true, details: true, kpis: true },
  });
  if (!run || run.status !== "AWAITING_CONFIRMATION") return { ok: false, error: NOT_PENDING_ERROR, stale: true };
  const isoDate = toIsoDate(run.serviceDate);
  const pending = readPendingPlan(run.details);
  const kind = readRunDetails(run)?.kind ?? "optimize";
  if (!pending) return dropPendingRun(run.id, run.details, `${NOT_KEPT_PREFIX} : calcul illisible. Relancez l'optimisation.`);

  const { lockChange } = pending;
  // « Placer les non affectées » : pinned again to the routes in place (unchanged since, or the request differs).
  const assignments = pending.placeOnly ? await loadAssignments(isoDate) : null;
  const relocked = withLockChange(lockChange);
  let pinned: ReadonlySet<string> = new Set();
  // The lock a move set was undone while the plan waited (a restored one is not written yet): the request is rebuilt with it.
  const prepared = await prepareRequest(
    isoDate,
    assignments
      ? (day) => {
          const pinnedInput = pinAssignedTrips(relocked(day), assignments);
          pinned = pinnedInput.pinned;
          return pinnedInput.input;
        }
      : relocked,
  );
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
        ...auditDetails(kind, true),
      });
      if (lockChange) {
        await writeLockChange(tx, user, isoDate, lockChange, kind === "move" ? "trip.move" : lockAction(lockChange.to));
      }
      await withdrawLapsedProposals(tx, user, isoDate);
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
      lockChange: lockChange ?? undefined,
      ...(assignments ? { lockedCount: build.request.trips.filter((t) => t.lockedVehicleId && !pinned.has(t.id)).length } : {}),
      onTrafficReset: (tx) => auditTrafficReset(tx, user, run.id, isoDate),
      // Under the planning lock of the date, which discardPendingRun takes too: never both confirmed and discarded.
      check: async ({ tx, comparison, version }) => {
        const still = await tx.optimizationRun.findUnique({ where: { id: run.id }, select: { status: true } });
        if (still?.status !== "AWAITING_CONFIRMATION") throw new ReplaceRefused("gone", NOT_PENDING_ERROR);
        if (version !== pending.basedOnVersion) throw new ReplaceRefused("stale", PLAN_CHANGED_SINCE_ERROR);
        // A placement is never confirmed into taking trips off their vehicle (a plan held before this rule).
        const loss = assignments ? placementLoss(comparison.lostTripIds, build.request) : null;
        if (loss) throw new ReplaceRefused("place", `${NOT_KEPT_PREFIX} : ${loss}`);
      },
    });
  } catch (error) {
    if (error instanceof ReplaceRefused && error.reason === "gone") return { ok: false, error: error.message, stale: true };
    if (error instanceof ReplaceRefused && error.reason === "place") {
      await dropPendingRun(run.id, run.details, error.message);
      return { ok: false, error: await shownMessage(error.message) };
    }
    if (error instanceof ReplaceRefused) return dropPendingRun(run.id, run.details, error.message);
    if (error instanceof PlanBlockedError) return dropPendingRun(run.id, run.details, `${NOT_KEPT_PREFIX} : ${error.message}`);
    logError("[planning] saving a confirmed plan failed", error, { runId: run.id, serviceDate: isoDate });
    return { ok: false, error: "Le planning n'a pas pu être enregistré (erreur de base de données). Réessayez." };
  }
  const placement = assignments
    ? placementOutcome(pending.response, {
        toPlace: new Set(build.request.trips.filter((t) => !assignments.has(t.id)).map((t) => t.id)),
        assignments,
      })
    : null;
  const what = placement
    ? placementText(placement)
    : kind === "restore"
      ? "Planning précédent rétabli"
      : "Nouveau planning enregistré";
  const warning = pending.response.validation.violations.length > 0 || (placement !== null && placementWarning(placement));
  return {
    ok: true,
    runId: run.id,
    message: `${what} : ${saved.served}/${saved.served + saved.unassigned} courses servies · ${plural(saved.routes, "tournée")}.`,
    ...(warning ? { warning: true } : {}),
  };
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
 * The caller traces it (plan.discard) in `tx`. Under the planning lock of the
 * date: serialized with a confirmation of the same run (savePlan).
 */
export async function discardPendingRun(
  runId: string,
  trace: (tx: Prisma.TransactionClient, isoDate: string) => Promise<void>,
): Promise<boolean> {
  const run = await db.optimizationRun.findUnique({ where: { id: runId }, select: { status: true, details: true, serviceDate: true } });
  if (!run || run.status !== "AWAITING_CONFIRMATION") return false;
  const isoDate = toIsoDate(run.serviceDate);
  return db.$transaction(async (tx) => {
    await lockPlanningDay(tx, isoDate);
    const { count } = await tx.optimizationRun.updateMany({
      where: { id: runId, status: "AWAITING_CONFIRMATION" },
      data: { status: "FAILED", error: `${NOT_KEPT_PREFIX} : le planning en place a été conservé.`, details: withoutPending(run.details) },
    });
    if (count > 0) await trace(tx, isoDate);
    return count > 0;
  }, PLANNING_TX_OPTIONS);
}
