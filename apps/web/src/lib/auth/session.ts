import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { sessionCookie } from "./cookie";
import { assertSessionSecret } from "./secret";
import { passwordVersion, type SessionClaims, type SessionUser } from "./session-check";
import { SESSION_HOURS, sessionExpiryFrom, shouldRenewSession, withinDriverSessionCap } from "./session-renewal";

export { passwordVersion, type Role, type SessionClaims, type SessionUser } from "./session-check";

/** "__Host-ot_session" in production, "ot_session" in development (see cookie.ts). */
const COOKIE = sessionCookie(process.env.NODE_ENV);
export const SESSION_COOKIE = COOKIE.name;

/** Signing key. Same rules as the startup check (src/instrumentation.ts): a weak secret never signs. */
function secretKey(): Uint8Array {
  return new TextEncoder().encode(assertSessionSecret());
}

/**
 * What a token carries besides its subject (the user id) and its times.
 * auth_time: when the password was typed (epoch seconds), set at sign-in and
 * copied unchanged by every renewal: it caps a driver's renewals.
 */
type TokenClaims = {
  name: string;
  role: SessionUser["role"];
  driverId: string | null;
  pwv: string;
  sv: number;
  auth_time: number;
};

/** Signs a token valid SESSION_HOURS from `now` and sets it as this browser's session cookie. Returns its expiry. */
async function signSession(subject: string, claims: TokenClaims, now: Date): Promise<Date> {
  const expiresAt = sessionExpiryFrom(now);
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(subject)
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(secretKey());

  const store = await cookies();
  store.set(SESSION_COOKIE, token, { ...COOKIE.attributes, maxAge: SESSION_HOURS * 3600 });
  return expiresAt;
}

/**
 * Opens a session for `user`, the password just typed (sign-in, password
 * change). `account` is the row the sign-in was checked against: its password
 * fingerprint and session version go into the token, and sessionIsCurrent
 * (session-check.ts) ends the session once either changes.
 */
export async function createSession(
  user: SessionUser,
  account: { passwordHash: string; sessionVersion: number },
): Promise<void> {
  const now = new Date();
  await signSession(
    user.id,
    {
      name: user.name,
      role: user.role,
      driverId: user.driverId,
      pwv: passwordVersion(account.passwordHash),
      sv: account.sessionVersion,
      auth_time: Math.floor(now.getTime() / 1000),
    },
    now,
  );
}

/** Payload of this browser's session cookie when its signature and expiry are valid, else null. */
async function verifiedPayload(): Promise<JWTPayload | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  // Outside the try: a refused secret is a configuration error, not a signed-out visitor.
  const key = secretKey();
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    return payload;
  } catch {
    return null;
  }
}

/** Claims of a valid signed cookie. Not checked against the database: use requireUser / getCurrentUser (lib/auth). */
export async function readSession(): Promise<SessionClaims | null> {
  const payload = await verifiedPayload();
  if (!payload?.sub || (payload.role !== "REGULATOR" && payload.role !== "DRIVER")) return null;
  return {
    id: payload.sub,
    name: typeof payload.name === "string" ? payload.name : "",
    role: payload.role,
    driverId: typeof payload.driverId === "string" ? payload.driverId : null,
    passwordVersion: typeof payload.pwv === "string" ? payload.pwv : null,
    sessionVersion: typeof payload.sv === "number" && Number.isInteger(payload.sv) ? payload.sv : null,
  };
}

/** When the password of a token was typed: auth_time, or for a token signed before it existed its signature time. */
function authTimeOf(payload: JWTPayload): number | null {
  if (typeof payload.auth_time === "number") return payload.auth_time;
  return typeof payload.iat === "number" ? payload.iat : null;
}

/** When this browser's session ends (the token's expiry), null without a valid token. */
export async function sessionExpiresAt(): Promise<Date | null> {
  const payload = await verifiedPayload();
  return typeof payload?.exp === "number" ? new Date(payload.exp * 1000) : null;
}

/**
 * Renews a driver's session when it is close to its end (shouldRenewSession):
 * the same claims, signed again for SESSION_HOURS. Returns the session's
 * expiry, renewed or not, or null when there is no token for `user`.
 *
 * Only for a session already checked against the account in this request
 * (requireUser / getCurrentUser): the password fingerprint and session version
 * are copied from the token they validated, so a revoked session is never
 * renewed and a renewed one is still ended by REVOKE_SESSIONS. Only where
 * cookies can be set: route handlers and server actions, not page renders.
 */
export async function renewDriverSession(user: SessionUser, now: Date = new Date()): Promise<Date | null> {
  const payload = await verifiedPayload();
  if (!payload || payload.sub !== user.id || typeof payload.exp !== "number") return null;
  const expiresAt = new Date(payload.exp * 1000);
  const authTime = authTimeOf(payload);
  if (!shouldRenewSession(user.role, expiresAt, now, authTime === null ? null : new Date(authTime * 1000))) return expiresAt;
  if (typeof payload.pwv !== "string" || typeof payload.sv !== "number" || authTime === null) return expiresAt;
  return signSession(
    user.id,
    { name: user.name, role: user.role, driverId: user.driverId, pwv: payload.pwv, sv: payload.sv, auth_time: authTime },
    now,
  );
}

/**
 * Whether this browser's driver session can still be renewed (fewer than
 * DRIVER_MAX_SESSION_DAYS since the password was typed): the roadmap then says
 * it prolongs itself, else that the driver has to sign in again.
 */
export async function driverSessionRenewable(user: SessionUser, now: Date = new Date()): Promise<boolean> {
  if (user.role !== "DRIVER") return false;
  const payload = await verifiedPayload();
  if (!payload || payload.sub !== user.id) return false;
  const authTime = authTimeOf(payload);
  return withinDriverSessionCap(authTime === null ? null : new Date(authTime * 1000), now);
}

/**
 * Clears the cookie on this browser. The expired cookie repeats the attributes
 * it was set with: a browser ignores a `__Host-` cookie without Secure, the
 * deletion included. Ending the session everywhere is logout's job
 * (REVOKE_SESSIONS).
 */
export async function deleteSession(): Promise<void> {
  const store = await cookies();
  store.delete({ name: SESSION_COOKIE, ...COOKIE.attributes });
}
