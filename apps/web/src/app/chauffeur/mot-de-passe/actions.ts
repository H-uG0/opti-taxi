"use server";

/**
 * « Changer mon mot de passe » of the driver app: required while the password
 * is the provisional one a regulator set (requireDriver sends the driver
 * here), available any time after. The current password is checked under the
 * sign-in throttle (5 failures per 15 min for the account), each wrong one is
 * traced (account.password_change_failed), every session of the account is
 * then ended (REVOKE_SESSIONS) and a fresh one is opened on this phone.
 * Passwords are never echoed back to the browser.
 */
import { revalidatePath } from "next/cache";
import { audit, auditRead } from "@/lib/audit";
import { requireDriverAccount } from "@/lib/auth";
import { loginSucceeded, throttleLogin } from "@/lib/auth/login-throttle";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { REVOKE_SESSIONS } from "@/lib/auth/revoke";
import { createSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { errorState, invalidState, messageState, successState, type FormState } from "@/lib/forms";
import {
  PASSWORD_CHANGED,
  PASSWORD_SET,
  passwordChangeSchema,
  readPasswordForm,
  tooManyPasswordAttempts,
  WRONG_CURRENT_PASSWORD,
  WRONG_PROVISIONAL_PASSWORD,
} from "../_lib/password";

export async function changeOwnPassword(_state: FormState, formData: FormData): Promise<FormState> {
  const user = await requireDriverAccount();
  const parsed = passwordChangeSchema.safeParse(readPasswordForm(formData));
  if (!parsed.success) return invalidState(parsed.error, null);

  const account = await db.user.findUnique({ where: { id: user.id }, select: { email: true, passwordHash: true } });
  if (!account) return messageState("Compte introuvable : reconnectez-vous.");
  // Same gate as the sign-in: guessing the current password from an open session is throttled too.
  const throttled = await throttleLogin(account.email);
  if (throttled) return messageState(tooManyPasswordAttempts(throttled.retryInMin));
  const forced = user.mustChangePassword;
  if (!(await verifyPassword(parsed.data.current, account.passwordHash))) {
    // Each wrong guess is traced, like a failed sign-in (session.login_failed), not only the block
    // that follows the fifth. Best effort: the answer never depends on it.
    await auditRead(user, {
      action: "account.password_change_failed",
      entity: "User",
      entityId: user.id,
      details: { reason: "wrong_current_password" },
    });
    const wrong = forced ? WRONG_PROVISIONAL_PASSWORD : WRONG_CURRENT_PASSWORD;
    return errorState({ current: wrong }, null, wrong);
  }
  loginSucceeded(account.email);

  const passwordHash = await hashPassword(parsed.data.next);
  const updated = await db.$transaction(async (tx) => {
    const saved = await tx.user.update({
      where: { id: user.id },
      data: { passwordHash, mustChangePassword: false, ...REVOKE_SESSIONS },
      select: { passwordHash: true, sessionVersion: true },
    });
    await audit(tx, user, { action: "account.password_change", entity: "User", entityId: user.id });
    return saved;
  });
  // Every session opened before is now refused, this one included: open a new one on this phone.
  await createSession({ ...user, mustChangePassword: false }, updated);
  // The page and the roadmap no longer treat the password as provisional.
  revalidatePath("/chauffeur", "layout");
  // A provisional password was only used to get here: no other session to speak of.
  return successState(forced ? PASSWORD_SET : PASSWORD_CHANGED);
}
