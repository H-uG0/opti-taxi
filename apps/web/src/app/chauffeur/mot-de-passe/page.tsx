import type { Metadata } from "next";
import { requireDriverAccount } from "@/lib/auth";
import { PasswordChange } from "./password-form";

export const metadata: Metadata = { title: "Changer mon mot de passe" };

/**
 * The driver's own password. Required while it is the provisional one a
 * regulator set (requireDriver sends every roadmap request here until then),
 * available from the roadmap afterwards.
 */
export default async function DriverPasswordPage() {
  const user = await requireDriverAccount();
  return <PasswordChange forced={user.mustChangePassword} />;
}
