/**
 * Real planning time of a date (KPI-06), read from the audit trail. Pure.
 *
 * The wall clock from the first optimization to the last validation counted
 * the evening, the night and a reopening on the day itself (a day validated at
 * 17:30, reopened at 06:45 the next morning for a call and validated again at
 * 06:55 read 13 h 25), or the days between an optimization made on Friday and
 * the validation of Monday's planning on Sunday. Here:
 *
 * - The regulators' actions on the date (plan.optimize, trip.move, trip.lock,
 *   the sharing answers, plan.validate…, PLANNING_ACTIONS; the click on
 *   « Optimiser » is the run's start) are cut into sessions, per person,
 *   wherever nothing happened for SESSION_IDLE_MIN minutes. A session that
 *   only reads (plan.view: the planning opened to watch the day) is not
 *   planning work; one that changes something counts from its first event,
 *   the reading before the change included, and lasts at least
 *   MIN_SESSION_MINUTES (a lone click still took a moment).
 * - The initial build is the active time up to the first validation of the
 *   date; what comes after it (a reopening, a trip moved on the day itself, a
 *   new validation) are the touch-ups. A date never validated has no measured
 *   build yet (« — »): its time so far is shown apart.
 * - Interventions after the first optimization: trips moved, locks set or
 *   removed (a trip or a route, a depot, the day), re-optimizations. The
 *   recomputation a « Déplacer vers… » triggers belongs to its move
 *   (plan.optimize within MOVE_RECOMPUTE_MIN minutes after a trip.move of the
 *   same person) and is not a re-optimization.
 *
 * A period reads the median of its days (a reopened day does not drag the
 * figure as a mean would).
 */
import type { KpiActivity, KpiRun } from "./kpis-rows";
import { quantile } from "./kpis-rows";

/** Minutes without an action after which a session ends. */
export const SESSION_IDLE_MIN = 15;
/** A session that changed something lasts at least this (minutes). */
export const MIN_SESSION_MINUTES = 1;
/** A plan.optimize this soon after a trip.move of the same person is the move's recomputation. */
export const MOVE_RECOMPUTE_MIN = 5;

/** Reads of the planning of a date: they extend a working session, never start one alone. */
const VIEW_ACTIONS = ["plan.view", "trip_list.view", "trip.view", "day_crew.view"] as const;
const OPTIMIZE_ACTIONS = ["plan.optimize", "plan.restore"] as const;
const LOCK_ACTIONS = ["trip.lock", "trip.unlock", "plan.lock", "plan.unlock"] as const;
/** Other changes a regulator makes to the planning of a date. */
const CHANGE_ACTIONS = [
  "plan.validate",
  "plan.reopen",
  "plan.discard",
  "trip.move",
  "trip.sharing_accept",
  "trip.sharing_refuse",
  "trip.cancel",
  "trip.restore",
  "trip.create",
  "trip.update",
  "trip.reschedule",
  "trip.toll",
  "trip.exceptional_ambulance",
  "trip.exceptional_ambulance_withdrawn",
  "route.crew_change",
  "day_crew.save",
  "day_crew.unfix",
  "day_crew.reset",
] as const;

/**
 * The actions read from the audit trail (role REGULATOR, the date as service
 * date). Left out: the automatic ones (trip.generate, trip.revive,
 * trip.detach), the drivers' statuses (stop.*) and the referential.
 */
export const PLANNING_ACTIONS: readonly string[] = [...VIEW_ACTIONS, ...OPTIMIZE_ACTIONS, ...LOCK_ACTIONS, ...CHANGE_ACTIONS];

const VIEWS = new Set<string>(VIEW_ACTIONS);
const LOCKS = new Set<string>(LOCK_ACTIONS);
const OPTIMIZES = new Set<string>(OPTIMIZE_ACTIONS);
/** The start of an optimization run (the click), merged with the trail. */
const RUN_START = "run.start";

export type Interventions = { moves: number; locks: number; reoptimizations: number };

export type DayPlanningTime = {
  /** Active minutes up to the first validation; null while the date was never validated. */
  initialMinutes: number | null;
  /** Active minutes after the first validation (reopenings, changes, new validations). */
  touchUpMinutes: number;
  /** Active minutes of a date not validated yet (its build so far); 0 once validated. */
  pendingMinutes: number;
  /** Working sessions (a session cut by the first validation counts once). */
  sessions: number;
  /** Changes made after the first optimization. */
  interventions: Interventions;
  firstValidationAt: Date | null;
};

type Point = { at: number; action: string; userId: string };

function emptyInterventions(): Interventions {
  return { moves: 0, locks: 0, reoptimizations: 0 };
}

export function addInterventions(a: Interventions, b: Interventions): Interventions {
  return { moves: a.moves + b.moves, locks: a.locks + b.locks, reoptimizations: a.reoptimizations + b.reoptimizations };
}

export function interventionCount(i: Interventions): number {
  return i.moves + i.locks + i.reoptimizations;
}

/**
 * Planning time of one date from its actions and its runs (only those of the
 * date are passed). Null when nothing was recorded: the date was planned
 * before the audit trail, or not at all.
 */
