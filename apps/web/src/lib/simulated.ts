/**
 * Rows written by the history simulation (pnpm db:history, prisma/history/):
 * their ids start with SIMULATED_ID_PREFIX. The dashboard and the planning
 * mark the days it produced « simulé », so that its figures are never taken
 * for measurements. Pure module, shared with the script.
 */
export const SIMULATED_ID_PREFIX = "hist-";

export function isSimulatedId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(SIMULATED_ID_PREFIX);
}
