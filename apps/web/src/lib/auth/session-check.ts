/**
 * Session revocation rules. Session tokens are signed and carry no server-side
 * record (12 h), so every request re-reads the account (lib/auth) and keeps the
 * session only while it still matches. Free of Next.js and database imports so
 * it can be unit-tested.
 */
import { createHash } from "node:crypto";

export type Role = "REGULATOR" | "DRIVER";

export type SessionUser = {
  id: string;
  name: string;
  role: Role;
  driverId: string | null;
  /** The account still has the provisional password a regulator set: it must choose its own first. */
  mustChangePassword: boolean;
};

/**
 * What the signed cookie carries: the user plus the password fingerprint and
 * the account's session version at sign-in (null when the token predates the
 * claim).
 */
export type SessionClaims = Omit<SessionUser, "mustChangePassword"> & {
  passwordVersion: string | null;
  sessionVersion: number | null;
};

/** The account fields the rules read (lib/auth and the login action load exactly these). */
export type AccountState = {
  name: string;
  role: Role;
  active: boolean;
  driverId: string | null;
  passwordHash: string;
  sessionVersion: number;
  mustChangePassword: boolean;
  driver: { active: boolean } | null;
};

/** Prisma `select` of AccountState, shared by lib/auth and the login action. */
export const ACCOUNT_STATE_SELECT = {
  name: true,
  role: true,
  active: true,
  driverId: true,
  passwordHash: true,
  sessionVersion: true,
  mustChangePassword: true,
  driver: { select: { active: true } },
} as const;

/**
 * Short fingerprint of a password hash. Stored in the session so that any
 * change of the stored hash ends the sessions opened before it, for good. The
 * session version (REVOKE_SESSIONS, lib/auth/revoke.ts) is the main revocation
 * switch; the fingerprint also covers a hash changed outside the app (a
 * script, a manual SQL update) that did not bump the version.
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
 * session version bumped since the sign-in (logout, deactivation, new password
 * or e-mail: REVOKE_SESSIONS), or password hash changed since the sign-in.
 * Tokens issued before either claim existed carry none and are refused: one
 * more sign-in. A bumped version stays bumped, so reactivating an account does
 * not bring its old sessions back (e.g. on a lost phone).
 * The name comes from the account, so a renamed driver sees the new name.
 */
export function sessionIsCurrent(claims: SessionClaims, account: AccountState | null): SessionUser | null {
  if (!account || accountRefusal(account) !== null) return null;
  if (account.role !== claims.role || account.driverId !== claims.driverId) return null;
  if (claims.sessionVersion === null || claims.sessionVersion !== account.sessionVersion) return null;
  if (claims.passwordVersion === null || claims.passwordVersion !== passwordVersion(account.passwordHash)) return null;
  return {
    id: claims.id,
    name: account.name,
    role: account.role,
    driverId: account.driverId,
    mustChangePassword: account.mustChangePassword,
  };
}