export function planningTimeOfDay(activity: readonly KpiActivity[], runs: readonly KpiRun[] = []): DayPlanningTime | null {
  const points: Point[] = [
    ...activity.map((a) => ({ at: a.at.getTime(), action: a.action, userId: a.userId ?? "?" })),
    ...runs.map((r) => ({ at: r.startedAt.getTime(), action: RUN_START, userId: r.requestedById ?? "?" })),
  ].sort((a, b) => a.at - b.at || a.action.localeCompare(b.action));
  if (!points.some((p) => !VIEWS.has(p.action))) return null;

  const validations = points.filter((p) => p.action === "plan.validate");
  const firstValidation = validations[0]?.at ?? null;

  // Sessions per person: their actions cut wherever SESSION_IDLE_MIN minutes passed without one.
  let initial = 0;
  let after = 0;
  let sessions = 0;
  const byUser = new Map<string, Point[]>();
  for (const point of points) {
    const list = byUser.get(point.userId);
    if (list) list.push(point);
    else byUser.set(point.userId, [point]);
  }
  const idle = SESSION_IDLE_MIN * 60_000;
  for (const list of byUser.values()) {
    let session: Point[] = [];
    const close = () => {
      if (session.length > 0 && session.some((p) => !VIEWS.has(p.action))) {
        sessions += 1;
        const start = session[0]!.at;
        const lastAt = session[session.length - 1]!.at;
        const end = Math.max(lastAt, start + MIN_SESSION_MINUTES * 60_000);
        // A session that ends with the validation is all initial build, its minimum length included.
        if (firstValidation === null || lastAt <= firstValidation) initial += end - start;
        else if (start >= firstValidation) after += end - start;
        else {
          initial += firstValidation - start;
          after += end - firstValidation;
        }
      }
      session = [];
    };
    for (const point of list) {
      const last = session[session.length - 1];
      if (last && point.at - last.at > idle) close();
      session.push(point);
    }
    close();
  }

  return {
    initialMinutes: firstValidation === null ? null : initial / 60_000,
    touchUpMinutes: after / 60_000,
    pendingMinutes: firstValidation === null ? initial / 60_000 : 0,
    sessions,
    interventions: interventionsOf(points),
    firstValidationAt: firstValidation === null ? null : new Date(firstValidation),
  };
}

/** Moves, locks and re-optimizations after the first plan.optimize (a move's own recomputation excluded). */
function interventionsOf(points: readonly Point[]): Interventions {
  const result = emptyInterventions();
  const firstOptimize = points.find((p) => OPTIMIZES.has(p.action));
  if (!firstOptimize) return result;
  const lastMove = new Map<string, number>();
  for (const point of points) {
    if (point.at < firstOptimize.at || point === firstOptimize) continue;
    if (point.action === "trip.move") {
      result.moves += 1;
      lastMove.set(point.userId, point.at);
    } else if (LOCKS.has(point.action)) {
      result.locks += 1;
    } else if (OPTIMIZES.has(point.action)) {
      const moveAt = lastMove.get(point.userId);
      if (point.action === "plan.optimize" && moveAt !== undefined && point.at - moveAt <= MOVE_RECOMPUTE_MIN * 60_000) {
        lastMove.delete(point.userId);
        continue;
      }
      result.reoptimizations += 1;
    }
  }
  return result;
}

/** Planning time of a period: the measured days, their medians and the interventions summed. */
export type PlanningTimeTotals = {
  /** Initial build of each date validated with recorded actions (minutes). */
  initial: number[];
  /** Touch-ups of the same dates (minutes). */
  touchUps: number[];
  /** Dates with recorded actions (validated or not). */
  measuredDays: number;
  interventions: Interventions;
  /** Interventions of the validated dates (the per-day ratio). */
  validatedInterventions: number;
};

export function emptyPlanningTime(): PlanningTimeTotals {
  return { initial: [], touchUps: [], measuredDays: 0, interventions: emptyInterventions(), validatedInterventions: 0 };
}

export function addPlanningTime(sum: PlanningTimeTotals, day: DayPlanningTime | null): PlanningTimeTotals {
  if (!day) return sum;
  const validated = day.initialMinutes !== null;
  return {
    initial: validated ? [...sum.initial, day.initialMinutes ?? 0] : sum.initial,
    touchUps: validated ? [...sum.touchUps, day.touchUpMinutes] : sum.touchUps,
    measuredDays: sum.measuredDays + 1,
    interventions: addInterventions(sum.interventions, day.interventions),
    validatedInterventions: sum.validatedInterventions + (validated ? interventionCount(day.interventions) : 0),
  };
}

/** Median initial build of the validated dates (minutes), null when none. */
export function medianInitialMinutes(t: Pick<PlanningTimeTotals, "initial">): number | null {
  return quantile(t.initial, 0.5);
}

export function medianTouchUpMinutes(t: Pick<PlanningTimeTotals, "touchUps">): number | null {
  return quantile(t.touchUps, 0.5);
}
