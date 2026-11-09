import "server-only";
import { headers } from "next/headers";
import { auditAnonymous } from "@/lib/audit";
import {
  clearLoginFailures,
  clientAddress,
  createLoginLimiters,
  emailTag,
  firstRefusalOfBlock,
  gateLoginAttempt,
  refusalLogFields,
  trustedProxyHops,
  type LoginLimiters,
} from "./rate-limit";

/**
 * Sign-in throttling of the login action. The rules and the gate are in
 * rate-limit.ts (pure, unit-tested); this module only reads the request
 * header and writes the log, and the audit trail: one session.throttled event
 * per block (the e-mail as emailTag only), not one per refused attempt. One
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
    await auditAnonymous({
      action: "session.throttled",
      entity: "User",
      details: { emailTag: emailTag(email), by: refusal.by, retryInMin: refusal.retryInMin },
    });
  }
  return { retryInMin: refusal.retryInMin };
}

/** A successful sign-in clears the failures counted for `email`. */
export function loginSucceeded(email: string): void {
  clearLoginFailures(limiters, email);
}
