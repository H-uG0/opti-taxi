import type { VehicleType } from "@prisma/client";
import { Stat } from "@/components/ui/layout";
import { Table, TBody, THead } from "@/components/ui/table";
import type { PeriodKpis } from "@/lib/kpis";
import { groupLines, lineRates, sumLines, type LineTotals, type RouteLine } from "@/lib/kpis-breakdown";
import { formatEuros, formatKm, VEHICLE_TYPE_LABELS } from "@/lib/labels";
import { formatDuration } from "@/lib/time";
import { formatDecimal, formatEurosRounded, formatMinutes, formatRate, plural } from "./format";

const HEAD_BASE = "px-2 py-2 text-xs font-semibold whitespace-nowrap text-slate-600 uppercase";
const HEAD = `${HEAD_BASE} text-right`;
const HEAD_LEFT = `${HEAD_BASE} text-left`;
const NUM = "tabular px-2 py-2 text-right whitespace-nowrap";
const TYPES: readonly VehicleType[] = ["TAXI", "VSL", "AMBULANCE"];

function perKm(value: number | null): string {
  return value === null ? "—" : `${formatEuros(value)}/km`;
}

function perHour(value: number | null): string {
  return value === null ? "—" : `${formatEurosRounded(value)}/h`;
}

function TypeRow({ label, t, strong = false }: { label: string; t: LineTotals; strong?: boolean }) {
  const r = lineRates(t);
  const cell = strong ? `${NUM} font-semibold text-slate-900` : `${NUM} text-slate-800`;
  return (
    <tr className={strong ? "bg-slate-50" : undefined}>
      <th scope="row" className={strong ? "px-3 py-2 text-left font-semibold text-slate-900" : "px-3 py-2 text-left font-normal text-slate-800"}>
        {label}
      </th>
      <td className={cell}>{t.vehicleDays}</td>
      <td className={cell}>{t.trips}</td>
      <td className={cell}>{formatDecimal(r.tripsPerVehicleDay)}</td>
      <td className={`${cell} border-l border-slate-100`}>{formatEurosRounded(r.revenuePerVehicleDay)}</td>
      <td className={cell}>{perKm(r.revenuePerKm)}</td>
      <td className={cell}>{perKm(r.costPerKm)}</td>
      <td className={cell}>{perHour(r.hourlyCost)}</td>
      <td className={`${cell} border-l border-slate-100`}>{formatEurosRounded(r.margin)}</td>
      <td className={r.marginPerTrip !== null && r.marginPerTrip < 0 ? `${NUM} font-semibold text-red-700` : cell}>{formatEurosRounded(r.marginPerTrip)}</td>
      <td className={`${cell} border-l border-slate-100`}>{formatRate(r.occupancy)}</td>
      <td className={cell}>{formatMinutes(r.facilityWaitPerVehicleDay)}</td>
    </tr>
  );
}

/**
 * Unit economics (KPI-10): revenue per vehicle and per day, revenue and cost
 * per km, hourly cost, margin per trip and per vehicle type; how full the
 * vehicles run (minutes with a patient on board over the planned minutes) and
 * how long they wait at the places of care. From the routes of the period as
 * the optimizer priced them (estimated revenue of the served trips, cost =
 * km × cost per km + hours × hourly cost).
 */
