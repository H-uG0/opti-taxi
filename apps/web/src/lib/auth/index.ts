import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { passwordVersion, readSession, type Role, type SessionUser } from "./session";

export type { Role, SessionUser } from "./session";

/** Home page of each role. */
export const ROLE_HOME: Record<Role, string> = {
  REGULATOR: "/planning",
  DRIVER: "/chauffeur",
};

/**
 * The signed-in user, re-checked against the database on every request:
 * session tokens are stateless (12 h), so an account disabled, a driver
 * deactivated, a role or driver link changed, or a password reset since the
 * sign-in must end the session here. Cached per request (layout and page
 * share one lookup).
 */
const currentUser = cache(async (): Promise<SessionUser | null> => {
  const session = await readSession();
  if (!session) return null;
  const account = await db.user.findUnique({
    where: { id: session.id },
    select: {
      name: true,
      role: true,
      active: true,
      driverId: true,
      passwordHash: true,
      driver: { select: { active: true } },
    },
  });
  if (!account?.active) return null;
  if (account.role !== session.role || account.driverId !== session.driverId) return null;
  if (session.passwordVersion !== passwordVersion(account.passwordHash)) return null;
  if (account.driver && !account.driver.active) return null;
  return { id: session.id, name: account.name, role: account.role, driverId: account.driverId };
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

/** A driver session must be linked to a Driver record to see a roadmap. */
export async function requireDriver(): Promise<SessionUser & { driverId: string }> {
  const user = await requireUser("DRIVER");
  if (!user.driverId) redirect("/login?error=no-driver");
  return { ...user, driverId: user.driverId };
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  return currentUser();
}
