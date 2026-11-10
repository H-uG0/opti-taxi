import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Input } from "@/components/ui/form";
import { addDays } from "@/lib/time";

const PRESETS = [7, 14, 30, 90] as const;


export function dashboardHref(params: { from: string; to: string; day?: string | null }): string {
  const query = new URLSearchParams({ from: params.from, to: params.to });
  if (params.day) query.set("day", params.day);
  return `/tableau-de-bord?${query.toString()}`;
}

/**
 * Period of the dashboard: a GET form (works without JavaScript) and
 * shortcuts for the last N days through J+1.
 */
export function RangeForm({ from, to, tomorrow }: { from: string; to: string; tomorrow: string }) {
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
      <form action="/tableau-de-bord" method="get" className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label htmlFor="kpi-from" className="block text-sm font-medium text-slate-700">
            Du
          </label>
          <Input id="kpi-from" type="date" name="from" defaultValue={from} required className="tabular w-auto" />
        </div>
        <div className="space-y-1">
          <label htmlFor="kpi-to" className="block text-sm font-medium text-slate-700">
            Au
          </label>
          <Input id="kpi-to" type="date" name="to" defaultValue={to} required className="tabular w-auto" />
        </div>
        <button type="submit" className={buttonClasses("secondary")}>
          Afficher
        </button>
      </form>
      <nav aria-label="Périodes prédéfinies" className="flex flex-wrap items-center gap-1">
        <span className="mr-1 text-xs text-slate-500">Jusqu&apos;à J+1 :</span>
        {PRESETS.map((days) => {
          const presetFrom = addDays(tomorrow, -(days - 1));
          const active = from === presetFrom && to === tomorrow;
          return (
            <Link
              key={days}
              href={dashboardHref({ from: presetFrom, to: tomorrow })}
              aria-current={active ? "true" : undefined}
              className={cn(buttonClasses("ghost", "sm"), active && "bg-brand-50 text-brand-800 hover:bg-brand-100")}
            >
              {days} jours
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
