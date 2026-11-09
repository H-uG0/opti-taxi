/**
 * Details of a finished optimization run (solver status, violation list,
 * optimizer warnings, reason of each unassigned trip), stored in the
 * OptimizationRun.details JSON column: they survive a server restart and are
 * the same on every server instance. OptimizationRun.kpis holds exactly the
 * optimizer KPIs (PlanResponse.kpis).
 *
 * Runs saved before the details column existed kept the details inside the
 * kpis JSON, under a `details` key: they are still read from there. Runs
 * saved without details decode to null.
 */
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import type { PlanComparison, PlanSnapshot } from "@/lib/planning/plan-compare";
import { planResponseSchema, unassignedSchema, violationSchema, type PlanResponse, type Violation } from "./contract";

/** What produced a run: « Optimiser », « Déplacer vers… » or « Revenir au planning précédent ». */
export type RunKind = "optimize" | "move" | "restore";

export type RunDetails = {
  runId: string;
  solverStatus: string;
  /** Hard-rule violations of the plan; after a trip left its route, those of the re-evaluated plan (evaluatedAt). */
  violations: Violation[];
  warnings: string[];
  unassigned: Array<{ tripId: string; reason: string }>;
  /** Runs saved before traffic existed have none. */
  trafficSource?: string;
  /** Runs saved before the replanning guard have none. */
  kind?: RunKind;
  /** The new plan against the routes it was to replace (lib/planning/plan-compare.ts). */
  comparison?: PlanComparison;
  /** Stop sequences of the routes this run replaced: « Revenir au planning précédent ». */
  previous?: PlanSnapshot;
  /** When /evaluate last re-checked the plan (a trip left a route): the violations are those of that check. */
  evaluatedAt?: string;
  /** Run waiting for confirmation: the question asked (trips named by tripRef, see move.ts). */
  question?: string;
};

/**
 * A computed plan waiting for the regulator's confirmation (run status
 * AWAITING_CONFIRMATION): what « Remplacer quand même » saves, once checked
 * that neither the day's data (requestHash) nor its plan (basedOnVersion)
 * changed since. Dropped from the details once confirmed or discarded.
 */
export type PendingPlan = {
  response: PlanResponse;
  /** lib/planning/pending.ts requestHash of the request sent. */
  requestHash: string;
  /** Plan version (lib/planning/version.ts) of the routes it was compared with. */
  basedOnVersion: string;
  /** « Déplacer vers… »: the lock to set again when confirmed. */
  move: { tripId: string; vehicleId: string; vehicleLabel: string } | null;
};

/** The OptimizationRun columns the details are read from. */
export type StoredRun = {
  id: string;
  details: Prisma.JsonValue | null;
  kpis: Prisma.JsonValue | null;
};

const figuresSchema = z.object({
  served: z.number(),
  violations: z.number().nullable(),
  revenue: z.number(),
  margin: z.number(),
  km: z.number(),
});

const comparisonSchema = z.object({
  current: figuresSchema.nullable(),
  next: figuresSchema,
  lostTripIds: z.array(z.string()),
});

const stopKindSchema = z.enum(["PICKUP", "DROPOFF"]);

const snapshotSchema = z.object({
  runId: z.string().nullable(),
  figures: figuresSchema,
  routes: z.array(z.object({ vehicleId: z.string(), stops: z.array(z.object({ tripId: z.string(), kind: stopKindSchema })) })),
});

const detailsSchema = z.object({
  solverStatus: z.string(),
  violations: z.array(violationSchema),
  warnings: z.array(z.string()),
  unassigned: z.array(unassignedSchema),
  trafficSource: z.string().optional(),
  kind: z.enum(["optimize", "move", "restore"]).optional(),
  comparison: comparisonSchema.optional(),
  previous: snapshotSchema.optional(),
  evaluatedAt: z.string().optional(),
  question: z.string().optional(),
});

const pendingSchema = z.object({
  response: planResponseSchema,
  requestHash: z.string(),
  basedOnVersion: z.string(),
  move: z.object({ tripId: z.string(), vehicleId: z.string(), vehicleLabel: z.string() }).nullable(),
});

/** Legacy layout: the optimizer KPIs plus the details under the `details` key. */
const legacyKpisSchema = z.object({ details: detailsSchema });

/** What a run's details carry besides the optimizer's answer. */
export type RunDetailsExtra = {
  kind?: RunKind;
  comparison?: PlanComparison;
  previous?: PlanSnapshot;
  question?: string;
  pending?: PendingPlan;
};

/** JSON written to OptimizationRun.details. */
export function runDetailsJson(
  response: Pick<PlanResponse, "validation" | "meta" | "unassigned">,
  extra: RunDetailsExtra = {},
): Prisma.InputJsonObject {
  const json: Record<string, unknown> = {
    solverStatus: response.meta.solverStatus,
    violations: response.validation.violations,
    warnings: response.meta.warnings,
    unassigned: response.unassigned,
    trafficSource: response.meta.trafficSource,
  };
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) json[key] = value;
  // The values are plain JSON (zod-checked contract objects, numbers, strings).
  return json as Prisma.InputJsonObject;
}

/** The plan waiting for confirmation in a run's details, or null (none, or unreadable). */
export function readPendingPlan(details: Prisma.JsonValue | null): PendingPlan | null {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const parsed = pendingSchema.safeParse((details as Record<string, unknown>).pending);
  return parsed.success ? parsed.data : null;
}

/** The details without the pending plan (once confirmed or discarded): the comparison stays for the record. */
export function withoutPending(details: Prisma.JsonValue | null): Prisma.InputJsonObject {
  if (!details || typeof details !== "object" || Array.isArray(details)) return {};
  const rest: Record<string, unknown> = { ...(details as Record<string, unknown>) };
  delete rest.pending;
  return rest as Prisma.InputJsonObject;
}

/**
 * Details of a stored run: its details column, else (runs saved before that
 * column) the `details` key of its kpis JSON. Null when absent or unreadable.
 */
export function readRunDetails(run: StoredRun): RunDetails | null {
  const stored = detailsSchema.safeParse(run.details);
  if (stored.success) return { runId: run.id, ...stored.data };
  const legacy = legacyKpisSchema.safeParse(run.kpis);
  return legacy.success ? { runId: run.id, ...legacy.data.details } : null;
}
