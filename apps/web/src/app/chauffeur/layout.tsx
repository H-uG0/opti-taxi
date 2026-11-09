import type { Metadata } from "next";
import { requireDriverAccount } from "@/lib/auth";
import { sessionExpiresAt } from "@/lib/auth/session";
import { cn } from "@/components/ui/cn";
import { DriverAppProvider } from "./_components/driver-app";
import { FieldStatusBars } from "./_components/field-status";
import { LogoutButton } from "./_components/logout-button";
import { RegulatorCallButton } from "./_components/regulator-call";
import { loadRegulatorContact } from "./_lib/load";

export const metadata: Metadata = {
  title: "Feuille de route",
  // Home-screen app on iOS (Android reads the web manifest, see app/manifest.ts).
  appleWebApp: { capable: true, title: "Opti-Taxi", statusBarStyle: "default" },
  formatDetection: { telephone: false, address: false },
};

export default async function DriverLayout({ children }: { children: React.ReactNode }) {
  // Not requireDriver: the layout also frames the page where a provisional password is changed.
  // Each page checks its own access (the roadmap: requireDriver).
  const user = await requireDriverAccount();
  const [regulator, expiresAt] = await Promise.all([loadRegulatorContact(), sessionExpiresAt()]);

  return (
    <DriverAppProvider
      ownerId={user.id}
      mustChangePassword={user.mustChangePassword}
      sessionExpiresAt={expiresAt?.toISOString() ?? null}
      regulator={regulator}
    >
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
          <FieldStatusBars />
        </header>
        <main className="flex-1 px-3 pt-4 pb-[max(2rem,env(safe-area-inset-bottom))]">{children}</main>
      </div>
    </DriverAppProvider>
  );
}
