import { Card } from "@/components/ui/layout";
import type { DayKpis, PeriodKpis } from "@/lib/kpis";
import { tapTotal } from "@/lib/kpis-sharing";
import { formatKm, formatPercent } from "@/lib/labels";
import { formatDuration } from "@/lib/time";
import { BarChart } from "./bar-chart";
import { formatDayShort, formatDecimal, formatEurosRounded, lateThreshold, plural } from "./format";

type ChartSpec = {
  id: string;
  title: string;
  /** How the indicator is computed, shown under the chart. */
  method: string;
  value: (day: DayKpis) => number | null;
  format: (value: number) => string;
  period: (period: PeriodKpis) => string;
  primaryLabel?: string;
  secondary?: { label: string; value: (day: DayKpis) => number | null };
};

const percent = (value: number) => formatPercent(value, 1);

/** The charts, in reading order; the lateness tolerance goes into the title and the method. */
export function chartSpecs(toleranceMin: number): readonly ChartSpec[] {
  return [
    {
      id: "service",
      title: "Taux de service",
      method:
        "Courses placées sur une tournée (servies, ou patient absent quand le véhicule est venu) ÷ courses à transporter (demandées moins les annulations, la veille ou le jour même). Les courses non affectées et confiées à un confrère sont perdues. «\u202f—\u202f» tant que la journée n'est pas planifiée.",
      value: (d) => d.serviceRate,
      format: percent,
      period: (p) =>
        `Sur la période\u00a0: ${formatPercent(p.serviceRate, 1)} (${p.demand.unassigned} non affectées, ${p.demand.handedOver} confiées, CA perdu estimé ${formatEurosRounded(p.demand.lostRevenue)})`,
    },
    {
      id: "trips-per-vehicle",
      title: "Courses par véhicule et par jour",
      method:
        "Courses servies ÷ véhicules dont la tournée du jour compte encore au moins un arrêt (comme le planning). Réalisé\u00a0: courses déposées ÷ véhicules dont l'équipage a saisi au moins un statut ce jour («\u202f—\u202f» si aucun)\u202f; sur la période, la journée en cours n'est pas comptée.",
      value: (d) => d.tripsPerVehiclePlanned,
      format: (v) => formatDecimal(v),
      primaryLabel: "Servi",
      secondary: { label: "Réalisé", value: (d) => d.tripsPerVehicleRealized },
      period: (p) =>
        `Sur la période\u00a0: ${formatDecimal(p.tripsPerVehiclePlanned)} servi · ${formatDecimal(p.tripsPerVehicleRealized)} réalisé${p.inProgressDate ? " hors journée en cours" : ""} · ${formatDecimal(p.tripsPerAvailableVehicle)} par véhicule disponible`,
    },
    {
      id: "fleet-use",
      title: "Utilisation de la flotte",
      method:
        "Véhicules utilisés ÷ véhicules disponibles du jour (actifs, ni indisponibles ni sans équipage), d'après les équipages du jour. Un véhicule laissé au dépôt fait baisser le taux.",
      value: (d) => d.useRate,
      format: percent,
      period: (p) =>
        p.fleet
          ? `Sur la période\u00a0: ${formatPercent(p.useRate, 1)} (${p.fleet.used} sur ${plural(p.fleet.available, "journée-véhicule disponible", "journées-véhicules disponibles")})`
          : "Flotte inconnue",
    },
    {
      id: "empty-km",
      title: "Part des kilomètres à vide",
      method:
        "Somme des km roulés sans aucun patient à bord (trajets depuis et vers le dépôt inclus) ÷ somme des km des tournées, d'après les distances de l'optimiseur. Plus bas = mieux.",
      value: (d) => d.emptyKmShare,
      format: percent,
      period: (p) =>
        `Sur la période\u00a0: ${formatPercent(p.emptyKmShare, 1)} (${formatKm(p.emptyKm, 0)} à vide sur ${formatKm(p.distanceKm, 0)})`,
    },
    {
      id: "shared",
      title: "Transport partagé (périmètre CPAM)",
      method:
        "Courses partagées ÷ courses éligibles\u00a0: servies en taxi ou en VSL, Assurance maladie, prescription autorisant le partage. Barres\u00a0: partage servi, celui des tournées après les absences et les annulations\u202f; points\u00a0: partage mesuré aux horodatages (deux patients à bord en même temps).",
      value: (d) => d.eligibleSharedRate,
      format: percent,
      primaryLabel: "Servi",
      secondary: { label: "Mesuré", value: (d) => d.measuredSharedRate },
      period: (p) =>
        `Sur la période\u00a0: ${formatPercent(p.eligibleSharedRate, 1)} servi, ${formatPercent(p.measuredSharedRate, 1)} mesuré (${tapTotal(p.sharing.eligibleShared)} sur ${tapTotal(p.sharing.eligible)} éligibles)`,
    },
    {
      id: "late",
      title: toleranceMin > 0 ? `Retards au RDV (au-delà de ${toleranceMin}\u00a0min)` : "Retards au RDV (sans tolérance)",
      method: `Allers dont l'heure de dépose saisie par le chauffeur (heure de Paris, à la minute près) est ${lateThreshold(toleranceMin)}, parmi les allers déposés avec une heure saisie. Le chauffeur tape «\u202fDéposé\u202f» après avoir accompagné le patient à l'accueil\u00a0: d'où la tolérance, réglable en haut de page.`,
      value: (d) => (d.measuredOutbound > 0 ? d.lateRate : null),
      format: percent,
      period: (p) =>
        `Sur la période\u00a0: ${formatPercent(p.lateRate, 1)} (${p.lateArrivals} sur ${plural(p.measuredOutbound, "aller mesuré", "allers mesurés")}, ${p.lateOver15} au-delà de 15\u00a0min)`,
    },
    {
      id: "planning-time",
      title: "Temps passé à construire le planning",
      method:
        "Du lancement de la première optimisation de la date à la validation des tournées (la plus tardive). «\u202fNon validé\u202f» tant que toutes les tournées du jour ne sont pas validées.",
      value: (d) => d.planningMinutes,
      format: (v) => formatDuration(v),
      period: (p) =>
        `Moyenne\u00a0: ${p.averagePlanningMinutes === null ? "—" : formatDuration(p.averagePlanningMinutes)} sur ${plural(p.measuredPlanningDays, "jour validé", "jours validés")} · ${plural(p.optimizationRuns, "optimisation lancée", "optimisations lancées")}`,
    },
    {
      id: "margin",
      title: "Marge estimée",
      method:
        "CA estimé des courses servies (grilles tarifaires en base, abattement de partage inclus\u202f; une course dont le patient était absent n'y est plus) − coût des tournées (km × coût/km + heures × coût horaire), calculés par l'optimiseur.",
      value: (d) => (d.vehicles > 0 ? d.servedRevenue - d.cost : null),
      format: (v) => formatEurosRounded(v),
      period: (p) =>
        `Sur la période\u00a0: ${formatEurosRounded(p.servedRevenue - p.cost)} (CA ${formatEurosRounded(p.servedRevenue)}, coût ${formatEurosRounded(p.cost)}, ${formatEurosRounded(p.marginPerTrip)} par course)`,
    },
  ];
}

