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
import { unassignedSchema, violationSchema, type PlanResponse, type Violation } from "./contract";

export type RunDetails = {
  runId: string;
  solverStatus: string;
  violations: Violation[];
  warnings: string[];
  unassigned: Array<{ tripId: string; reason: string }>;
};

/** The OptimizationRun columns the details are read from. */
export type StoredRun = {
  id: string;
  details: Prisma.JsonValue | null;
  kpis: Prisma.JsonValue | null;
};

const detailsSchema = z.object({
  solverStatus: z.string(),
  violations: z.array(violationSchema),
  warnings: z.array(z.string()),
  unassigned: z.array(unassignedSchema),
});

/** Legacy layout: the optimizer KPIs plus the details under the `details` key. */
const legacyKpisSchema = z.object({ details: detailsSchema });

/** JSON written to OptimizationRun.details. */
export function runDetailsJson(
  response: Pick<PlanResponse, "validation" | "meta" | "unassigned">,
): Prisma.InputJsonObject {
  return {
    solverStatus: response.meta.solverStatus,
    violations: response.validation.violations,
    warnings: response.meta.warnings,
    unassigned: response.unassigned,
  };
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
