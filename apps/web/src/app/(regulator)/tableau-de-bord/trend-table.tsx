import Link from "next/link";
import { Table, TBody, THead } from "@/components/ui/table";
import type { Granularity, KpiSummary, PeriodKpis } from "@/lib/kpis";
import { lostTrips, tripsToCarry } from "@/lib/kpis-demand";
import type { TrendPoint } from "@/lib/kpis-trend";
import { formatKm, formatPercent } from "@/lib/labels";
import { formatDuration, formatLongDate } from "@/lib/time";
import { formatDayMonth, formatDecimal, formatEurosRounded, formatStep, plural } from "./format";
import { SCOPED_DEMAND } from "./kpi-table";
import { dashboardHref, type HrefState } from "./query";

const HEAD_BASE = "px-2 py-2 text-xs font-semibold whitespace-nowrap text-slate-600 uppercase";
const HEAD = `${HEAD_BASE} text-right`;
const HEAD_LEFT = `${HEAD_BASE} text-left`;
const NUM = "tabular px-2 py-2 text-right whitespace-nowrap";

function Cells({ s, planningMinutes, strong = false }: { s: KpiSummary & { scoped?: boolean }; planningMinutes: number | null; strong?: boolean }) {
  const num = strong ? `${NUM} font-semibold text-slate-900` : `${NUM} text-slate-800`;
  const warn = strong ? `${NUM} font-semibold text-amber-700` : `${NUM} text-amber-700`;
  const bad = strong ? `${NUM} font-semibold text-red-700` : `${NUM} text-red-700`;
  const lost = lostTrips(s.demand);
  return (
    <>
      {s.scoped ? (
        <td colSpan={3} className="px-2 py-2 text-center text-xs text-slate-500" title={SCOPED_DEMAND}>
          non ventilée
        </td>
      ) : (
        <>
          <td className={num}>{tripsToCarry(s.demand)}</td>
          <td className={num}>{formatPercent(s.serviceRate, 1)}</td>
          <td className={lost > 0 ? warn : num}>{lost}</td>
        </>
      )}
      <td className={`${num} border-l border-slate-100`}>{s.fleet ? `${s.vehicles} / ${s.fleet.available}` : s.vehicles}</td>
      <td className={`${num} border-l border-slate-100`}>{formatDecimal(s.tripsPerVehiclePlanned)}</td>
      <td className={num}>{formatDecimal(s.tripsPerVehicleRealized)}</td>
      <td className={`${num} border-l border-slate-100`} title={`${formatKm(s.emptyKm, 0)} à vide sur ${formatKm(s.distanceKm, 0)}`}>
        {formatPercent(s.emptyKmShare, 1)}
      </td>
      <td className={`${num} border-l border-slate-100`}>{formatPercent(s.eligibleSharedRate, 1)}</td>
      <td className={`${num} border-l border-slate-100`}>{s.measuredOutbound > 0 ? `${s.lateArrivals} / ${s.measuredOutbound}` : "—"}</td>
      <td className={`${num} border-l border-slate-100`}>{planningMinutes === null ? "—" : formatDuration(planningMinutes)}</td>
      <td className={`${num} border-l border-slate-100`}>{formatEurosRounded(s.vehicles > 0 ? s.servedRevenue : null)}</td>
      <td className={s.vehicles > 0 && s.servedRevenue - s.cost < 0 ? bad : num}>{formatEurosRounded(s.vehicles > 0 ? s.servedRevenue - s.cost : null)}</td>
    </>
  );
}

/**
 * The detail by week or by month (KPI-09): one row per step, its counters
 * summed and its rates recomputed from them; a step cut by the range says so.
 * A step's link shows its days one by one.
 */
export function TrendTable({
  points,
  period,
  granularity,
  base,
}: {
  points: readonly TrendPoint[];
  period: PeriodKpis;
  granularity: Granularity;
  base: HrefState;
}) {
  const rows = [...points].reverse();
  return (
    <Table>
      <caption className="sr-only">
        Indicateurs par {granularity === "week" ? "semaine" : "mois"} du {formatLongDate(period.from)} au {formatLongDate(period.to)}, du plus
        récent au plus ancien, et totaux de la période.
      </caption>
      <THead>
        <tr>
          <th scope="col" className={HEAD_LEFT}>
            {granularity === "week" ? "Semaine" : "Mois"}
          </th>
          <th scope="col" className={HEAD} title="Courses demandées moins les annulations">
            À transp.
          </th>
          <th scope="col" className={HEAD}>
            Service
          </th>
          <th scope="col" className={HEAD}>
            Perdues
          </th>
          <th scope="col" className={`${HEAD} border-l border-slate-200`} title="Journées-véhicules utilisées / disponibles">
            Véhicules
          </th>
          <th scope="col" className={`${HEAD} border-l border-slate-200`} title="Courses servies par véhicule utilisé">
            Courses / véh.
          </th>
          <th scope="col" className={HEAD} title="Courses déposées par véhicule suivi">
            Réalisé
          </th>
          <th scope="col" className={`${HEAD} border-l border-slate-200`}>
            Km à vide
          </th>
          <th scope="col" className={`${HEAD} border-l border-slate-200`} title="Partage servi des courses éligibles en taxi ou VSL">
            Partagé
          </th>
          <th scope="col" className={`${HEAD} border-l border-slate-200`}>
            Retards
          </th>
          <th scope="col" className={`${HEAD} border-l border-slate-200`} title="Médiane du temps actif de construction des jours validés">
            Planning
          </th>
          <th scope="col" className={`${HEAD} border-l border-slate-200`}>
            CA estimé
          </th>
          <th scope="col" className={HEAD}>
            Marge
          </th>
        </tr>
      </THead>
      <TBody>
        {rows.map((point) => (
          <tr key={point.key} className="bg-white">
            <th scope="row" className="px-3 py-2 text-left font-normal whitespace-nowrap">
              <Link
                href={dashboardHref({ ...base, from: point.from, to: point.to, granularity: "day", day: null })}
                title="Afficher ces jours un par un"
                className="font-medium text-slate-900 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600"
              >
                {formatStep(point.key, granularity)}
              </Link>
              {point.cut ? (
                <span className="block text-[11px] text-slate-600">
                  {formatDayMonth(point.from)} → {formatDayMonth(point.to)}
                </span>
              ) : null}
              {point.days.some((d) => d.simulated) ? (
                <span className="ml-1.5 rounded-sm bg-violet-100 px-1 py-px text-[11px] font-semibold text-violet-800">simulé</span>
              ) : null}
            </th>
            {point.planned ? (
              <Cells s={point.summary} planningMinutes={point.planningMinutes} />
            ) : (
              <td colSpan={12} className="px-3 py-2 text-slate-600">
                Aucune tournée
              </td>
            )}
          </tr>
        ))}
      </TBody>
      <tfoot className="border-t-2 border-slate-200 bg-slate-50">
        <tr>
          <th scope="row" className="px-3 py-2 text-left font-semibold whitespace-nowrap text-slate-900">
            Période
            <span className="block text-[11px] font-normal text-slate-600">{plural(period.plannedDays, "jour planifié", "jours planifiés")}</span>
          </th>
          <Cells s={period} planningMinutes={period.medianPlanningMinutes} strong />
        </tr>
      </tfoot>
    </Table>
  );
}
