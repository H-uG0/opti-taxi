"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { ROLE_HOME } from "@/lib/auth";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createSession, deleteSession } from "@/lib/auth/session";
import { accountRefusal } from "@/lib/auth/session-check";
import { NO_ACTIVE_DRIVER, WRONG_CREDENTIALS } from "./messages";

export type LoginState = { error: string | null; email: string };

let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword("timing-equalizer");
  return dummyHashPromise;
}

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  const email = String(formData.get("email") ?? "");
  if (!parsed.success) return { error: "Adresse e-mail ou mot de passe invalide.", email };

  const user = await db.user.findUnique({
    where: { email: parsed.data.email },
    select: {
      id: true,
      name: true,
      role: true,
      active: true,
      driverId: true,
      passwordHash: true,
      driver: { select: { active: true } },
    },
  });
  // Always run one bcrypt comparison so response time does not reveal which emails exist.
  const ok = await verifyPassword(parsed.data.password, user?.passwordHash ?? (await dummyHash()));
  if (!user || !ok) return { error: WRONG_CREDENTIALS, email };
  // Same rules as the per-request session check (lib/auth): never open a
  // session the next request would reject (silent bounce back to this form).
  const refusal = accountRefusal(user);
  if (refusal === "inactive") return { error: WRONG_CREDENTIALS, email };
  if (refusal === "no-active-driver") return { error: NO_ACTIVE_DRIVER, email };

  await createSession({ id: user.id, name: user.name, role: user.role, driverId: user.driverId }, user.passwordHash);
  redirect(ROLE_HOME[user.role]);
}

export async function logout(): Promise<void> {
  await deleteSession();
  redirect("/login");
}
