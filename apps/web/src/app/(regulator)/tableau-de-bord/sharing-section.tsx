import { Stat } from "@/components/ui/layout";
import type { PeriodKpis } from "@/lib/kpis";
import { quantile } from "@/lib/kpis-rows";
import {
  COUR_DES_COMPTES_MARKERS,
  eligibleSharedRate,
  measuredSharedRate,
  SHARING_OBJECTIVE,
  tapSharedRate,
  tapTotal,
  type SharingMonth,
} from "@/lib/kpis-sharing";
import { formatKm } from "@/lib/labels";
import { fromIsoDate } from "@/lib/time";
import { formatCountOf, formatMinutes, formatRate, plural } from "./format";

const monthName = new Intl.DateTimeFormat("fr-FR", { month: "long", timeZone: "UTC" });

function monthLabel(month: string): string {
  const name = monthName.format(fromIsoDate(`${month}-01`));
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** A rate and its counts: "32,1 % (45 / 140)"; "—" when nothing was eligible. */
function RateCell({ shared, eligible, strong = false }: { shared: number; eligible: number; strong?: boolean }) {
  return (
    <td className={strong ? "tabular px-3 py-1.5 text-right font-semibold text-slate-900" : "tabular px-3 py-1.5 text-right text-slate-800"}>
      {formatRate(eligible > 0 ? shared / eligible : null)}
      {eligible > 0 ? <span className="ml-1 text-xs font-normal text-slate-600">({formatCountOf(shared, eligible)})</span> : null}
    </td>
  );
}

function MonthRow({ month, label, strong = false }: { month: SharingMonth; label: string; strong?: boolean }) {
  return (
    <tr className={strong ? "bg-slate-50" : undefined}>
      <th scope="row" className={strong ? "px-3 py-1.5 text-left font-semibold text-slate-900" : "px-3 py-1.5 text-left font-normal text-slate-800"}>
        {label}
      </th>
      <RateCell shared={month.eligibleShared.VSL} eligible={month.eligible.VSL} strong={strong} />
      <RateCell shared={month.eligibleShared.TAXI} eligible={month.eligible.TAXI} strong={strong} />
      <RateCell shared={tapTotal(month.eligibleShared)} eligible={tapTotal(month.eligible)} strong={strong} />
      <td className="tabular px-3 py-1.5 text-right text-slate-600">{formatRate(tapSharedRate(month))}</td>
    </tr>
  );
}

/**
 * Shared transport as the Assurance maladie counts it (KPI-04): the year to
 * date month by month, then the period's funnel of the decree 2025-202, the
 * sharing measured from the crews' timestamps, why trips were not shared and
 * the detours.
 */
export function SharingSection({
  period,
  months,
  year,
  maxDetourKm,
}: {
  period: PeriodKpis;
  months: SharingMonth[];
  year: SharingMonth;
  /** AppSettings.maxDetourKmPerExtraPatient. */
  maxDetourKm: number;
}) {
  const s = period.sharing;
  const funnel = s.funnel;
  const pending = funnel.proposed - funnel.accepted - funnel.refused;
  const served = s.reasons.shared + s.reasons.private + s.reasons.prescription + s.reasons.refused + s.reasons.noMatch;
  const reasons: { label: string; count: number }[] = [
    { label: "Partagées", count: s.reasons.shared },
    { label: "Aucun co-passager compatible (horaires, détour, places)", count: s.reasons.noMatch },
    { label: "Refus du patient", count: s.reasons.refused },
    { label: "Prescription sans partage", count: s.reasons.prescription },
    { label: "Client privé", count: s.reasons.private },
  ];
  const meanDetour = s.detour.count > 0 ? s.detour.sumKm / s.detour.count : null;
  // The year from its first month with served trips: the months before are said in one line.
  const firstKnown = months.findIndex((m) => tapTotal(m.tap) > 0);
  const shownMonths = firstKnown < 0 ? [] : months.slice(firstKnown);
  const emptyBefore = firstKnown > 0 ? months[firstKnown] : null;

  return (
    <section aria-labelledby="sharing-title" className="mb-8">
      <h2 id="sharing-title" className="mb-1 text-base font-semibold text-slate-900">
        Transport partagé, comme l&apos;Assurance maladie le compte
      </h2>
      <p className="mb-3 text-sm text-slate-600">
        Courses en taxi ou en VSL des assurés de l&apos;Assurance maladie dont la prescription autorise le partage (éligibles)&nbsp;;
        ni les ambulances ni les clients privés. Objectif du protocole du 24&nbsp;septembre 2025&nbsp;: plus de{" "}
        {formatRate(SHARING_OBJECTIVE)} fin 2027. Repères cités par la Cour des comptes&nbsp;: {formatRate(COUR_DES_COMPTES_MARKERS.VSL)}{" "}
        en VSL, {formatRate(COUR_DES_COMPTES_MARKERS.TAXI)} en taxi.
      </p>

      <div className="mb-4 overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-xs">
        <table className="min-w-full text-sm">
          <caption className="px-3 pt-2 text-left text-xs text-slate-600">
            Cumul de l&apos;année {year.month}, mois par mois, partage servi d&apos;après les tournées&nbsp;; le partage mesuré
            aux horodatages porte sur la période affichée, plus bas.
            {emptyBefore ? ` Aucune course servie avant ${monthLabel(emptyBefore.month).toLowerCase()}.` : ""}
          </caption>
          <thead className="bg-slate-50">
            <tr className="text-xs font-semibold tracking-wide text-slate-600 uppercase">
              <th scope="col" className="px-3 py-2 text-left">
                Mois
              </th>
              <th scope="col" className="px-3 py-2 text-right">
                VSL
              </th>
              <th scope="col" className="px-3 py-2 text-right">
                Taxi
              </th>
              <th scope="col" className="px-3 py-2 text-right">
                VSL et taxi
              </th>
              <th scope="col" className="px-3 py-2 text-right" title="Partagées sur toutes les courses en taxi ou VSL de l'Assurance maladie, éligibles ou non">
                Toutes courses TAP
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shownMonths.map((month) => (
              <MonthRow key={month.month} month={month} label={monthLabel(month.month)} />
            ))}
            <MonthRow month={year} label={`Cumul ${year.month}`} strong />
            <tr className="text-slate-600">
              <th scope="row" className="px-3 py-1.5 text-left font-normal">
                Objectif et repères
              </th>
              <td className="tabular px-3 py-1.5 text-right" title="Repère cité par la Cour des comptes">
                {formatRate(COUR_DES_COMPTES_MARKERS.VSL)}
              </td>
              <td className="tabular px-3 py-1.5 text-right" title="Repère cité par la Cour des comptes">
                {formatRate(COUR_DES_COMPTES_MARKERS.TAXI)}
              </td>
              <td className="tabular px-3 py-1.5 text-right" title="Protocole du 24 septembre 2025, art. 4.2">
                &gt;&nbsp;{formatRate(SHARING_OBJECTIVE)} fin 2027
              </td>
              <td className="px-3 py-1.5" />
            </tr>
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Partage mesuré sur la période"
          value={formatRate(measuredSharedRate(s))}
          hint={
            <>
              <span className="block">
                VSL {formatRate(measuredSharedRate(s, "VSL"))} · taxi {formatRate(measuredSharedRate(s, "TAXI"))}
              </span>
              <span className="block">
                Servi (tournées) {formatRate(eligibleSharedRate(s))} · mesuré sur{" "}
                {plural(tapTotal(s.measured), "course déposée", "courses déposées")} dont les deux heures sont saisies
              </span>
            </>
          }
        />
        <Stat
          label="Propositions"
          value={`${funnel.proposed} / ${funnel.eligible}`}
          hint={
            <>
              <span className="block">
                Éligibles {funnel.eligible} → proposées {funnel.proposed} → acceptées {funnel.accepted} · refusées {funnel.refused}
                {pending > 0 ? ` · sans réponse ${pending}` : ""}
              </span>
              <span className="block">
                {plural(s.refusingPatientIds.length, "patient a refusé", "patients ont refusé")} (perte du tiers payant)
              </span>
            </>
          }
        />
        <Stat
          label="Délai de réponse"
          value={formatMinutes(quantile(s.responseDelays, 0.5))}
          hint={`Médiane de la proposition à la réponse, sur ${plural(s.responseDelays.length, "réponse")} ; p90 ${formatMinutes(quantile(s.responseDelays, 0.9))}. Les refus connus d'avance (sans délai) ne comptent pas.`}
        />
        <Stat
          label="Détour des courses partagées"
          value={meanDetour === null ? "—" : formatKm(meanDetour, 1)}
          hint={`Moyen, sur ${plural(s.detour.count, "course partagée", "courses partagées")} ; maximal ${s.detour.maxKm === null ? "—" : formatKm(s.detour.maxKm, 1)}, pour une limite de ${formatKm(maxDetourKm, 0)} par patient ajouté`}
        />
      </div>

      <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-xs">
        <table className="min-w-full text-sm">
          <caption className="px-3 pt-2 text-left text-xs text-slate-600">
            Courses assises servies en taxi ou en VSL sur la période ({served})&nbsp;: partagées, ou pourquoi elles ne l&apos;ont pas été.
          </caption>
          <tbody className="divide-y divide-slate-100">
            {reasons.map((reason) => (
              <tr key={reason.label}>
                <th scope="row" className="px-3 py-1.5 text-left font-normal text-slate-800">
                  {reason.label}
                </th>
                <td className="tabular px-3 py-1.5 text-right text-slate-900">{reason.count}</td>
                <td className="tabular px-3 py-1.5 text-right text-slate-600">{formatRate(served > 0 ? reason.count / served : null)}</td>
                <td className="w-1/3 px-3 py-1.5">
                  <span aria-hidden className="block h-2.5 rounded-r-sm bg-brand-500" style={{ width: `${served > 0 ? (reason.count / served) * 100 : 0}%` }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
