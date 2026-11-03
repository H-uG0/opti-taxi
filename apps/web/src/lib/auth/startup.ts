import { sessionSecretProblem } from "./secret";

/**
 * Startup check of SESSION_SECRET, run by src/instrumentation.ts (Node.js
 * runtime only: this module calls process.exit). `next start` runs register()
 * without awaiting it, so a throw would leave the server listening and failing
 * every request: in production the process stops instead, after logging the
 * rule broken (never the secret). `next dev` awaits register(): a throw stops it.
 */
export function checkSessionSecretAtStartup(
  env: { SESSION_SECRET?: string; NODE_ENV?: string } = process.env,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  const problem = sessionSecretProblem(env.SESSION_SECRET, env.NODE_ENV);
  if (!problem) return;
  console.error(`[startup] ${problem}`);
  if (env.NODE_ENV === "production") exit(1);
  throw new Error(problem);
}
