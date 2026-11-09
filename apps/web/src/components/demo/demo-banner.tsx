import { isDemoMode } from "@/lib/demo";

/**
 * Strip at the top of every page in demo mode (DEMO_MODE=1, lib/demo.ts): the
 * data is fictitious and the accounts' passwords are public, so nobody should
 * type real patient data there. Server component, read per request.
 */
export function DemoBanner() {
  if (!isDemoMode()) return null;
  return (
    <div role="note" className="bg-amber-300 px-4 py-1 text-center text-xs font-semibold text-amber-950 print:hidden">
      DÉMO — données fictives
      <span className="font-normal max-sm:hidden"> · identifiants publics : ne saisissez aucune donnée réelle</span>
    </div>
  );
}
