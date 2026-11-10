import { requireUser } from "@/lib/auth";
import { logout } from "@/app/login/actions";
import { RegulatorNav, type NavCounts } from "@/components/nav/regulator-nav";
import { countPrescriptionWork } from "@/app/(regulator)/patients/_lib/work-list-db";
import { logError } from "@/lib/log";
import { todayIso } from "@/lib/time";

/** Counters of the navigation: one count query; a failure shows no counter, never breaks the page. */
async function navCounts(): Promise<NavCounts> {
  try {
    return { "/prescriptions": await countPrescriptionWork(todayIso()) };
  } catch (error) {
    logError("[nav] counting the prescriptions to handle failed", error);
    return {};
  }
}

export default async function RegulatorLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser("REGULATOR");
  const counts = await navCounts();

  return (
    <div className="flex min-h-below-banner">
      {/* First stop of the keyboard: past the menu, straight to the page (seen only with the focus). */}
      <a
        href="#contenu"
        className="sr-only z-[70] rounded-md bg-white text-sm font-medium text-brand-800 shadow-md ring-2 ring-brand-600 focus:not-sr-only focus:fixed focus:top-[calc(var(--demo-banner-h,0px)+0.5rem)] focus:left-2 focus:px-3 focus:py-2 focus:outline-none print:hidden"
      >
        Aller au contenu
      </a>
      {/* The column (white, bordered) runs the page's whole height; its content stays pinned to the screen. */}
      <aside className="hidden w-60 shrink-0 border-r border-slate-200 bg-white lg:block print:hidden">
        <div className="sticky top-below-banner flex h-below-banner flex-col">
          <div className="border-b border-slate-200 px-5 py-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-brand-700">Taxi & Ambulance V</p>
            <p className="text-lg font-semibold tracking-tight text-slate-900">Opti-Taxi</p>
          </div>
          <RegulatorNav counts={counts} />
          <div className="mt-auto border-t border-slate-200 px-5 py-3 text-sm">
            <p className="truncate font-medium text-slate-800">{user.name}</p>
            <form action={logout}>
              <button
                type="submit"
                title="Ferme la session sur tous vos appareils"
                className="-mx-1 inline-flex min-h-6 items-center rounded px-1 text-xs text-slate-600 underline-offset-2 hover:text-slate-900 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600"
              >
                Se déconnecter
              </button>
            </form>
          </div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 lg:hidden print:hidden">
          <p className="font-semibold text-slate-900">Opti-Taxi</p>
          <form action={logout}>
            <button
              type="submit"
              title="Ferme la session sur tous vos appareils"
              className="inline-flex min-h-6 items-center rounded px-1 text-sm text-slate-600 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-brand-600"
            >
              Se déconnecter
            </button>
          </form>
        </header>
        <div className="border-b border-slate-200 bg-white lg:hidden print:hidden">
          <RegulatorNav horizontal counts={counts} />
        </div>
        <main id="contenu" tabIndex={-1} className="min-w-0 flex-1 px-4 py-6 outline-none sm:px-6 lg:px-8 print:p-0">
          {children}
        </main>
      </div>
    </div>
  );
}
