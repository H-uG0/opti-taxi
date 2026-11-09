/**
 * Lifetime of a session token, and when a driver's is renewed. Pure module
 * (unit-tested), used by lib/auth/session.ts.
 *
 * A token lasts SESSION_HOURS from its signature. A regulator's is never
 * renewed (sign in again after 12 h). A driver's is re-signed for another
 * SESSION_HOURS when less than DRIVER_RENEW_BELOW_HOURS remain and the app
 * talks to the server (a status sent, the roadmap opened or refreshed), so a
 * driver who checked tomorrow's route at 19:00 is not signed out at 07:00 in
 * the middle of the first pickups. A session left unused ends 7 to 12 h after
 * its last use. Renewal keeps the claims checked on every request (password
 * fingerprint, session version): logout, deactivation or a new password still
 * end it everywhere (REVOKE_SESSIONS).
 */
import type { Role } from "./session-check";

export const SESSION_HOURS = 12;

/** A driver's token is renewed once fewer hours than this are left. */
export const DRIVER_RENEW_BELOW_HOURS = 5;

const HOUR_MS = 60 * 60 * 1000;

export function sessionExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + SESSION_HOURS * HOUR_MS);
}

/** True when a still valid session of this role should be re-signed now. */
export function shouldRenewSession(role: Role, expiresAt: Date, now: Date): boolean {
  if (role !== "DRIVER") return false;
  const left = expiresAt.getTime() - now.getTime();
  return left > 0 && left < DRIVER_RENEW_BELOW_HOURS * HOUR_MS;
}
