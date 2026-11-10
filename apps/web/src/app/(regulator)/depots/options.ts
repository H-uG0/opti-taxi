import "server-only";
import { db } from "@/lib/db";

export type DepotOption = { id: string; name: string; address: string; active: boolean };

/**
 * Depots offered in the vehicle and driver forms: the active ones, plus the
 * one already chosen (`keepId`) even if it was deactivated since.
 */
export async function loadDepotOptions(keepId: string | null = null): Promise<DepotOption[]> {
  return db.depot.findMany({
    where: keepId ? { OR: [{ active: true }, { id: keepId }] } : { active: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, address: true, active: true },
  });
}

/** Why `depotId` cannot be chosen (unknown, or deactivated and not already the current one), or null. */
export async function depotChoiceError(depotId: string | null, currentId: string | null): Promise<string | null> {
  if (depotId === null) return null;
  const depot = await db.depot.findUnique({ where: { id: depotId }, select: { name: true, active: true } });
  if (!depot) return "Dépôt introuvable\u00a0: rechargez la page.";
  if (!depot.active && depotId !== currentId) return `Le dépôt ${depot.name} est désactivé.`;
  return null;
}