/** One small chart per indicator, with its methodology. */
export function KpiCharts({
  days,
  period,
  focusDate,
  toleranceMin,
}: {
  days: readonly DayKpis[];
  period: PeriodKpis;
  focusDate: string | null;
  toleranceMin: number;
}) {
  const focus = days.find((d) => d.date === focusDate) ?? null;
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {chartSpecs(toleranceMin).map((spec) => {
        const focusValue = focus ? spec.value(focus) : null;
        const points = days.map((d) => ({
          date: d.date,
          value: spec.value(d),
          ...(spec.secondary ? { secondary: spec.secondary.value(d) } : {}),
        }));
        return (
          <Card key={spec.id} className="flex flex-col">
            <div className="flex items-start justify-between gap-3 px-4 pt-3">
              <h3 className="text-sm font-semibold text-slate-900">
                {spec.title}
              </h3>
              {focus ? (
                <p className="shrink-0 text-right">
                  <span className="block text-lg leading-tight font-semibold text-slate-900">
                    {focusValue === null ? "—" : spec.format(focusValue)}
                  </span>
                  <span className="block text-[11px] text-slate-500">{formatDayShort(focus.date)}</span>
                </p>
              ) : null}
            </div>
            <div className="px-4 pt-2 pb-3">
              <BarChart
                title={spec.title}
                points={points}
                format={spec.format}
                focusDate={focusDate}
                primaryLabel={spec.secondary ? spec.primaryLabel : undefined}
                secondaryLabel={spec.secondary?.label}
              />
            </div>
            <div className="mt-auto space-y-1 border-t border-slate-100 px-4 py-3 text-xs">
              <p className="tabular font-medium text-slate-700">{spec.period(period)}</p>
              <p className="text-slate-500">
                <span className="font-medium text-slate-600">Calcul&nbsp;: </span>
                {spec.method}
              </p>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
