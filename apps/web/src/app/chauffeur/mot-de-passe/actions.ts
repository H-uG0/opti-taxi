"use server";

/**
 * « Changer mon mot de passe » of the driver app: required while the password
 * is the provisional one a regulator set (requireDriver sends the driver
 * here), available any time after. The current password is checked under the
 * sign-in throttle (5 failures per 15 min for the account), every session of
 * the account is then ended (REVOKE_SESSIONS) and a fresh one is opened on
 * this phone. Passwords are never echoed back to the browser.
 */
import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { requireDriverAccount } from "@/lib/auth";
import { loginSucceeded, throttleLogin } from "@/lib/auth/login-throttle";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { REVOKE_SESSIONS } from "@/lib/auth/revoke";
import { createSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { errorState, invalidState, messageState, successState, type FormState } from "@/lib/forms";
import { tooManyAttempts } from "@/app/login/messages";
import { PASSWORD_CHANGED, passwordChangeSchema, readPasswordForm, WRONG_CURRENT_PASSWORD } from "../_lib/password";

export async function changeOwnPassword(_state: FormState, formData: FormData): Promise<FormState> {
  const user = await requireDriverAccount();
  const parsed = passwordChangeSchema.safeParse(readPasswordForm(formData));
  if (!parsed.success) return invalidState(parsed.error, null);

  const account = await db.user.findUnique({ where: { id: user.id }, select: { email: true, passwordHash: true } });
  if (!account) return messageState("Compte introuvable : reconnectez-vous.");
  // Same gate as the sign-in: guessing the current password from an open session is throttled too.
  const throttled = await throttleLogin(account.email);
  if (throttled) return messageState(tooManyAttempts(throttled.retryInMin));
  if (!(await verifyPassword(parsed.data.current, account.passwordHash))) {
    return errorState({ current: WRONG_CURRENT_PASSWORD }, null, WRONG_CURRENT_PASSWORD);
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
  return successState(PASSWORD_CHANGED);
}
