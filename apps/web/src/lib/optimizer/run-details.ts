/**
 * Details of a finished optimization run that have no column of their own
 * (violation list, optimizer warnings, reason of each unassigned trip).
 *
 * They are stored in the OptimizationRun.kpis JSON, next to the optimizer
 * KPIs, under the `details` key: they survive a server restart and are the
 * same on every server instance. Only this module knows that layout, so a
 * dedicated `details Json?` column can replace it without touching callers.
 * Runs saved before the details were stored decode to null.
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

const storedRunSchema = z.object({
  details: z.object({
    solverStatus: z.string(),
    violations: z.array(violationSchema),
    warnings: z.array(z.string()),
    unassigned: z.array(unassignedSchema),
  }),
});

/** JSON written to OptimizationRun.kpis: the optimizer KPIs plus the run details. */
export function runKpisJson(
  response: Pick<PlanResponse, "kpis" | "validation" | "meta" | "unassigned">,
): Prisma.InputJsonObject {
  const details = {
    solverStatus: response.meta.solverStatus,
    violations: response.validation.violations,
    warnings: response.meta.warnings,
    unassigned: response.unassigned,
  };
  return { ...response.kpis, details } as Prisma.InputJsonObject;
}

/** Details of run `runId` from its stored kpis JSON, or null when absent or unreadable. */
export function readRunDetails(runId: string, kpis: Prisma.JsonValue | null | undefined): RunDetails | null {
  const parsed = storedRunSchema.safeParse(kpis);
  return parsed.success ? { runId, ...parsed.data.details } : null;
}
