import { Card } from "@/components/ui/layout";
import type { Granularity, KpiSummary, PeriodKpis } from "@/lib/kpis";
import { interventionCount } from "@/lib/kpis-planning-time";
import { tapTotal } from "@/lib/kpis-sharing";
import { KPI_INDICATORS, targetGap, type EffectiveTargets, type KpiIndicator, type TargetSource } from "@/lib/kpis-targets";
import { MOVING_AVERAGE_DAYS, type TrendPoint } from "@/lib/kpis-trend";
import { formatKm, formatPercent } from "@/lib/labels";
import { formatDuration } from "@/lib/time";
import { BarChart } from "./bar-chart";
import {
  formatDecimal,
  formatEurosRounded,
  formatIndicator,
  formatIndicatorGap,
  formatStep,
  formatStepEdge,
  lateThreshold,
  plural,
  STEP_LABELS,
} from "./format";

type ChartSpec = {
  id: string;
  /** The indicator whose reference and objective are drawn. */
  indicator: KpiIndicator;
  title: string;
  /** How the indicator is computed, shown under the chart. */
  method: string;
  value: (summary: KpiSummary, planningMinutes: number | null) => number | null;
  period: (period: PeriodKpis) => string;
  secondary?: { primaryLabel: string; label: string; value: (summary: KpiSummary) => number | null };
};

