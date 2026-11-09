/**
 * Demo mode (DEMO_MODE=1): the app runs on the fictitious data set of the seed,
 * whose accounts have passwords published in the README. Pure module (no
 * Next.js or database import): the root layout (banner), the startup check
 * (src/instrumentation.ts) and the seed share it; apps/web/docker/start.sh
 * applies the same DEMO_MODE=1 rule before loading the seed.
 *
 * - DEMO_MODE=1, set on purpose (docker-compose.yml, the online demo): the
 *   Docker image loads the seed on an empty database and every page shows the
 *   « DÉMO — données fictives » banner.
 * - Unset (production): the image never loads the seed, and the server
 *   refuses to start in production while an account of the seed's domain
 *   exists (demoAccountsProblem): its password is public.
 */

/** Domain of every account the seed creates (.test is reserved, never delivered). */
export const DEMO_EMAIL_DOMAIN = "@opti-taxi.test";

type DemoEnv = { DEMO_MODE?: string; NODE_ENV?: string };

/** True only for DEMO_MODE=1 exactly: any other value, or none, is production behaviour. */
export function isDemoMode(env: DemoEnv = process.env): boolean {
  return env.DEMO_MODE?.trim() === "1";
}

/**
 * Why the server may not start: in production outside demo mode, `demoAccounts`
 * accounts of the seed's domain exist. Null when it may. The message never
 * names an account.
 */
export function demoAccountsProblem(env: DemoEnv, demoAccounts: number): string | null {
  if (env.NODE_ENV !== "production" || isDemoMode(env) || demoAccounts === 0) return null;
  const accounts = demoAccounts > 1 ? `${demoAccounts} accounts` : "1 account";
  return (
    `${accounts} with an e-mail ending in ${DEMO_EMAIL_DOMAIN} exist: the seed's demo accounts, whose passwords are ` +
    "public (README). Refused in production: delete them (or start from an empty database), or set DEMO_MODE=1 " +
    "for a demo instance holding fictitious data only."
  );
}

/**
 * Startup check (src/instrumentation.ts, Node.js runtime). `countDemoAccounts`
 * counts the accounts of DEMO_EMAIL_DOMAIN; it is only called when the rule
 * applies (production outside demo mode). Like checkSessionSecretAtStartup,
 * the process stops in production (`next start` does not await register()).
 * A database that cannot be read stops it too: the check must not be skipped
 * silently (the Docker entrypoint has just applied the migrations, so the
 * database answers at this point; a restart retries).
 */
export async function checkDemoAccountsAtStartup(
  countDemoAccounts: () => Promise<number>,
  env: DemoEnv = process.env,
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
  if (env.NODE_ENV !== "production" || isDemoMode(env)) return;
  let count: number;
  try {
    count = await countDemoAccounts();
  } catch {
    console.error("[startup] Could not check the database for demo accounts (database unreachable?): stopping.");
    exit(1);
    return;
  }
  const problem = demoAccountsProblem(env, count);
  if (!problem) return;
  console.error(`[startup] ${problem}`);
  exit(1);
}
