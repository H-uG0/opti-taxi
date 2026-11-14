import { Stat } from "@/components/ui/layout";
import type { DayKpis, PeriodKpis } from "@/lib/kpis";
import { lostTrips, placedTrips, tripsToCarry, type DemandTotals } from "@/lib/kpis-demand";
import { lostVehicleDays } from "@/lib/kpis-fleet";
import { formatDayShort, formatDecimal, formatEurosRounded, formatRate, plural } from "./format";

type FunnelRow = { label: string; count: (d: DemandTotals) => number; level: 0 | 1 | 2; lost?: boolean; note?: string };

const LEVEL_CLASSES = {
  0: "px-3 py-1.5 text-left font-semibold text-slate-900",
  1: "py-1.5 pr-3 pl-7 text-left font-normal text-slate-700",
  2: "py-1.5 pr-3 pl-11 text-left font-normal text-slate-700",
} as const;

const ROWS: FunnelRow[] = [
  { label: "Demandées", count: (d) => d.requested, level: 0 },
  { label: "Annulées la veille ou avant", count: (d) => d.cancelledBefore, level: 1, note: "patient, établissement, hospitalisation…" },
  { label: "Annulées le jour même", count: (d) => d.cancelledOnDay, level: 1 },
  { label: "À transporter", count: tripsToCarry, level: 0 },
  { label: "Servies", count: (d) => d.served, level: 1, note: "dans une tournée" },
  { label: "dont déposées", count: (d) => d.realized, level: 2, note: "réalisées, saisies par l'équipage" },
  { label: "Patient absent", count: (d) => d.noShows, level: 1, note: "le véhicule est venu" },
  { label: "Non affectées", count: (d) => d.unassigned, level: 1, lost: true, note: "aucun véhicule" },
  { label: "Confiées à un confrère", count: (d) => d.handedOver, level: 1, lost: true },
];

/**
 * Demand and service (KPI-01): every trip of the planned days, from the
 * requested ones to what became of them, for the day done shown at the top
 * and for the period. A table (readable by every assistive technology), with
 * a bar per row of the period for the eye.
 */
