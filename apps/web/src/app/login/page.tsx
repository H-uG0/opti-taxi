import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser, ROLE_HOME } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Connexion" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await getCurrentUser();
  if (user) redirect(ROLE_HOME[user.role]);
  const { error } = await searchParams;

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-700">Taxi & Ambulance V</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">Opti-Taxi</h1>
          <p className="mt-1 text-sm text-slate-600">Planification des tournées</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <LoginForm notice={error === "no-driver" ? "Ce compte chauffeur n'est relié à aucune fiche chauffeur." : null} />
        </div>
      </div>
    </main>
  );
}
