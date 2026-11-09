/**
 * Whether a date was produced by the history simulation (pnpm db:history):
 * one of its optimization runs is stored for the date (ids prefixed with
 * SIMULATED_ID_PREFIX, lib/simulated.ts). Courses, Équipages and Arrivées
 * partagées mark such a date « Journée simulée », as the planning and the
 * dashboard do, so that its statuses and answers are never taken for field data.
 */
import "server-only";
import { db } from "@/lib/db";
import { SIMULATED_ID_PREFIX } from "@/lib/simulated";
import { fromIsoDate } from "@/lib/time";

export async function isSimulatedDay(isoDate: string): Promise<boolean> {
  const run = await db.optimizationRun.findFirst({
    where: { serviceDate: fromIsoDate(isoDate), id: { startsWith: SIMULATED_ID_PREFIX } },
    select: { id: true },
  });
  return run !== null;
}