export function DemandSection({ period, day }: { period: PeriodKpis; day: Pick<DayKpis, "date" | "demand"> | null }) {
  const d = period.demand;
  const toCarry = tripsToCarry(d);
  const max = Math.max(1, d.requested);

  return (
    <section aria-labelledby="demand-title" className="mb-8">
      <h2 id="demand-title" className="mb-1 text-base font-semibold text-slate-900">
        Demande et service
      </h2>
      <p className="mb-3 text-sm text-slate-600">
        Toutes les courses des {plural(period.plannedDays, "jour planifié", "jours planifiés")} de la période, servies ou non&nbsp;: un
        planning qui laisse des courses de côté ne paraît pas meilleur.
      </p>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-xs lg:col-span-2">
          <table className="min-w-full text-sm">
            <caption className="sr-only">
              Devenir des courses demandées{day ? ` le ${formatDayShort(day.date)} et` : ""} sur la période&nbsp;: nombre et part des
              courses demandées.
            </caption>
            <thead className="bg-slate-50">
              <tr className="text-xs font-semibold tracking-wide whitespace-nowrap text-slate-600 uppercase">
                <th scope="col" className="px-3 py-2 text-left">
                  Courses
                </th>
                {day ? (
                  <th scope="col" className="px-3 py-2 text-right">
                    {formatDayShort(day.date)}
                  </th>
                ) : null}
                <th scope="col" className="px-3 py-2 text-right">
                  Période
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  Part
                </th>
                <th scope="col" className="w-1/3 px-3 py-2">
                  <span className="sr-only">Barre</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {ROWS.map((row) => {
                const count = row.count(d);
                const dayCount = day ? row.count(day.demand) : 0;
                return (
                  <tr key={row.label} className={row.level === 0 ? "bg-slate-50/60" : undefined}>
                    <th scope="row" className={LEVEL_CLASSES[row.level]}>
                      {row.label}
                      {row.note ? <span className="ml-1.5 text-xs text-slate-600">{row.note}</span> : null}
                    </th>
                    {day ? (
                      <td className={row.lost && dayCount > 0 ? "tabular px-3 py-1.5 text-right font-semibold text-amber-800" : "tabular px-3 py-1.5 text-right text-slate-900"}>
                        {dayCount}
                      </td>
                    ) : null}
                    <td className={row.lost && count > 0 ? "tabular px-3 py-1.5 text-right font-semibold text-amber-800" : "tabular px-3 py-1.5 text-right text-slate-900"}>
                      {count}
                    </td>
                    <td className="tabular px-3 py-1.5 text-right text-slate-600">{formatRate(d.requested > 0 ? count / d.requested : null)}</td>
                    <td className="px-3 py-1.5">
                      <span aria-hidden className="block h-2.5 rounded-r-sm bg-brand-500" style={{ width: `${(count / max) * 100}%` }} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="grid grid-cols-1 content-start gap-3 sm:grid-cols-2 lg:grid-cols-1">
          <Stat
            label="Taux de service"
            tone={lostTrips(d) > 0 ? "warn" : "default"}
            value={formatRate(period.serviceRate)}
            hint={`${placedTrips(d)} placées (servies ou patient absent) sur ${plural(toCarry, "course à transporter", "courses à transporter")}`}
          />
          <Stat
            label="CA perdu estimé"
            tone={lostTrips(d) > 0 ? "warn" : "default"}
            value={formatEurosRounded(d.lostRevenue)}
            hint={
              <>
                {plural(lostTrips(d), "course non servie", "courses non servies")}, chacune au CA moyen d&apos;une course servie du même jour
                et du même mode (assis ou allongé)
                {d.unpricedLost > 0 ? ` · ${plural(d.unpricedLost, "course sans prix de référence", "courses sans prix de référence")}` : ""}
              </>
            }
          />
        </div>
      </div>
    </section>
  );
}

/**
 * Use of the fleet over the period (KPI-03): vehicle-days active, available
 * and used on the planned days, and the two ratios of trips per vehicle.
 */
export function FleetSection({ period }: { period: PeriodKpis }) {
  const fleet = period.fleet;
  if (!fleet) return null;
  return (
    <section aria-labelledby="fleet-title" className="mb-8">
      <h2 id="fleet-title" className="mb-1 text-base font-semibold text-slate-900">
        Utilisation de la flotte
      </h2>
      <p className="mb-3 text-sm text-slate-600">
        En journées-véhicules sur les jours planifiés. «&#x202F;Courses / véhicule&#x202F;» ne compte que les véhicules utilisés&nbsp;:
        laisser des véhicules au dépôt l&apos;améliore. Le ratio de référence (par véhicule utilisé ou disponible) reste à choisir avec V.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Taux d'utilisation"
          value={formatRate(period.useRate)}
          hint={`${fleet.used} journées-véhicules utilisées sur ${fleet.available} disponibles (${fleet.active} actives)`}
        />
        <Stat
          label="Courses / véhicule utilisé"
          value={formatDecimal(period.tripsPerVehiclePlanned)}
          hint={`${plural(period.servedTrips, "course servie", "courses servies")} ÷ ${plural(fleet.used, "journée-véhicule", "journées-véhicules")}`}
        />
        <Stat
          label="Courses / véhicule disponible"
          value={formatDecimal(period.tripsPerAvailableVehicle)}
          hint={`Même total ÷ ${plural(fleet.available, "journée-véhicule disponible", "journées-véhicules disponibles")}`}
        />
        <Stat
          label="Journées-véhicules perdues"
          tone={lostVehicleDays(fleet) > 0 ? "warn" : "default"}
          value={String(lostVehicleDays(fleet))}
          hint={`${fleet.unavailable} indisponibles (entretien, réparation, garde…) · ${fleet.crewless} sans équipage (personne de libre, problème d'équipage, laissé au dépôt)`}
        />
      </div>
    </section>
  );
}
