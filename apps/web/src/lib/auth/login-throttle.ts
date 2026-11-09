import "server-only";
import { headers } from "next/headers";
import { auditAnonymous } from "@/lib/audit";
import { db } from "@/lib/db";
import { logError } from "@/lib/log";
import {
  clearLoginFailures,
  clientAddress,
  createLoginLimiters,
  firstRefusalOfBlock,
  gateLoginAttempt,
  refusalLogFields,
  signInSubject,
  trustedProxyHops,
  type LoginLimiters,
} from "./rate-limit";

/**
 * Sign-in throttling of the login action. The rules and the gate are in
 * rate-limit.ts (pure, unit-tested); this module only reads the request
 * header and writes the log, and the audit trail: one session.throttled event
 * per block (the account as entityId, or the tag of an e-mail that is no
 * account: signInSubject), not one per refused attempt. One
 * set of in-memory limiters per Node.js process, kept on globalThis so a
 * module reloaded in development or bundled twice still shares them. Several
 * instances need a shared store instead (see rate-limit.ts).
 */
const globalForThrottle = globalThis as unknown as { optiTaxiLoginLimiters?: LoginLimiters };
const limiters: LoginLimiters = (globalForThrottle.optiTaxiLoginLimiters ??= createLoginLimiters());

/**
 * Gate of one sign-in attempt for `email` (already trimmed and lower-cased),
 * see gateLoginAttempt. Call it before the account lookup and bcrypt. Returns
 * the minutes to wait, or null when the attempt may go ahead (it is then
 * counted as a failure until loginSucceeded()).
 */
export async function throttleLogin(email: string): Promise<{ retryInMin: number } | null> {
  const address = clientAddress((await headers()).get("x-forwarded-for"), trustedProxyHops(process.env.TRUSTED_PROXY_HOPS));
  const refusal = gateLoginAttempt(limiters, email, address);
  if (!refusal) return null;
  console.warn("[login] attempt refused (too many attempts)", refusalLogFields(refusal, email, address));
  if (firstRefusalOfBlock(limiters, email, address)) {
    // Once per block: the lookup costs nothing to the refused attempts that follow.
    const subject = signInSubject(email, await accountIdOf(email));
    await auditAnonymous({
      action: "session.throttled",
      entity: "User",
      entityId: subject.entityId,
      details: { ...subject.details, by: refusal.by, retryInMin: refusal.retryInMin },
    });
  }
  return { retryInMin: refusal.retryInMin };
}

/** The account signing in with `email`, or null (unknown, or the database did not answer: best effort). */
async function accountIdOf(email: string): Promise<string | null> {
  try {
    return (await db.user.findUnique({ where: { email }, select: { id: true } }))?.id ?? null;
  } catch (error) {
    logError("[login] looking up the throttled account failed", error);
    return null;
  }
}

/** A successful sign-in clears the failures counted for `email`. */
export function loginSucceeded(email: string): void {
  clearLoginFailures(limiters, email);
}
