/**
 * Safety: the history script deletes and rewrites trips, routes and runs, so,
 * like the seed (prisma/seed.ts), it only runs against a local database.
 * Same rules as the seed: never with NODE_ENV=production, DATABASE_URL must
 * point to this machine or to the docker-compose service, unless
 * SEED_ALLOW_WIPE=1 is set on purpose for a remote development database.
 */
import { HistoryError } from "./errors";

/** Hosts considered local: this machine, or the PostgreSQL service of docker-compose. */
const LOCAL_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres"]);

/** The environment variables the check reads. */
export type DatabaseEnv = { NODE_ENV?: string; DATABASE_URL?: string; SEED_ALLOW_WIPE?: string };

/** Returns the target ("database on host:port") for display; never the credentials. */
export function assertDevelopmentDatabase(env: DatabaseEnv = process.env): string {
  if (env.NODE_ENV === "production") {
    throw new HistoryError("Refus : la simulation d'historique ne s'exécute jamais avec NODE_ENV=production.");
  }
  const raw = env.DATABASE_URL;
  if (!raw) throw new HistoryError("Refus : DATABASE_URL n'est pas défini, impossible de vérifier la base cible.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HistoryError("Refus : DATABASE_URL n'est pas une URL valide, impossible de vérifier la base cible.");
  }
  // A `host` query parameter (Unix socket) takes precedence over the URL host.
  const host = (url.searchParams.get("host") ?? url.hostname).toLowerCase();
  const database = decodeURIComponent(url.pathname.replace(/^\//, "")) || "(base par défaut)";
  const target = `${database} sur ${host || "(hôte vide)"}${url.port ? `:${url.port}` : ""}`;
  if (!LOCAL_DATABASE_HOSTS.has(host) && env.SEED_ALLOW_WIPE !== "1") {
    throw new HistoryError(
      `Refus : la base cible (${target}) n'est pas locale. La simulation remplace les courses, tournées et ` +
        "optimisations des jours passés qu'elle a créées. Pour une base de développement distante, relancer avec SEED_ALLOW_WIPE=1.",
    );
  }
  return target;
}
