import type { Metadata } from "next";
import { LogOut } from "lucide-react";
import { requireDriver } from "@/lib/auth";
import { logout } from "@/app/login/actions";
import { OfflineBanner } from "./_components/offline-banner";

export const metadata: Metadata = {
  title: "Feuille de route",
  // Home-screen app on iOS (Android reads the web manifest, see app/manifest.ts).
  appleWebApp: { capable: true, title: "Opti-Taxi", statusBarStyle: "default" },
  formatDetection: { telephone: false, address: false },
};

export default async function DriverLayout({ children }: { children: React.ReactNode }) {
  const user = await requireDriver();

  return (
    <div className="mx-auto flex min-h-dvh max-w-lg flex-col bg-slate-50">
      <header className="sticky top-0 z-20 shadow-sm">
        <div className="flex items-center justify-between gap-3 bg-brand-800 py-2 pr-2 pl-4 text-white">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-brand-200">Feuille de route</p>
            <p className="truncate text-base font-semibold">{user.name}</p>
          </div>
          <form action={logout}>
            <button
              type="submit"
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-brand-50 hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <LogOut aria-hidden className="size-4" />
              Déconnexion
            </button>
          </form>
        </div>
        <OfflineBanner />
      </header>
      <main className="flex-1 px-3 pt-4 pb-[max(2rem,env(safe-area-inset-bottom))]">{children}</main>
    </div>
  );
}
