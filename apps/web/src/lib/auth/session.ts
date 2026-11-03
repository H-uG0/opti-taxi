import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { sessionCookie } from "./cookie";
import { assertSessionSecret } from "./secret";
import { passwordVersion, type SessionClaims, type SessionUser } from "./session-check";

export { passwordVersion, type Role, type SessionClaims, type SessionUser } from "./session-check";

/** "__Host-ot_session" in production, "ot_session" in development (see cookie.ts). */
const COOKIE = sessionCookie(process.env.NODE_ENV);
export const SESSION_COOKIE = COOKIE.name;
const SESSION_HOURS = 12;

/** Signing key. Same rules as the startup check (src/instrumentation.ts): a weak secret never signs. */
function secretKey(): Uint8Array {
  return new TextEncoder().encode(assertSessionSecret());
}

/**
 * Opens a session for `user`. `account` is the row the sign-in was checked
 * against: its password fingerprint and session version go into the token, and
 * sessionIsCurrent (session-check.ts) ends the session once either changes.
 */
export async function createSession(
  user: SessionUser,
  account: { passwordHash: string; sessionVersion: number },
): Promise<void> {
  const token = await new SignJWT({
    name: user.name,
    role: user.role,
    driverId: user.driverId,
    pwv: passwordVersion(account.passwordHash),
    sv: account.sessionVersion,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_HOURS}h`)
    .sign(secretKey());

  const store = await cookies();
  store.set(SESSION_COOKIE, token, { ...COOKIE.attributes, maxAge: SESSION_HOURS * 3600 });
}

/** Claims of a valid signed cookie. Not checked against the database: use requireUser / getCurrentUser (lib/auth). */
export async function readSession(): Promise<SessionClaims | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  // Outside the try: a refused secret is a configuration error, not a signed-out visitor.
  const key = secretKey();
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    if (!payload.sub || (payload.role !== "REGULATOR" && payload.role !== "DRIVER")) return null;
    return {
      id: payload.sub,
      name: typeof payload.name === "string" ? payload.name : "",
      role: payload.role,
      driverId: typeof payload.driverId === "string" ? payload.driverId : null,
      passwordVersion: typeof payload.pwv === "string" ? payload.pwv : null,
      sessionVersion: typeof payload.sv === "number" && Number.isInteger(payload.sv) ? payload.sv : null,
    };
  } catch {
    return null;
  }
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
