/**
 * Shared secret between the web app and the optimizer (OPTIMIZER_TOKEN). The
 * optimizer's requests carry patients' home coordinates and appointments, and
 * one /optimize call ties up a core and gigabytes of memory for a minute: when
 * the service has a token, it answers 401 to any request without the same one
 * (services/optimizer/app/security.py). Optional so that a development setup
 * without it works as before; production sets it on both services (README).
 * Pure module: lib/optimizer/client.ts (Next.js), the history script and the
 * startup warning share it.
 */

type TokenEnv = { OPTIMIZER_TOKEN?: string; NODE_ENV?: string };

/** The configured token, or null when unset or blank. */
export function optimizerToken(env: TokenEnv = process.env): string | null {
  const token = env.OPTIMIZER_TOKEN?.trim();
  return token ? token : null;
}

/** Header carrying the token (`Authorization: Bearer …`), or none without a token. */
export function optimizerAuthHeaders(env: TokenEnv = process.env): Record<string, string> {
  const token = optimizerToken(env);
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** Startup warning (src/instrumentation.ts) in production without a token, or null. Never echoes a value. */
export function optimizerTokenWarning(env: TokenEnv): string | null {
  if (env.NODE_ENV !== "production" || optimizerToken(env)) return null;
  return (
    "OPTIMIZER_TOKEN is not set: the optimizer is called without authentication. Set the same random value " +
    "(openssl rand -base64 32) on the web app and on the optimizer, and keep the optimizer on a private network."
  );
}
