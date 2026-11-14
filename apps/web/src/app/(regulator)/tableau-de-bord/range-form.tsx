import type { VehicleType } from "@prisma/client";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Input, Select } from "@/components/ui/form";
import { GRANULARITY_PARAMS, LATE_TOLERANCES, type Granularity, type KpiRange } from "@/lib/kpis";
import { rangePresets } from "@/lib/kpis-trend";
import { VEHICLE_TYPE_LABELS } from "@/lib/labels";
import { DASHBOARD_TABS, dashboardHref, type HrefState } from "./query";

const STEP_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Automatique" },
  { value: GRANULARITY_PARAMS.day, label: "Jour" },
  { value: GRANULARITY_PARAMS.week, label: "Semaine" },
  { value: GRANULARITY_PARAMS.month, label: "Mois" },
];

/**
 * Period, step, lateness tolerance and scope (depot, vehicle type) of the
 * dashboard: one GET form above every tab (works without JavaScript; the tab
 * shown is kept), and the shortcuts of the period, which keep the tolerance
 * and the scope.
 */
export function RangeForm({
  range,
  base,
  today,
  tomorrow,
  depots,
}: {
  range: KpiRange;
  base: HrefState;
  today: string;
  tomorrow: string;
  depots: readonly { id: string; name: string; active: boolean }[];
}) {
  const presets = rangePresets(today, tomorrow);
  return (
    <div className="space-y-3">
      <form action="/tableau-de-bord" method="get" className="flex flex-wrap items-end gap-3">
        {base.tab && base.tab !== "synthese" ? <input type="hidden" name="vue" value={base.tab} /> : null}
        {base.axis && base.axis !== "depot" ? <input type="hidden" name="par" value={base.axis} /> : null}
        <div className="space-y-1">
          <label htmlFor="kpi-from" className="block text-sm font-medium text-slate-700">
            Du
          </label>
          <Input id="kpi-from" type="date" name="from" defaultValue={range.from} required className="tabular w-auto" />
        </div>
        <div className="space-y-1">
          <label htmlFor="kpi-to" className="block text-sm font-medium text-slate-700">
            Au
          </label>
          <Input id="kpi-to" type="date" name="to" defaultValue={range.to} required className="tabular w-auto" />
        </div>
        <div className="space-y-1">
          <label htmlFor="kpi-step" className="block text-sm font-medium text-slate-700">
            Par
          </label>
          <Select
            id="kpi-step"
            name="pas"
            defaultValue={range.explicitGranularity ? GRANULARITY_PARAMS[range.granularity] : ""}
            className="w-auto"
          >
            {STEP_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <label htmlFor="kpi-depot" className="block text-sm font-medium text-slate-700">
            Dépôt
          </label>
          <Select id="kpi-depot" name="depot" defaultValue={base.depotId ?? ""} className="w-auto">
            <option value="">Tous</option>
            {depots.map((depot) => (
              <option key={depot.id} value={depot.id}>
                {depot.name}
                {depot.active ? "" : " (désactivé)"}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <label htmlFor="kpi-type" className="block text-sm font-medium text-slate-700">
            Véhicules
          </label>
          <Select id="kpi-type" name="type" defaultValue={base.vehicleType ?? ""} className="w-auto">
            <option value="">Tous types</option>
            {(Object.keys(VEHICLE_TYPE_LABELS) as VehicleType[]).map((type) => (
              <option key={type} value={type}>
                {VEHICLE_TYPE_LABELS[type]}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <label htmlFor="kpi-late" className="block text-sm font-medium text-slate-700">
            En retard au-delà de
          </label>
          <Select id="kpi-late" name="retard" defaultValue={String(base.tolerance ?? 5)} className="tabular w-auto">
            {LATE_TOLERANCES.map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes === 0 ? "l'heure du RDV" : `${minutes} min après le RDV`}
              </option>
            ))}
          </Select>
        </div>
        <button type="submit" className={buttonClasses("secondary")}>
          Afficher
        </button>
      </form>
      <nav aria-label="Périodes prédéfinies" className="flex flex-wrap items-center gap-1">
        <span className="mr-1 text-xs text-slate-600">Raccourcis&nbsp;:</span>
        {presets.map((preset) => {
          const granularity: Granularity | null = preset.granularity;
          const active = range.from === preset.from && range.to === preset.to;
          return (
            <Link
              key={preset.id}
              href={dashboardHref({ ...base, from: preset.from, to: preset.to, granularity, day: null })}
              aria-current={active ? "true" : undefined}
              className={cn(buttonClasses("ghost", "sm"), active && "bg-brand-50 text-brand-800 hover:bg-brand-100")}
            >
              {preset.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/** The tabs of the dashboard: links (each its own address, shareable), the current one marked for assistive technologies. */
export function DashboardTabs({ base }: { base: HrefState }) {
  return (
    <nav aria-label="Rubriques du tableau de bord" className="print:hidden">
      <ul className="flex flex-wrap gap-1 border-b border-slate-200">
        {DASHBOARD_TABS.map((tab) => {
          const active = (base.tab ?? "synthese") === tab.id;
          return (
            <li key={tab.id}>
              <Link
                href={dashboardHref({ ...base, tab: tab.id, sort: null })}
                title={tab.title}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px flex h-9 items-center border-b-2 px-3 text-sm font-medium whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-600",
                  active ? "border-brand-700 text-brand-800" : "border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900",
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
