"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit, auditAnonymous, auditRead } from "@/lib/audit";
import { getCurrentUser, ROLE_HOME } from "@/lib/auth";
import { loginSucceeded, throttleLogin } from "@/lib/auth/login-throttle";
import { emailTag } from "@/lib/auth/rate-limit";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { REVOKE_SESSIONS } from "@/lib/auth/revoke";
import { createSession, deleteSession } from "@/lib/auth/session";
import { ACCOUNT_STATE_SELECT, accountRefusal } from "@/lib/auth/session-check";
import { logError } from "@/lib/log";
import { NO_ACTIVE_DRIVER, tooManyAttempts, WRONG_CREDENTIALS } from "./messages";

export type LoginState = { error: string | null; email: string };

let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword("timing-equalizer");
  return dummyHashPromise;
}

const loginSchema = z.object({
  // Same bound as stored e-mails (chauffeurs/schema.ts): a longer one cannot
  // match an account, and is refused before it reaches the throttle.
  email: z.string().trim().toLowerCase().max(120).email(),
  password: z.string().min(1),
});

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  const email = String(formData.get("email") ?? "");
  if (!parsed.success) return { error: "Adresse e-mail ou mot de passe invalide.", email };

  // Before the account lookup and bcrypt, identical for known and unknown
  // e-mails. Every attempt below counts as a failure until it succeeds.
  const throttled = await throttleLogin(parsed.data.email);
  if (throttled) return { error: tooManyAttempts(throttled.retryInMin), email };

  const user = await db.user.findUnique({
    where: { email: parsed.data.email },
    select: { id: true, ...ACCOUNT_STATE_SELECT },
  });
  // Always run one bcrypt comparison so response time does not reveal which emails exist.
  const ok = await verifyPassword(parsed.data.password, user?.passwordHash ?? (await dummyHash()));
  // Traced for both known and unknown e-mails (same cost, same answer): the e-mail only as its tag.
  const failed = (reason: string) =>
    auditAnonymous({
      action: "session.login_failed",
      entity: "User",
      entityId: user?.id ?? null,
      details: { emailTag: emailTag(parsed.data.email), reason },
    });
  if (!user || !ok) {
    await failed(user ? "wrong_password" : "unknown_account");
    return { error: WRONG_CREDENTIALS, email };
  }
  // Same rules as the per-request session check (lib/auth): never open a
  // session the next request would reject (silent bounce back to this form).
  const refusal = accountRefusal(user);
  if (refusal === "inactive") {
    await failed("inactive");
    return { error: WRONG_CREDENTIALS, email };
  }
  if (refusal === "no-active-driver") {
    await failed("no_active_driver");
    return { error: NO_ACTIVE_DRIVER, email };
  }

  loginSucceeded(parsed.data.email);
  await createSession({ id: user.id, name: user.name, role: user.role, driverId: user.driverId }, user);
  // Best effort, like a read: a sign-in is never refused because its trace failed.
  await auditRead(user, { action: "session.login", entity: "User", entityId: user.id });
  redirect(ROLE_HOME[user.role]);
}

/**
 * Signs out everywhere: bumping the session version (REVOKE_SESSIONS) ends
 * every open session of the account, on this browser and on any other device
 * (a forgotten phone, a shared workstation), then the cookie is cleared here.
 *
 * No requireUser(): logout must also clear a cookie that no longer opens a
 * session. It checks the session itself (getCurrentUser, the same rules as
 * requireUser) and revokes only for a current one, so a stale or replayed
 * token cannot sign the account out of its current sessions. If the database
 * is unreachable the cookie is still cleared; the other sessions then end at
 * their 12-hour expiry.
 */
export async function logout(): Promise<void> {
  const user = await getCurrentUser().catch((error: unknown) => {
    logError("[logout] reading the session failed", error);
    return null;
  });
  if (user) {
    try {
      await db.$transaction(async (tx) => {
        await tx.user.update({ where: { id: user.id }, data: REVOKE_SESSIONS, select: { id: true } });
        await audit(tx, user, { action: "session.logout", entity: "User", entityId: user.id });
      });
    } catch (error) {
      logError("[logout] ending the sessions failed", error, { userId: user.id });
    }
  }
  await deleteSession();
  redirect("/login");
}
