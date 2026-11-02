/**
 * Session revocation rules. Session tokens are stateless (12 h), so every
 * request re-reads the account (lib/auth) and keeps the session only while it
 * still matches. Free of Next.js and database imports so it can be unit-tested.
 */
import { createHash } from "node:crypto";

export type Role = "REGULATOR" | "DRIVER";

export type SessionUser = {
  id: string;
  name: string;
  role: Role;
  driverId: string | null;
};

/** What the signed cookie carries: the user plus the password version it was opened with. */
export type SessionClaims = SessionUser & { passwordVersion: string | null };

/** The account fields the rules read (lib/auth and the login action load exactly these). */
export type AccountState = {
  name: string;
  role: Role;
  active: boolean;
  driverId: string | null;
  passwordHash: string;
  driver: { active: boolean } | null;
};

/**
 * Short fingerprint of a password hash. Stored in the session so that any
 * change of the stored hash (password reset, or lockedPasswordHash() on
 * deactivation) ends the sessions opened before it, for good.
 */
export function passwordVersion(passwordHash: string): string {
  return createHash("sha256").update(passwordHash).digest("hex").slice(0, 16);
}

/**
 * Why an account may not hold a session at all, whatever its token says:
 * - "inactive": the account is disabled;
 * - "no-active-driver": a driver account not linked to a Driver record (the
 *   record was deleted) or linked to a deactivated one. A driver session
 *   without a driver has no roadmap to show, so it is refused here rather
 *   than bounced between /login and /chauffeur.
 * The login action applies the same rules, so it never opens a session that
 * the next request would reject.
 */
export type AccountRefusal = "inactive" | "no-active-driver";

export function accountRefusal(account: Pick<AccountState, "role" | "active" | "driverId" | "driver">): AccountRefusal | null {
  if (!account.active) return "inactive";
  if (account.role === "DRIVER" && (!account.driverId || !account.driver)) return "no-active-driver";
  if (account.driver && !account.driver.active) return "no-active-driver";
  return null;
}

/**
 * The user a session stands for, or null when it must end: account missing or
 * refused (see accountRefusal), role or driver link changed since the sign-in,
 * or password hash changed since the sign-in. Tokens issued before the password
 * fingerprint existed carry none and are refused: one more sign-in.
 * The name comes from the account, so a renamed driver sees the new name.
 */
export function sessionIsCurrent(claims: SessionClaims, account: AccountState | null): SessionUser | null {
  if (!account || accountRefusal(account) !== null) return null;
  if (account.role !== claims.role || account.driverId !== claims.driverId) return null;
  if (claims.passwordVersion === null || claims.passwordVersion !== passwordVersion(account.passwordHash)) return null;
  return { id: claims.id, name: account.name, role: account.role, driverId: account.driverId };
}
