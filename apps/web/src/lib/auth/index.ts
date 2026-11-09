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
 * another role is sent to their own home page. Call it (or a helper built on
 * the same check: requireDriver*, current* for the driver's JSON route
 * handlers, which answer 401 instead of redirecting) at the top of every
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

export type DriverAccount = SessionUser & { driverId: string };

/**
 * The rules of the driver app, in one place for the pages (require*, which
 * redirect) and the driver's JSON route handlers (current*, which answer
 * with a reason):
 * - a driver account has the DRIVER role and is linked to a Driver record
 *   (sessionIsCurrent already refuses a driver session without an active one,
 *   so the link check only narrows the type);
 * - patient data and statuses need more: a driver still on the provisional
 *   password a regulator set (or reset) chooses their own first, so a status
 *   is never recorded in their name with a password someone else knows.
 */
function driverAccountOf(user: SessionUser): DriverAccount | null {
  return user.role === "DRIVER" && user.driverId ? { ...user, driverId: user.driverId } : null;
}

function mustChooseOwnPassword(account: DriverAccount): boolean {
  return account.mustChangePassword;
}

/**
 * A signed-in driver, whether or not their password is still the provisional
 * one: for the driver layout (header, call to the regulation) and the
 * password page itself. Never for patient data: use requireDriver.
 * Without a link to a Driver record it redirects to /login, where the same
 * rule shows the form (no redirect loop).
 */
export async function requireDriverAccount(): Promise<DriverAccount> {
  const account = driverAccountOf(await requireUser("DRIVER"));
  if (!account) redirect("/login?error=no-driver");
  return account;
}

/** A driver allowed to see their roadmap; one on a provisional password is sent to choose their own first. */
export async function requireDriver(): Promise<DriverAccount> {
  const account = await requireDriverAccount();
  if (mustChooseOwnPassword(account)) redirect(PASSWORD_PAGE);
  return account;
}

/**
 * requireDriverAccount without a redirect, for a route handler: the driver
 * account, or null (no current session, or not a driver).
 */
export async function currentDriverAccount(): Promise<DriverAccount | null> {
  const user = await currentUser();
  return user ? driverAccountOf(user) : null;
}

export type CurrentDriver = { ok: true; driver: DriverAccount } | { ok: false; reason: "session" | "password" };

/**
 * requireDriver without a redirect, for a route handler that reads or writes
 * the roadmap: the driver, or why not (no current driver session, or a
 * provisional password to change first).
 */
export async function currentDriver(): Promise<CurrentDriver> {
  const account = await currentDriverAccount();
  if (!account) return { ok: false, reason: "session" };
  if (mustChooseOwnPassword(account)) return { ok: false, reason: "password" };
  return { ok: true, driver: account };
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  return currentUser();
}
