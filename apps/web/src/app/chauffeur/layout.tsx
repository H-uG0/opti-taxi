import type { Metadata } from "next";
import { requireDriver } from "@/lib/auth";
import { logout } from "@/app/login/actions";

export const metadata: Metadata = { title: "Feuille de route" };

export default async function DriverLayout({ children }: { children: React.ReactNode }) {
  const user = await requireDriver();

  return (
    <div className="mx-auto flex min-h-dvh max-w-lg flex-col bg-slate-50">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-brand-800 px-4 py-3 text-white">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-brand-200">Feuille de route</p>
          <p className="text-base font-semibold">{user.name}</p>
        </div>
        <form action={logout}>
          <button type="submit" className="rounded-md px-2 py-1 text-sm text-brand-100 hover:bg-brand-700">
            Déconnexion
          </button>
        </form>
      </header>
      <main className="flex-1 px-3 py-4">{children}</main>
    </div>
  );
}
