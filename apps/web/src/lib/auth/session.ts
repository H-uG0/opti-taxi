import "server-only";
import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "ot_session";
const SESSION_HOURS = 12;

export type Role = "REGULATOR" | "DRIVER";

export type SessionUser = {
  id: string;
  name: string;
  role: Role;
  driverId: string | null;
};

/** What the signed cookie carries: the user plus the password version it was opened with. */
export type SessionClaims = SessionUser & { passwordVersion: string | null };

function secretKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET must be set to at least 32 characters");
  }
  return new TextEncoder().encode(secret);
}

/**
 * Short fingerprint of a password hash. Stored in the session so that a
 * password reset ends the sessions opened with the previous password.
 */
export function passwordVersion(passwordHash: string): string {
  return createHash("sha256").update(passwordHash).digest("hex").slice(0, 16);
}

export async function createSession(user: SessionUser, passwordHash: string): Promise<void> {
  const token = await new SignJWT({
    name: user.name,
    role: user.role,
    driverId: user.driverId,
    pwv: passwordVersion(passwordHash),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_HOURS}h`)
    .sign(secretKey());

  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_HOURS * 3600,
  });
}

/** Claims of a valid signed cookie. Not checked against the database: use requireUser (lib/auth). */
export async function readSession(): Promise<SessionClaims | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
    if (!payload.sub || (payload.role !== "REGULATOR" && payload.role !== "DRIVER")) return null;
    return {
      id: payload.sub,
      name: typeof payload.name === "string" ? payload.name : "",
      role: payload.role,
      driverId: typeof payload.driverId === "string" ? payload.driverId : null,
      passwordVersion: typeof payload.pwv === "string" ? payload.pwv : null,
    };
  } catch {
    return null;
  }
}

export async function deleteSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