/** The charts, in reading order; the lateness tolerance goes into the title and the method. */
export function chartSpecs(toleranceMin: number, scoped: boolean): readonly ChartSpec[] {
  return [
    {
      id: "service",
      indicator: "serviceRate",
      title: "Taux de service",
      method:
        "Courses placées sur une tournée (servies, ou patient absent quand le véhicule est venu) ÷ courses à transporter (demandées moins les annulations, la veille ou le jour même). Les courses non affectées et confiées à un confrère sont perdues. « — » tant que la journée n'est pas planifiée.",
      value: (s) => s.serviceRate,
      period: (p) =>
        scoped
          ? "Non mesurable pour un dépôt ou un type : une course laissée sans véhicule n'appartient à aucun."
          : `Sur la période : ${formatPercent(p.serviceRate, 1)} (${p.demand.unassigned} non affectées, ${p.demand.handedOver} confiées, CA perdu estimé ${formatEurosRounded(p.demand.lostRevenue)})`,
    },
    {
      id: "trips-per-vehicle",
      indicator: "tripsPerVehicle",
      title: "Courses par véhicule et par jour",
      method:
        "Courses servies ÷ véhicules dont la tournée du jour compte encore au moins un arrêt (comme le planning). Réalisé : courses déposées ÷ véhicules dont l'équipage a saisi au moins un statut ce jour (« — » si aucun) ; la journée en cours n'est pas comptée.",
      value: (s) => s.tripsPerVehiclePlanned,
      secondary: { primaryLabel: "Servi", label: "Réalisé", value: (s) => s.tripsPerVehicleRealized },
      period: (p) =>
        `Sur la période : ${formatDecimal(p.tripsPerVehiclePlanned)} servi · ${formatDecimal(p.tripsPerVehicleRealized)} réalisé${p.inProgressDate ? " hors journée en cours" : ""} · ${formatDecimal(p.tripsPerAvailableVehicle)} par véhicule disponible`,
    },
    {
      id: "fleet-use",
      indicator: "useRate",
      title: "Utilisation de la flotte",
      method:
        "Véhicules utilisés ÷ véhicules disponibles du jour (actifs, ni indisponibles ni sans équipage), d'après les équipages du jour. Un véhicule laissé au dépôt fait baisser le taux.",
      value: (s) => s.useRate,
      period: (p) =>
        p.fleet
          ? `Sur la période : ${formatPercent(p.useRate, 1)} (${p.fleet.used} sur ${plural(p.fleet.available, "journée-véhicule disponible", "journées-véhicules disponibles")})`
          : "Flotte inconnue",
    },
    {
      id: "empty-km",
      indicator: "emptyKmShare",
      title: "Part des kilomètres à vide",
      method:
        "Somme des km roulés sans aucun patient à bord (trajets depuis et vers le dépôt inclus) ÷ somme des km des tournées, d'après les distances de l'optimiseur. Plus bas = mieux.",
      value: (s) => s.emptyKmShare,
      period: (p) =>
        `Sur la période : ${formatPercent(p.emptyKmShare, 1)} (${formatKm(p.emptyKm, 0)} à vide sur ${formatKm(p.distanceKm, 0)})`,
    },
    {
      id: "shared",
      indicator: "sharedRate",
      title: "Transport partagé (périmètre CPAM)",
      method:
        "Courses partagées ÷ courses éligibles : servies en taxi ou en VSL, Assurance maladie, prescription autorisant le partage. Barres : partage servi, celui des tournées après les absences et les annulations ; points : partage mesuré aux horodatages (deux patients à bord en même temps).",
      value: (s) => s.eligibleSharedRate,
      secondary: { primaryLabel: "Servi", label: "Mesuré", value: (s) => s.measuredSharedRate },
      period: (p) =>
        `Sur la période : ${formatPercent(p.eligibleSharedRate, 1)} servi, ${formatPercent(p.measuredSharedRate, 1)} mesuré (${tapTotal(p.sharing.eligibleShared)} sur ${tapTotal(p.sharing.eligible)} éligibles)`,
    },
    {
      id: "late",
      indicator: "lateRate",
      title: toleranceMin > 0 ? `Retards au RDV (au-delà de ${toleranceMin} min)` : "Retards au RDV (sans tolérance)",
      method: `Allers dont l'heure de dépose saisie par le chauffeur (heure de Paris, à la minute près) est ${lateThreshold(toleranceMin)}, parmi les allers déposés avec une heure saisie. Le chauffeur tape « Déposé » après avoir accompagné le patient à l'accueil : d'où la tolérance, réglable en haut de page.`,
      value: (s) => (s.measuredOutbound > 0 ? s.lateRate : null),
      period: (p) =>
        `Sur la période : ${formatPercent(p.lateRate, 1)} (${p.lateArrivals} sur ${plural(p.measuredOutbound, "aller mesuré", "allers mesurés")}, ${p.lateOver15} au-delà de 15 min)`,
    },
    {
      id: "planning-time",
      indicator: "planningMinutes",
      title: "Temps passé à construire le planning",
      method:
        "Temps actif d'après le journal des actions des régulateurs : sessions coupées après 15 min sans action, jusqu'à la première validation de la journée (les retouches qui suivent sont à part, onglet « Planification »). Par semaine ou par mois, la médiane des jours. Toute l'entreprise, quel que soit le filtre.",
      value: (_s, planning) => planning,
      period: (p) =>
        `Médiane : ${p.medianPlanningMinutes === null ? "—" : formatDuration(p.medianPlanningMinutes)} sur ${plural(p.measuredPlanningDays, "jour validé", "jours validés")} · ${plural(interventionCount(p.planning.interventions), "intervention", "interventions")} après l'optimisation`,
    },
    {
      id: "margin",
      indicator: "marginPerTrip",
      title: "Marge par course",
      method:
        "(CA estimé des courses servies − coût des tournées) ÷ courses servies. CA : grilles tarifaires en base, abattement de partage inclus ; une course dont le patient était absent n'y est plus. Coût : km × coût/km + heures × coût horaire, calculés par l'optimiseur.",
      value: (s) => (s.vehicles > 0 ? s.marginPerTrip : null),
      period: (p) =>
        `Sur la période : ${formatEurosRounded(p.servedRevenue - p.cost)} de marge (CA ${formatEurosRounded(p.servedRevenue)}, coût ${formatEurosRounded(p.cost)}), ${formatEurosRounded(p.marginPerTrip)} par course`,
    },
  ];
}

const SOURCE_NOTES: Record<TargetSource, string> = {
  depot: "du dépôt",
  company: "de l'entreprise",
  protocol: "du protocole 2027",
};

