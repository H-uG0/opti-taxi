/**
 * Version of the planning of a date: what the regulator saw, so that an
 * action taken on a stale page (another regulator or another tab
 * re-optimized, a trip was cancelled, a lock changed…) is refused instead of
 * validating a plan nobody looked at. Also the cheap state polled by the
 * planning page while a computation runs (route handler planning/version).
 *
 * The version is a hash of the date's routes, stops and trips (counts and
 * last update): any write through Prisma moves an updatedAt, a deletion
 * moves a count. Runs are not part of it (a failed run changes no plan);
 * the latest run is reported apart (`run`, `running`).
 *
 * Pure helpers plus loaders taking the Prisma client as a parameter: no
 * server-only import, so the route handler, the page and the actions share it.
 */
import { createHash } from "node:crypto";
import type { OptimizationRunStatus, Prisma, PrismaClient } from "@prisma/client";
import { isStaleRun } from "@/lib/optimizer/build-request";
import { fromIsoDate } from "@/lib/time";

/** What the version is computed from. */
export type PlanVersionParts = {
  routes: number;
  routesAt: Date | null;
  stops: number;
  trips: number;
  tripsAt: Date | null;
};

/** The latest run of the date (any status). */
export type LatestRun = { id: string; status: OptimizationRunStatus; startedAt: Date; tripsCount: number };

/** Polled by the planning page: no patient data, only opaque tokens and a flag. */
export type DayVersion = {
  version: string;
  /** Token of the latest run (id and status), null when the date has none. */
  run: string | null;
  /** A computation of the date is running now (an interrupted one does not count). */
  running: boolean;
};

export const STALE_PLAN_ERROR = "Le planning a changé depuis l'affichage : rechargez la page.";

function token(text: string): string {
  return createHash("sha256").update(text).digest("base64url").slice(0, 16);
}

export function planVersionToken(parts: PlanVersionParts): string {
  return token(
    [parts.routes, parts.routesAt?.getTime() ?? 0, parts.stops, parts.trips, parts.tripsAt?.getTime() ?? 0].join("|"),
  );
}

export function runToken(run: Pick<LatestRun, "id" | "status"> | null): string | null {
  return run ? token(`${run.id}|${run.status}`) : null;
}

/** Live RUNNING run: same rule as runOptimization's stale-run cleanup (isStaleRun). */
export function isRunning(run: LatestRun | null, solverTimeLimitSec: number, now: Date): boolean {
  return run !== null && run.status === "RUNNING" && !isStaleRun(run, solverTimeLimitSec, now);
}

type RawClient = Pick<PrismaClient, "$queryRaw"> | Pick<Prisma.TransactionClient, "$queryRaw">;

/** Version of the plan of isoDate, read in one statement (usable inside a transaction). */
export async function loadPlanVersion(client: RawClient, isoDate: string): Promise<string> {
  const rows = await client.$queryRaw<PlanVersionParts[]>`
    SELECT
      (SELECT count(*)::int FROM "Route" WHERE "serviceDate" = ${isoDate}::date) AS "routes",
      (SELECT max("updatedAt") FROM "Route" WHERE "serviceDate" = ${isoDate}::date) AS "routesAt",
      (SELECT count(*)::int FROM "RouteStop" s JOIN "Route" r ON r."id" = s."routeId"
        WHERE r."serviceDate" = ${isoDate}::date) AS "stops",
      (SELECT count(*)::int FROM "Trip" WHERE "serviceDate" = ${isoDate}::date) AS "trips",
      (SELECT max("updatedAt") FROM "Trip" WHERE "serviceDate" = ${isoDate}::date) AS "tripsAt"`;
  const parts = rows[0] ?? { routes: 0, routesAt: null, stops: 0, trips: 0, tripsAt: null };
  return planVersionToken(parts);
}

/** Version, latest run and running flag of isoDate (no write: the settings row is only read). */
export async function loadDayVersion(
  prisma: Pick<PrismaClient, "$queryRaw" | "optimizationRun" | "appSettings">,
  isoDate: string,
  now: Date = new Date(),
): Promise<DayVersion> {
  const serviceDate = fromIsoDate(isoDate);
  const [version, run, settings] = await Promise.all([
    loadPlanVersion(prisma, isoDate),
    prisma.optimizationRun.findFirst({
      where: { serviceDate },
      orderBy: { startedAt: "desc" },
      select: { id: true, status: true, startedAt: true, tripsCount: true },
    }),
    prisma.appSettings.findUnique({ where: { id: 1 }, select: { solverTimeLimitSec: true } }),
  ]);
  // Without a settings row yet, the schema default (AppSettings.solverTimeLimitSec).
  return { version, run: runToken(run), running: isRunning(run, settings?.solverTimeLimitSec ?? 10, now) };
}