export function EconomySection({ lines, period }: { lines: readonly RouteLine[]; period: PeriodKpis }) {
  const all = sumLines(lines);
  const rates = lineRates(all);
  const byType = groupLines(lines, (line) => [line.vehicleType]);
  const available = period.fleet?.available ?? null;
  const kmShare = all.timedCost > 0 && all.kmCostKm > 0 ? all.timedKmCost / all.timedCost : null;
  return (
    <section aria-labelledby="economy-title" className="mb-8">
      <h2 id="economy-title" className="mb-1 text-base font-semibold text-slate-900">
        Économie par unité
      </h2>
      <p className="mb-3 max-w-4xl text-sm text-slate-600">
        D&apos;après les tournées de la période telles que l&apos;optimiseur les a chiffrées&nbsp;: CA estimé des courses servies (absents
        exclus) et coût des tournées (km × coût au km du véhicule + heures × coût horaire de l&apos;équipage). La part kilométrique
        est recalculée avec le coût au km actuel de chaque véhicule&nbsp;; le reste est la part horaire.
      </p>
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Stat
          label="CA par véhicule et par jour"
          value={formatEurosRounded(rates.revenuePerVehicleDay)}
          hint={`${formatEurosRounded(all.revenue)} sur ${plural(all.vehicleDays, "journée-véhicule utilisée", "journées-véhicules utilisées")}${
            available ? ` · ${formatEurosRounded(all.revenue / available)} par véhicule disponible` : ""
          }`}
        />
        <Stat
          label="CA et coût au km"
          value={perKm(rates.revenuePerKm)}
          hint={`Coût ${perKm(rates.costPerKm)} sur ${formatKm(all.distanceKm, 0)}, dont ${formatKm(all.emptyKm, 0)} à vide`}
        />
        <Stat
          label="Coût horaire"
          value={perHour(rates.hourlyCost)}
          hint={`Part horaire du coût par heure de tournée, pause comprise comme l'optimiseur la compte (${formatDecimal(
            rates.paidHours,
            0,
          )} h) · coût total ${perHour(rates.costPerHour)}${kmShare !== null ? ` · part km ${formatRate(kmShare)}` : ""}`}
        />
        <Stat
          label="Marge par course"
          tone={rates.marginPerTrip !== null && rates.marginPerTrip < 0 ? "bad" : "default"}
          value={formatEurosRounded(rates.marginPerTrip)}
          hint={`Marge ${formatEurosRounded(rates.margin)} sur ${plural(all.trips, "course servie", "courses servies")} (CA ${formatEurosRounded(all.revenue)}, coût ${formatEurosRounded(all.cost)})`}
        />
        <Stat
          label="Taux d'occupation"
          value={formatRate(rates.occupancy)}
          hint={`Temps avec un patient à bord ÷ temps planifié des tournées · ${formatRate(rates.emptyKmShare === null ? null : 1 - rates.emptyKmShare)} des km avec un patient`}
        />
        <Stat
          label="Attente aux établissements"
          value={formatMinutes(rates.facilityWaitPerVehicleDay)}
          hint={`Par journée-véhicule, avant une dépose ou une reprise (fin de séance) · ${formatDuration(all.facilityWaitMinutes)} au total, ${formatRate(
            all.activeMinutes > 0 ? all.facilityWaitMinutes / all.activeMinutes : null,
          )} du temps planifié`}
        />
      </div>
      <Table>
        <caption className="px-3 pt-2 text-left text-xs text-slate-600">
          Par type de véhicule. «&#x202F;Véh.-jours&#x202F;»&nbsp;: journées-véhicules utilisées.
        </caption>
        <THead>
          <tr>
            <th scope="col" className={HEAD_LEFT}>
              Type
            </th>
            <th scope="col" className={HEAD}>
              Véh.-jours
            </th>
            <th scope="col" className={HEAD}>
              Courses
            </th>
            <th scope="col" className={HEAD}>
              Courses / véh.
            </th>
            <th scope="col" className={`${HEAD} border-l border-slate-200`}>
              CA / véh.-jour
            </th>
            <th scope="col" className={HEAD}>
              CA / km
            </th>
            <th scope="col" className={HEAD}>
              Coût / km
            </th>
            <th scope="col" className={HEAD} title="Part horaire du coût par heure de tournée, pause comprise">
              Coût horaire
            </th>
            <th scope="col" className={`${HEAD} border-l border-slate-200`}>
              Marge
            </th>
            <th scope="col" className={HEAD}>
              Marge / course
            </th>
            <th scope="col" className={`${HEAD} border-l border-slate-200`} title="Temps avec un patient à bord ÷ temps planifié">
              Occupation
            </th>
            <th scope="col" className={HEAD} title="Attente aux établissements par journée-véhicule">
              Attente
            </th>
          </tr>
        </THead>
        <TBody>
          {TYPES.flatMap((type) => {
            const t = byType.get(type);
            return t ? [<TypeRow key={type} label={VEHICLE_TYPE_LABELS[type]} t={t} />] : [];
          })}
          <TypeRow label="Tous" t={all} strong />
        </TBody>
      </Table>
    </section>
  );
}
