import type { EnergyType } from "@prisma/client";
import { Table, TBody, THead } from "@/components/ui/table";
import { energyRates, type EnergyGroup } from "@/lib/kpis-energy";
import { ENERGY_LABELS, formatEuros, formatKm } from "@/lib/labels";
import { formatDecimal } from "./format";

const HEAD_BASE = "px-2 py-2 text-xs font-semibold whitespace-nowrap text-slate-600 uppercase";
const HEAD = `${HEAD_BASE} text-right`;
const HEAD_LEFT = `${HEAD_BASE} text-left`;
const NUM = "tabular px-2 py-2 text-right whitespace-nowrap text-slate-800";

/** « +2,1 % », « 0,0 % » (never « -0,0 »), « — ». */
function signedPercent(value: number | null): string {
  if (value === null) return "—";
  const tenths = Math.round(value * 1000) / 10;
  return `${tenths > 0 ? "+" : ""}${formatDecimal(tenths === 0 ? 0 : tenths)}\u00a0%`;
}

function consumption(g: EnergyGroup): string {
  const per = energyRates(g).per100Km;
  const parts = (["L", "kWh"] as const).flatMap((unit) => (per[unit] !== undefined ? [`${formatDecimal(per[unit])} ${unit}`] : []));
  return parts.length > 0 ? parts.join(" · ") : "—";
}

function Row({ label, g, strong = false }: { label: string; g: EnergyGroup; strong?: boolean }) {
  const r = energyRates(g);
  const cell = strong ? `${NUM} font-semibold` : NUM;
  const gapTone = r.kmGap !== null && Math.abs(r.kmGap) >= 0.05 ? " text-amber-700" : "";
  return (
    <tr className={strong ? "bg-slate-50" : undefined}>
      <th scope="row" className={strong ? "px-3 py-2 text-left font-semibold text-slate-900" : "px-3 py-2 text-left font-normal text-slate-800"}>
        {label}
      </th>
      <td className={cell}>
        {g.vehicles}
        {g.measuredVehicles < g.vehicles ? <span className="ml-1 text-xs font-normal text-slate-500">({g.measuredVehicles} mesurés)</span> : null}
      </td>
      <td className={`${cell} border-l border-slate-100`}>{formatKm(g.measuredKm, 0)}</td>
      <td className={cell}>{consumption(g)}</td>
      <td className={`${cell} border-l border-slate-100`}>{r.energyCostPerKm === null ? "—" : `${formatEuros(r.energyCostPerKm)}/km`}</td>
      <td className={cell}>{r.configuredCostPerKm === null ? "—" : `${formatEuros(r.configuredCostPerKm)}/km`}</td>
      <td
        className={`${cell} border-l border-slate-100${gapTone}`}
        // The km the gap compares (stopped at the last planned day), not the whole measured interval.
        title={r.kmGap === null ? undefined : `${formatKm(g.comparedKm, 0)} au compteur pour ${formatKm(g.plannedKm, 0)} planifiés`}
      >
        {signedPercent(r.kmGap)}
      </td>
      <td
        className={`${cell}${r.readingGap !== null && Math.abs(r.readingGap) >= 0.05 ? " text-amber-700" : ""}`}
        title={
          r.readingGap === null
            ? undefined
            : `${formatKm(g.readingKm, 0)} relevés par les équipages pour ${formatKm(g.readingPlannedKm, 0)} planifiés, sur ${g.readingDays} journée${g.readingDays > 1 ? "s" : ""}`
        }
      >
        {signedPercent(r.readingGap)}
      </td>
      <td className={`${cell} border-l border-slate-100`}>{g.offRoadDays}</td>
      <td className={g.overdueDeadlines > 0 ? `${NUM} font-semibold text-red-700` : cell}>{g.overdueDeadlines}</td>
    </tr>
  );
}

