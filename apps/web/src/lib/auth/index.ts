import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { readSession } from "./session";
import { sessionIsCurrent, type Role, type SessionUser } from "./session-check";

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
 * changed, or a password hash changed since the sign-in ends the session here.
 * Cached per request in renders (layout and page share one lookup); in a
 * server action every call reads the database again.
 */
const currentUser = cache(async (): Promise<SessionUser | null> => {
  const claims = await readSession();
  if (!claims) return null;
  const account = await db.user.findUnique({
    where: { id: claims.id },
    select: {
      name: true,
      role: true,
      active: true,
      driverId: true,
      passwordHash: true,
      driver: { select: { active: true } },
    },
  });
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

/**
 * A driver session must be linked to an active Driver record to see a
 * roadmap. sessionIsCurrent already refuses a driver session without one, so
 * the check below only narrows the type; it redirects to /login, where the
 * same rule shows the form (no redirect loop).
 */
export async function requireDriver(): Promise<SessionUser & { driverId: string }> {
  const user = await requireUser("DRIVER");
  if (!user.driverId) redirect("/login?error=no-driver");
  return { ...user, driverId: user.driverId };
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  return currentUser();
}
