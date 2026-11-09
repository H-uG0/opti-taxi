import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { readSession } from "./session";
import { ACCOUNT_STATE_SELECT, sessionIsCurrent, type Role, type SessionUser } from "./session-check";

export type { Role, SessionUser } from "./session-check";

/** Home page of each role. */
export const ROLE_HOME: Record<Role, string> = {
  REGULATOR: "/planning",
  DRIVER: "/chauffeur",
};

/**
 * The signed-in user, re-checked against the database on every request
 * (rules in sessionIsCurrent): session tokens are stateless (12 h), so an
 * account disabled, a driver deactivated or unlinked, a role or driver link
 * changed, a session version bumped (logout, deactivation, new password or
 * e-mail: REVOKE_SESSIONS) or a password hash changed since the sign-in ends
 * the session here.
 * Cached per request in renders (layout and page share one lookup); in a
 * server action every call reads the database again.
 */
const currentUser = cache(async (): Promise<SessionUser | null> => {
  const claims = await readSession();
  if (!claims) return null;
  const account = await db.user.findUnique({ where: { id: claims.id }, select: ACCOUNT_STATE_SELECT });
  return sessionIsCurrent(claims, account);
});

/**
 * Returns the signed-in user, or redirects to /login. With a role, a user of
 * another role is sent to their own home page. Call it at the top of every
 * protected page, layout, route handler and server action.
 */
export async function requireUser(role?: Role): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (role && user.role !== role) redirect(ROLE_HOME[user.role]);
  return user;
}

/** Where a driver with a provisional password chooses their own (and any driver changes it). */
export const PASSWORD_PAGE = "/chauffeur/mot-de-passe";

/**
 * A signed-in driver, whether or not their password is still the provisional
 * one: for the driver layout (header, call to the regulation) and the
 * password page itself. Never for patient data: use requireDriver.
 * A driver session must be linked to an active Driver record.
 * sessionIsCurrent already refuses a driver session without one, so the check
 * below only narrows the type; it redirects to /login, where the same rule
 * shows the form (no redirect loop).
 */
export async function requireDriverAccount(): Promise<SessionUser & { driverId: string }> {
  const user = await requireUser("DRIVER");
  if (!user.driverId) redirect("/login?error=no-driver");
  return { ...user, driverId: user.driverId };
}

/**
 * A driver allowed to see their roadmap: one still on the provisional
 * password a regulator set (or reset) is sent to choose their own first, so a
 * status is never recorded in their name with a password someone else knows.
 */
export async function requireDriver(): Promise<SessionUser & { driverId: string }> {
  const user = await requireDriverAccount();
  if (user.mustChangePassword) redirect(PASSWORD_PAGE);
  return user;
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  return currentUser();
}
