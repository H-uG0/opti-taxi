/**
 * What a planning server action answers when it fails unexpectedly. Pure:
 * shared by the actions and their tests.
 *
 * Without this, a database error (a transaction that waited too long for the
 * row locks of a re-optimization, a lost connection to PostgreSQL) reached the
 * browser as a failed request, which the page could only read as « connexion
 * au serveur perdue ? ». The actions now answer { ok: false } with what
 * happened; the error itself is logged without its query (lib/log.ts).
 */
import { isConcurrentWriteError } from "./detach";

export const PLAN_CHANGED_ERROR = "Le planning a changé entre-temps\u00a0: rechargez la page.";

export const DATABASE_ERROR =
  "La base de données n'a pas répondu à temps\u00a0: l'action n'a pas été enregistrée. Réessayez dans un instant.";

export const UNEXPECTED_ERROR =
  "Erreur inattendue sur le serveur\u00a0: l'action n'a peut-être pas abouti. Rechargez la page pour voir l'état réel du planning.";

/** A Prisma client error (duck-typed: no Prisma value is imported). */
function isDatabaseError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name } = error as { name?: unknown };
  return typeof name === "string" && name.startsWith("PrismaClient");
}

/** French message for an error thrown by a planning action. */
export function planningErrorMessage(error: unknown): string {
  if (isConcurrentWriteError(error)) return PLAN_CHANGED_ERROR;
  if (isDatabaseError(error)) return DATABASE_ERROR;
  return UNEXPECTED_ERROR;
}