/** The focus value against the objective: « obj. 4,5 · −0,3 » (an arrow and a word would repeat the chart). */
function TargetLine({ indicator, value, targets }: { indicator: KpiIndicator; value: number | null; targets: EffectiveTargets }) {
  const target = targets[indicator];
  const unit = KPI_INDICATORS[indicator].unit;
  if (target.objective === null) return null;
  const gap = targetGap(value, target.objective);
  const better = gap === null ? null : KPI_INDICATORS[indicator].higherIsBetter ? gap >= 0 : gap <= 0;
  return (
    <span className="block text-[11px] text-slate-600" title={`Objectif ${target.objectiveSource ? SOURCE_NOTES[target.objectiveSource] : ""}`}>
      obj. <span className="tabular">{formatIndicator(unit, target.objective)}</span>
      {gap !== null ? (
        <>
          {" · "}
          <span className={better ? "tabular font-medium text-emerald-700" : "tabular font-medium text-red-700"}>
            {formatIndicatorGap(unit, gap)}
          </span>
          <span className="sr-only">{better ? " (objectif atteint)" : " (en deçà de l'objectif)"}</span>
        </>
      ) : null}
    </span>
  );
}

/** One small chart per indicator: bars by day, week or month, the moving average, the reference and the objective. */
export function KpiCharts({
  points,
  period,
  granularity,
  focusDate,
  toleranceMin,
  targets,
  scoped,
}: {
  points: readonly TrendPoint[];
  period: PeriodKpis;
  granularity: Granularity;
  focusDate: string | null;
  toleranceMin: number;
  targets: EffectiveTargets;
  scoped: boolean;
}) {
  const focus = (focusDate ? points.find((p) => p.from <= focusDate && p.to >= focusDate) : null) ?? null;
  const averageLabel = granularity === "day" ? `Moy. ${MOVING_AVERAGE_DAYS} j ouvrés` : undefined;
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      {chartSpecs(toleranceMin, scoped).map((spec) => {
        const definition = KPI_INDICATORS[spec.indicator];
        const format = (value: number) => formatIndicator(definition.unit, value);
        const focusValue = focus ? spec.value(focus.summary, focus.planningMinutes) : null;
        const target = targets[spec.indicator];
        const chartPoints = points.map((p) => ({
          date: p.key,
          value: spec.value(p.summary, p.planningMinutes),
          ...(spec.secondary ? { secondary: spec.secondary.value(p.summary) } : {}),
          ...(p.average ? { average: spec.value(p.average.summary, p.average.planningMinutes) } : {}),
        }));
        return (
          <Card key={spec.id} className="flex flex-col">
            <div className="flex items-start justify-between gap-3 px-4 pt-3">
              <h3 className="text-sm font-semibold text-slate-900">{spec.title}</h3>
              {focus ? (
                <p className="shrink-0 text-right">
                  <span className="block text-lg leading-tight font-semibold text-slate-900">{focusValue === null ? "—" : format(focusValue)}</span>
                  <span className="block text-[11px] text-slate-500">{formatStep(focus.key, granularity)}</span>
                  <TargetLine indicator={spec.indicator} value={focusValue} targets={targets} />
                </p>
              ) : null}
            </div>
            <div className="px-4 pt-2 pb-3">
              <BarChart
                title={spec.title}
                points={chartPoints}
                format={format}
                formatKey={(key) => formatStep(key, granularity)}
                formatEdge={(key) => formatStepEdge(key, granularity)}
                focusDate={focus?.key ?? null}
                primaryLabel={spec.secondary ? spec.secondary.primaryLabel : STEP_LABELS[granularity]}
                secondaryLabel={spec.secondary?.label}
                averageLabel={averageLabel}
                guides={{ reference: target.reference, objective: target.objective }}
              />
            </div>
            <div className="mt-auto space-y-1 border-t border-slate-100 px-4 py-3 text-xs">
              <p className="tabular font-medium text-slate-700">{spec.period(period)}</p>
              <details className="text-slate-500">
                <summary className="cursor-pointer font-medium text-slate-600 hover:text-slate-900">Calcul</summary>
                <p className="mt-1">{spec.method}</p>
              </details>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
