import { Card } from "@/components/ui/layout";
import type { DayKpis, PeriodKpis } from "@/lib/kpis";
import { formatKm, formatPercent } from "@/lib/labels";
import { formatDuration } from "@/lib/time";
import { BarChart } from "./bar-chart";
import {
  formatDayShort,
  formatDecimal,
  formatEurosRounded,
  measuredLateArrivals,
  plannedMargin,
  plural,
} from "./format";

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
const count = (value: number) => String(Math.round(value));

export const CHART_SPECS: readonly ChartSpec[] = [
  {
    id: "trips-per-vehicle",
    title: "Courses facturées par véhicule et par jour",
    method:
      "Courses servies (dans une tournée : planifiées, prises en charge ou déposées) ÷ véhicules dont la tournée du jour compte encore au moins un arrêt (comme le planning). Réalisé : courses déposées ÷ véhicules dont l'équipage a saisi au moins un statut ce jour (« — » si aucun) ; sur la période, la journée en cours n'est pas comptée. Courses annulées, absentes ou non affectées exclues.",
    value: (d) => d.tripsPerVehiclePlanned,
    format: (v) => formatDecimal(v),
    primaryLabel: "Prévu",
    secondary: { label: "Réalisé", value: (d) => d.tripsPerVehicleRealized },
    period: (p) =>
      `Sur la période : ${formatDecimal(p.tripsPerVehiclePlanned)} prévu · ${formatDecimal(p.tripsPerVehicleRealized)} réalisé${p.inProgressDate ? " hors journée en cours" : ""} (${plural(p.servedTrips, "course")}, ${plural(p.vehicles, "journée-véhicule", "journées-véhicules")})`,
  },
  {
    id: "empty-km",
    title: "Part des kilomètres à vide",
    method:
      "Somme des km roulés sans aucun patient à bord (trajets depuis et vers le dépôt inclus) ÷ somme des km des tournées, d'après les distances de l'optimiseur. Plus bas = mieux.",
    value: (d) => d.emptyKmShare,
    format: percent,
    period: (p) =>
      `Sur la période : ${formatPercent(p.emptyKmShare, 1)} (${formatKm(p.emptyKm, 0)} à vide sur ${formatKm(p.distanceKm, 0)})`,
  },
  {
    id: "shared",
    title: "Taux de transport partagé",
    method:
      "Courses servies effectuées avec au moins un autre patient à bord ÷ courses servies (même périmètre que l'indicateur courses par véhicule).",
    value: (d) => d.sharedRate,
    format: percent,
    period: (p) => `Sur la période : ${formatPercent(p.sharedRate, 1)} (${p.sharedTrips} sur ${p.servedTrips} courses)`,
  },
  {
    id: "late",
    title: "Patients arrivés après l'heure du RDV",
    method:
      "Allers déposés dont l'heure de dépose saisie par le chauffeur (heure de Paris, à la minute près) dépasse l'heure du RDV, parmi les allers déposés avec une heure saisie. Retard prévu : dépose planifiée après le RDV, doit rester à 0.",
    value: measuredLateArrivals,
    format: count,
    period: (p) =>
      `Sur la période : ${p.lateArrivals} sur ${plural(p.measuredOutbound, "aller mesuré", "allers mesurés")} (${formatPercent(p.lateRate, 1)}) · prévus en retard : ${p.plannedLateArrivals}`,
  },
  {
    id: "planning-time",
    title: "Temps passé à construire le planning",
    method:
      "Du lancement de la première optimisation de la date à la validation des tournées (la plus tardive). « Non validé » tant que toutes les tournées du jour ne sont pas validées.",
    value: (d) => d.planningMinutes,
    format: (v) => formatDuration(v),
    period: (p) =>
      `Moyenne : ${p.averagePlanningMinutes === null ? "—" : formatDuration(p.averagePlanningMinutes)} sur ${plural(p.measuredPlanningDays, "jour validé", "jours validés")} · ${plural(p.optimizationRuns, "optimisation lancée", "optimisations lancées")}`,
  },
  {
    id: "margin",
    title: "Marge estimée",
    method:
      "CA estimé des courses (grilles tarifaires en base, abattement de partage inclus) − coût des tournées (km × coût/km + heures × coût horaire), calculés par l'optimiseur.",
    value: plannedMargin,
    format: (v) => formatEurosRounded(v),
    period: (p) =>
      `Sur la période : ${formatEurosRounded(p.margin)} (CA ${formatEurosRounded(p.revenue)}, coût ${formatEurosRounded(p.cost)})`,
  },
];

/** One small chart per indicator, with its methodology. */
export function KpiCharts({
  days,
  period,
  focusDate,
}: {
  days: readonly DayKpis[];
  period: PeriodKpis;
  focusDate: string | null;
}) {
  const focus = days.find((d) => d.date === focusDate) ?? null;
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {CHART_SPECS.map((spec) => {
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
                <span className="font-medium text-slate-600">Calcul : </span>
                {spec.method}
              </p>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
