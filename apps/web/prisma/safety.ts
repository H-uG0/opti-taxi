/**
 * Development-database guard of the scripts that erase or rewrite data: the
 * seed (prisma/seed.ts wipes everything), the reset (prisma/reset.ts, before
 * prisma migrate reset drops the database) and the history simulation
 * (prisma/history.ts replaces the past days it created). Pure, unit-tested;
 * the one query it needs is passed in by the caller.
 *
 * 1. Never with NODE_ENV=production.
 * 2. DATABASE_URL must point to this machine. The docker-compose PostgreSQL is
 *    published on localhost:5433 and no script of the workflow runs inside
 *    the compose network, so its service name ("postgres") is not trusted.
 * 3. The database must hold only the seed's accounts (e-mail ending in
 *    @opti-taxi.test): any other account is a sign it is not a seed-only
 *    database (accounts created by hand, a copy of real data).
 *
 * SEED_ALLOW_WIPE=1, set on purpose, lifts 2 and 3 (a remote development
 * database, an account added for a test); nothing lifts 1.
 */
import type { Prisma } from "@prisma/client";
import { SEED_EMAIL_DOMAIN } from "./seed/identity";

/** Refusal of the guard: its French message is printed alone, without a stack trace. */
export class UnsafeDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeDatabaseError";
  }
}

/** Hosts considered local: this machine only. */
const LOCAL_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** The environment variables the guard reads. */
export type DatabaseEnv = { NODE_ENV?: string; DATABASE_URL?: string; SEED_ALLOW_WIPE?: string };

export type GuardedScript = "seed" | "history" | "reset";

const SCRIPTS: Record<GuardedScript, { name: string; effect: string }> = {
  seed: { name: "le seed", effect: "Le seed efface toutes les données (patients, courses, comptes, journal d'audit)." },
  reset: {
    name: "la réinitialisation",
    effect: "pnpm db:reset supprime et recrée toute la base (prisma migrate reset), puis lance le seed.",
  },
  history: {
    name: "la simulation d'historique",
    effect: "La simulation remplace les courses, tournées, optimisations et événements d'audit des jours passés qu'elle a créés.",
  },
};

/** Accounts the seed did not create (e-mail outside its domain, whatever the case). */
export const FOREIGN_ACCOUNTS_WHERE = {
  NOT: { email: { endsWith: SEED_EMAIL_DOMAIN, mode: "insensitive" } },
} as const satisfies Prisma.UserWhereInput;

function allowed(env: DatabaseEnv): boolean {
  return env.SEED_ALLOW_WIPE === "1";
}

/**
 * Checks 1 and 2 (before any query). Returns the target ("database sur
 * host:port") for display; never the credentials.
 */
export function assertDevelopmentDatabase(script: GuardedScript, env: DatabaseEnv = process.env): string {
  const { name, effect } = SCRIPTS[script];
  if (env.NODE_ENV === "production") {
    throw new UnsafeDatabaseError(`Refus : ${name} ne s'exécute jamais avec NODE_ENV=production. ${effect}`);
  }
  const raw = env.DATABASE_URL;
  if (!raw) throw new UnsafeDatabaseError("Refus : DATABASE_URL n'est pas défini, impossible de vérifier la base cible.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeDatabaseError("Refus : DATABASE_URL n'est pas une URL valide, impossible de vérifier la base cible.");
  }
  // A `host` query parameter (Unix socket) takes precedence over the URL host.
  const host = (url.searchParams.get("host") ?? url.hostname).toLowerCase();
  const database = decodeURIComponent(url.pathname.replace(/^\//, "")) || "(base par défaut)";
  const target = `${database} sur ${host || "(hôte vide)"}${url.port ? `:${url.port}` : ""}`;
  if (!LOCAL_DATABASE_HOSTS.has(host) && !allowed(env)) {
    throw new UnsafeDatabaseError(
      `Refus : la base cible (${target}) n'est pas locale. ${effect} ` +
        "Pour une base de développement distante, relancer avec SEED_ALLOW_WIPE=1.",
    );
  }
  return target;
}

/** Check 3, from the number of accounts matching FOREIGN_ACCOUNTS_WHERE. */
export function assertSeedAccountsOnly(
  script: GuardedScript,
  foreignAccounts: number,
  target: string,
  env: DatabaseEnv = process.env,
): void {
  if (foreignAccounts === 0 || allowed(env)) return;
  const accounts = foreignAccounts > 1 ? `${foreignAccounts} comptes dont l'e-mail` : "1 compte dont l'e-mail";
  throw new UnsafeDatabaseError(
    `Refus : la base cible (${target}) contient ${accounts} ne se termine pas par ${SEED_EMAIL_DOMAIN} : ` +
      `ce n'est pas une base créée par le seed. ${SCRIPTS[script].effect} ` +
      "Si c'est bien une base de développement, relancer avec SEED_ALLOW_WIPE=1.",
  );
}

/**
 * The whole guard: checks 1 and 2, then counts the foreign accounts with
 * `countUsers` (e.g. `(where) => prisma.user.count({ where })`) for check 3.
 * Returns the target for display.
 */
export async function assertSeedOnlyDatabase(
  script: GuardedScript,
  countUsers: (where: Prisma.UserWhereInput) => Promise<number>,
  env: DatabaseEnv = process.env,
): Promise<string> {
  const target = assertDevelopmentDatabase(script, env);
  assertSeedAccountsOnly(script, await countUsers(FOREIGN_ACCOUNTS_WHERE), target, env);
  return target;
}
