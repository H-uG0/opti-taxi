import "server-only";
import { redirect } from "next/navigation";
import { readSession, type Role, type SessionUser } from "./session";

export type { Role, SessionUser } from "./session";

/** Home page of each role. */
export const ROLE_HOME: Record<Role, string> = {
  REGULATOR: "/planning",
  DRIVER: "/chauffeur",
};

/**
 * Returns the signed-in user, or redirects to /login. With a role, a user of
 * another role is sent to their own home page. Call it at the top of every
 * protected page, layout, route handler and server action.
 */
export async function requireUser(role?: Role): Promise<SessionUser> {
  const user = await readSession();
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
  return readSession();
}