function GroupTable({ caption, first, rows, total }: { caption: string; first: string; rows: { key: string; label: string; g: EnergyGroup }[]; total: EnergyGroup }) {
  return (
    <Table>
      <caption className="px-3 pt-2 text-left text-xs font-medium text-slate-700">{caption}</caption>
      <THead>
        <tr>
          <th scope="col" className={HEAD_LEFT}>
            {first}
          </th>
          <th scope="col" className={HEAD}>
            Véhicules
          </th>
          <th scope="col" className={`${HEAD} border-l border-slate-200`} title="Km au compteur entre le dernier plein complet avant la période et le dernier de la période">
            Km mesurés
          </th>
          <th scope="col" className={HEAD} title={"Carburant (L) ou énergie (kWh) aux 100\u00a0km"}>
            Aux 100&nbsp;km
          </th>
          <th scope="col" className={`${HEAD} border-l border-slate-200`} title="Montant des pleins ÷ km au compteur">
            Énergie / km
          </th>
          <th scope="col" className={HEAD} title="Coût au km utilisé par l'optimiseur (énergie, entretien, usure)">
            Coût configuré
          </th>
          <th scope="col" className={`${HEAD} border-l border-slate-200`} title="(km au compteur − km planifiés) ÷ km planifiés, sur les mêmes jours">
            Compteur / planifié
          </th>
          <th
            scope="col"
            className={HEAD}
            title="Journées relevées au départ et au retour par les équipages (feuille de route)&nbsp;: (km réels − km planifiés) ÷ km planifiés"
          >
            Relevés / planifié
          </th>
          <th
            scope="col"
            className={`${HEAD} border-l border-slate-200`}
            title="Journées d'indisponibilité (entretien, réparation, garde…) parmi les jours planifiés de la période, comme l'onglet Ventilation"
          >
            Jours immobilisés
          </th>
          <th scope="col" className={HEAD} title="Échéances dépassées aujourd'hui (date ou kilométrage)">
            Échéances dépassées
          </th>
        </tr>
      </THead>
      <TBody>
        {rows.map((row) => (
          <Row key={row.key} label={row.label} g={row.g} />
        ))}
        <Row label="Toute la flotte" g={total} strong />
      </TBody>
    </Table>
  );
}

/**
 * The fleet by energy and by depot (KPI-10): measured
 * consumption and energy cost per km against the configured cost per km, the
 * odometer against the planned km, the days off the road and the deadlines
 * overdue.
 */
export function EnergySection({
  byEnergy,
  byDepot,
  total,
  depotName,
}: {
  byEnergy: Map<string, EnergyGroup>;
  byDepot: Map<string, EnergyGroup>;
  total: EnergyGroup;
  depotName: (id: string) => string;
}) {
  const energyLabel = (key: string) => (key === "NONE" ? "Non renseignée" : (ENERGY_LABELS[key as EnergyType] ?? key));
  return (
    <section aria-labelledby="energy-title" className="mb-8">
      <h2 id="energy-title" className="mb-1 text-base font-semibold text-slate-900">
        Énergie, compteurs et entretien
      </h2>
      <p className="mb-3 max-w-4xl text-sm text-slate-600">
        D&apos;après les pleins et recharges saisis sur les fiches des véhicules&nbsp;: consommation et coût de l&apos;énergie entre le
        dernier plein complet avant la période et le dernier de la période, face au coût au km configuré (qui couvre aussi
        l&apos;entretien et l&apos;usure). L&apos;écart entre le compteur et les km planifiés révèle les distances sous-estimées et les
        trajets hors tournée&nbsp;; les relevés du compteur saisis par les équipages au départ et au retour le donnent jour par jour. Litres et kWh ne s&apos;additionnent pas&nbsp;: la consommation est donnée par unité. De quoi comparer
        le coût réel d&apos;un véhicule diesel et d&apos;un électrique.
      </p>
      <div className="space-y-4">
        <GroupTable
          caption="Par énergie"
          first="Énergie"
          rows={[...byEnergy].map(([key, g]) => ({ key, label: energyLabel(key), g }))}
          total={total}
        />
        <GroupTable
          caption="Par dépôt"
          first="Dépôt"
          rows={[...byDepot].map(([key, g]) => ({ key, label: depotName(key), g })).sort((a, b) => a.label.localeCompare(b.label, "fr"))}
          total={total}
        />
      </div>
    </section>
  );
}
