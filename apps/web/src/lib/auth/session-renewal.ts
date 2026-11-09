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
 *
 * Renewals stop DRIVER_MAX_SESSION_DAYS after the password was last typed
 * (sign-in or password change: the token's auth_time, copied unchanged by
 * every renewal), so an unlocked phone left on the dashboard does not keep a
 * session forever: the last token then ends at its expiry, at most 12 h later.
 */
import type { Role } from "./session-check";

export const SESSION_HOURS = 12;

/** A driver's token is renewed once fewer hours than this are left. */
export const DRIVER_RENEW_BELOW_HOURS = 5;

/**
 * Days after the password was typed during which a driver's session is still
 * renewed. 7 by default (a driver signs in about once a week): to validate
 * with the DPO; changing it only means changing this number.
 */
export const DRIVER_MAX_SESSION_DAYS = 7;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** True while a driver's session may still be renewed: fewer than DRIVER_MAX_SESSION_DAYS since the password was typed. */
export function withinDriverSessionCap(authTime: Date | null, now: Date): boolean {
  return authTime !== null && now.getTime() - authTime.getTime() < DRIVER_MAX_SESSION_DAYS * DAY_MS;
}

export function sessionExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + SESSION_HOURS * HOUR_MS);
}

/**
 * True when a still valid session of this role should be re-signed now.
 * `authTime`: when the password was typed (null when unknown: never renewed).
 */
export function shouldRenewSession(role: Role, expiresAt: Date, now: Date, authTime: Date | null): boolean {
  if (role !== "DRIVER") return false;
  const left = expiresAt.getTime() - now.getTime();
  return left > 0 && left < DRIVER_RENEW_BELOW_HOURS * HOUR_MS && withinDriverSessionCap(authTime, now);
}
