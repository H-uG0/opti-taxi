import type { Metadata } from "next";
import { LogOut } from "lucide-react";
import { requireDriverAccount } from "@/lib/auth";
import { cn } from "@/components/ui/cn";
import { logout } from "@/app/login/actions";
import { OfflineBanner } from "./_components/offline-banner";
import { RegulatorCallButton } from "./_components/regulator-call";
import { loadRegulatorContact } from "./_lib/load";

export const metadata: Metadata = {
  title: "Feuille de route",
  // Home-screen app on iOS (Android reads the web manifest, see app/manifest.ts).
  appleWebApp: { capable: true, title: "Opti-Taxi", statusBarStyle: "default" },
  formatDetection: { telephone: false, address: false },
};

/**
 * Logout keeps its visible label in both layouts. Next to the call button the
 * label goes under the icon, so the header still fits on a 390 px phone.
 */
function LogoutButton({ stacked }: { stacked: boolean }) {
  return (
    <form action={logout}>
      <button
        type="submit"
        title="Ferme la session sur tous vos appareils"
        className={cn(
          "inline-flex min-h-11 items-center rounded-lg font-medium text-brand-50 hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white",
          stacked ? "min-w-11 flex-col justify-center gap-1 px-1 text-[11px] leading-none" : "gap-1.5 px-3 text-sm",
        )}
      >
        <LogOut aria-hidden className="size-4" />
        Déconnexion
      </button>
    </form>
  );
}

export default async function DriverLayout({ children }: { children: React.ReactNode }) {
  // Not requireDriver: the layout also frames the page where a provisional password is changed.
  // Each page checks its own access (the roadmap: requireDriver).
  const user = await requireDriverAccount();
  const regulator = await loadRegulatorContact();

  return (
    <div className="mx-auto flex min-h-below-banner max-w-lg flex-col bg-slate-50">
      <header className="sticky top-below-banner z-20 shadow-sm">
        <div
          className={cn(
            "flex items-center justify-between bg-brand-800 py-2 pr-2 pl-4 text-white",
            regulator ? "gap-2" : "gap-3",
          )}
        >
          <div className="min-w-0">
            <p
              className={cn(
                "truncate text-[11px] font-semibold uppercase tracking-[0.18em] text-brand-200",
                // Tighter letters on 360 px phones, where the call button leaves less room.
                regulator && "max-[379px]:tracking-[0.08em]",
              )}
            >
              Feuille de route
            </p>
            <p className="truncate text-base font-semibold">{user.name}</p>
          </div>
          {regulator ? (
            <div className="flex shrink-0 items-center gap-2">
              {/* Sticky header: the call stays one tap away while scrolling the stops. */}
              <RegulatorCallButton regulator={regulator} />
              {/* Gaps + divider: a thumb slipping off the call button must not sign the driver out. */}
              <span aria-hidden className="h-8 w-px shrink-0 bg-brand-600" />
              <LogoutButton stacked />
            </div>
          ) : (
            <LogoutButton stacked={false} />
          )}
        </div>
        <OfflineBanner />
      </header>
      <main className="flex-1 px-3 pt-4 pb-[max(2rem,env(safe-area-inset-bottom))]">{children}</main>
    </div>
  );
}
