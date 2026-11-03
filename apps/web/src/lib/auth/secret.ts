/**
 * SESSION_SECRET rules. The secret signs every session cookie: whoever knows it
 * can sign in as anyone. Pure module (no Next.js import) so the startup check
 * (src/instrumentation.ts), the signing code (session.ts) and the unit tests
 * share it.
 */

/** Minimum in every environment, development included; production also needs MIN_PRODUCTION_SECRET_LENGTH. */
export const MIN_SECRET_LENGTH = 32;

/**
 * Production minimum: 43 characters is 32 random bytes in base64 (256 bits,
 * the HS256 key size). `openssl rand -base64 48` gives 64 characters.
 */
export const MIN_PRODUCTION_SECRET_LENGTH = 43;

/** The placeholder of .env.example ("change-me-…") and its variants. */
const PLACEHOLDER = /change-me/i;

const HOW_TO = "Generate one with: openssl rand -base64 48";

/**
 * Why `secret` may not sign sessions under `nodeEnv`, or null when it may.
 * The message names the rule, never the secret itself.
 */
export function sessionSecretProblem(secret: string | undefined, nodeEnv: string | undefined): string | null {
  if (!secret) return `SESSION_SECRET is not set. ${HOW_TO}`;
  if (secret.length < MIN_SECRET_LENGTH) {
    return `SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters (it has ${secret.length}). ${HOW_TO}`;
  }
  if (nodeEnv !== "production") return null;
  if (PLACEHOLDER.test(secret)) {
    return `SESSION_SECRET still holds the "change-me" placeholder of .env.example: refused in production. ${HOW_TO}`;
  }
  if (secret.length < MIN_PRODUCTION_SECRET_LENGTH) {
    return `SESSION_SECRET is too short for production: ${secret.length} characters, at least ${MIN_PRODUCTION_SECRET_LENGTH} required. ${HOW_TO}`;
  }
  return null;
}

/** The configured SESSION_SECRET; throws when it may not sign sessions. */
export function assertSessionSecret(env: { SESSION_SECRET?: string; NODE_ENV?: string } = process.env): string {
  const secret = env.SESSION_SECRET;
  const problem = sessionSecretProblem(secret, env.NODE_ENV);
  if (problem !== null || secret === undefined) throw new Error(problem ?? "SESSION_SECRET is not set");
  return secret;
}
