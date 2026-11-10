import { isDemoMode } from "@/lib/demo";

/**
 * Strip at the top of every page in demo mode (DEMO_MODE=1, lib/demo.ts): the
 * data is fictitious and the accounts' passwords are public, so nobody should
 * type real patient data there. Server component, read per request.
 *
 * It stays at the top while the page scrolls, and its height is the
 * --demo-banner-h the root layout sets in demo mode: full-height layouts and
 * sticky elements subtract it (min-h-below-banner, top-below-banner…).
 */
export function DemoBanner() {
  if (!isDemoMode()) return null;
  return (
    <div
      role="note"
      className="sticky top-0 z-40 flex h-(--demo-banner-h) items-center justify-center overflow-hidden bg-amber-300 px-4 text-xs whitespace-nowrap font-semibold text-amber-950 print:hidden"
    >
      DÉMO — données fictives
      <span className="font-normal max-sm:hidden">&nbsp;· identifiants publics&nbsp;: ne saisissez aucune donnée réelle</span>
    </div>
  );
}
