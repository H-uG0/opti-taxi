import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireDriverAccount } from "@/lib/auth";
import { PasswordForm } from "./password-form";

export const metadata: Metadata = { title: "Changer mon mot de passe" };

/**
 * The driver's own password. Required while it is the provisional one a
 * regulator set (requireDriver sends every roadmap request here until then),
 * available from the roadmap afterwards.
 */
export default async function DriverPasswordPage() {
  const user = await requireDriverAccount();
  const forced = user.mustChangePassword;

  return (
    <div className="space-y-4">
      {forced ? null : (
        <Link
          href="/chauffeur"
          className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-brand-800 underline-offset-2 hover:underline"
        >
          <ArrowLeft aria-hidden className="size-4" />
          Feuille de route
        </Link>
      )}
      <h1 className="text-xl font-bold text-slate-950">
        {forced ? "Choisissez votre mot de passe" : "Changer mon mot de passe"}
      </h1>
      {forced ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          Votre mot de passe est provisoire : la régulation vous l&apos;a donné. Choisissez le vôtre pour ouvrir
          votre feuille de route ; personne d&apos;autre ne le connaîtra.
        </p>
      ) : (
        <p className="text-sm text-slate-600">
          Après le changement, vos sessions ouvertes sur d&apos;autres appareils sont fermées.
        </p>
      )}
      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <PasswordForm />
      </div>
    </div>
  );
}
