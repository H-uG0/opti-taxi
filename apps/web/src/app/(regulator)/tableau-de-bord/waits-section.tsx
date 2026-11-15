import Link from "next/link";
import { Stat } from "@/components/ui/layout";
import type { KpiOptions, PeriodKpis } from "@/lib/kpis";
import { quantile } from "@/lib/kpis-rows";
import { formatDuration } from "@/lib/time";
import { formatCountOf, formatDayShort, formatMinutes, formatRate, lateLabel, plural } from "./format";

/** A shared care session over the wait limit, as listed: initials only, and links to its trips on the planning. */
export type WaitCaseRow = {
  serviceDate: string;
  initials: string;
  outboundTripId: string | null;
  returnTripId: string | null;
  beforeMin: number | null;
  afterMin: number | null;
  totalMin: number;
};

/** Cases listed at most: the count says how many there are. */
export const WAIT_CASES_SHOWN = 50;

/** « +4 min », « −2 min », « 0 min » (a median of arrivals against the planned time). */
function formatSignedMinutes(value: number | null): string {
  if (value === null) return "—";
  const rounded = Math.round(value);
  return rounded > 0 ? `+${formatMinutes(rounded)}` : rounded < 0 ? `−${formatMinutes(-rounded)}` : formatMinutes(0);
}

function medianP90(values: readonly number[]): string {
  return `médiane ${formatMinutes(quantile(values, 0.5))}, p90 ${formatMinutes(quantile(values, 0.9))}`;
}

/**
 * Waits, time on board and punctuality measured from the crews' timestamps
 * (KPI-05), and the shared care sessions over the 45 minutes of the decree,
 * to justify in an audit by the caisse.
 */
export function WaitsSection({ period, options, cases }: { period: PeriodKpis; options: KpiOptions; cases: WaitCaseRow[] }) {
  const w = period.waits;
  const shown = cases.slice(0, WAIT_CASES_SHOWN);
  return (
    <section aria-labelledby="waits-title" className="mb-8">
      <h2 id="waits-title" className="mb-1 text-base font-semibold text-slate-900">
        Attentes, temps à bord et ponctualité
      </h2>
      <p className="mb-3 text-sm text-slate-600">
        Mesurés aux horodatages des équipages («&#x202F;Pris en charge&#x202F;», «&#x202F;Déposé&#x202F;»), sur les courses où ils sont saisis.
        Attente au lieu de soins&nbsp;: avant le RDV (RDV − dépose) et après la séance (prise en charge − temps de montée prévu − fin de
        séance), au plus {formatDuration(options.maxTotalWaitMin)} au total pour un transport partagé.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Séances partagées au-delà de la limite"
          tone={w.sharedOverMax > 0 ? "bad" : w.sharedSessions > 0 ? "good" : "default"}
          value={formatCountOf(w.sharedOverMax, w.sharedSessions)}
          hint={`${formatRate(w.sharedSessions > 0 ? w.sharedOverMax / w.sharedSessions : null)} des séances partagées mesurées · toutes séances : ${w.overMax} sur ${w.sessions}`}
        />
        <Stat
          label="Attente au retour"
          value={formatMinutes(quantile(w.afterWaits, 0.5))}
          hint={`Médiane après la séance, p90 ${formatMinutes(quantile(w.afterWaits, 0.9))}, sur ${plural(w.afterWaits.length, "retour mesuré", "retours mesurés")}`}
        />
        <Stat
          label="Attente avant le RDV"
          value={formatMinutes(quantile(w.beforeWaits, 0.5))}
          hint={`Médiane, p90 ${formatMinutes(quantile(w.beforeWaits, 0.9))}, sur ${plural(w.beforeWaits.length, "aller mesuré", "allers mesurés")} · attente totale ${medianP90(w.totalWaits)}`}
        />
        <Stat
          label="Temps à bord au-delà du direct"
          tone={w.rideOverMax > 0 ? "warn" : "default"}
          value={formatMinutes(quantile(w.rideExcess, 0.5))}
          hint={`Médiane, p90 ${formatMinutes(quantile(w.rideExcess, 0.9))} · ${w.rideOverMax} au-delà de +${formatDuration(options.maxRideExtraMin)} (trajet direct estimé sur le plan)`}
        />
        <Stat
          label={lateLabel(options.lateToleranceMin)}
          tone={period.measuredOutbound === 0 ? "default" : period.lateArrivals > 0 ? "bad" : "good"}
          value={period.measuredOutbound > 0 ? formatRate(period.lateRate) : "—"}
          hint={`${period.lateArrivals} sur ${plural(period.measuredOutbound, "aller mesuré", "allers mesurés")} · tolérance réglable en haut de page (le chauffeur tape «\u202fDéposé\u202f» après avoir accompagné le patient)`}
        />
        <Stat
          label={"Retards au-delà de 15\u00a0min"}
          tone={period.lateOver15 > 0 ? "bad" : "default"}
          value={formatCountOf(period.lateOver15, period.measuredOutbound)}
          hint={`Au-delà de 5\u00a0min\u00a0: ${period.lateOver5} (${formatRate(period.measuredOutbound > 0 ? period.lateOver5 / period.measuredOutbound : null)})${period.maxDelayMinutes !== null ? ` · retard maximal ${formatDuration(period.maxDelayMinutes)}` : ""}`}
        />
        <Stat
          label="Temps à bord"
          value={formatMinutes(quantile(w.rideMinutes, 0.5))}
          hint={`Médiane de «\u202fPris en charge\u202f» à «\u202fDéposé\u202f», p90 ${formatMinutes(quantile(w.rideMinutes, 0.9))}, sur ${plural(w.rideMinutes.length, "course", "courses")}`}
        />
        <Stat
          label="Attente à la porte du patient"
          value={formatMinutes(quantile(w.doorWaits, 0.5))}
          hint={
            w.arrivalDelays.length > 0
              ? `Médiane de «\u202fArrivé\u202f» à «\u202fPris en charge\u202f», p90 ${formatMinutes(quantile(w.doorWaits, 0.9))}, sur ${plural(w.doorWaits.length, "prise en charge", "prises en charge")} · arrivée ${formatSignedMinutes(quantile(w.arrivalDelays, 0.5))} sur l'heure prévue (médiane)${w.noShowWaits.length > 0 ? ` · attente avant une absence\u00a0: ${medianP90(w.noShowWaits)}` : ""}`
              : "Mesurée quand l'équipage touche «\u202fArrivé\u202f» (facultatif) avant «\u202fPris en charge\u202f» ou «\u202fPatient absent\u202f»"
          }
        />
        <Stat
          label={`Allers serrés (< ${options.tightMarginMin}\u00a0min)`}
          tone={period.tightOutbound > 0 ? "warn" : "default"}
          value={formatCountOf(period.tightOutbound, period.plannedOutbound)}
          hint={`Allers dont la dépose est prévue moins de ${formatDuration(options.tightMarginMin)} avant le RDV (${formatRate(period.tightRate)})\u202f: le risque de retard du plan`}
        />
      </div>

      <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-xs">
        <table className="min-w-full text-sm">
          <caption className="px-3 pt-2 text-left text-xs text-slate-600">
            {w.cases.length === 0
              ? "Aucune séance partagée au-delà de la limite d'attente sur la période."
              : `Séances partagées au-delà de ${formatDuration(options.maxTotalWaitMin)} d'attente (${w.cases.length}${
                  w.cases.length > shown.length ? `, les ${shown.length} plus longues` : ""
                }) : à justifier en cas de contrôle. Initiales du patient seulement ; chaque course s'ouvre sur le planning.`}
          </caption>
          {shown.length > 0 ? (
            <>
              <thead className="bg-slate-50">
                <tr className="text-xs font-semibold tracking-wide text-slate-600 uppercase">
                  <th scope="col" className="px-3 py-2 text-left">
                    Jour
                  </th>
                  <th scope="col" className="px-3 py-2 text-left">
                    Patient
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    Avant le RDV
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    Après la séance
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    Total
                  </th>
                  <th scope="col" className="px-3 py-2 text-left">
                    Courses
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shown.map((row) => {
                  // The links say which session they open: a list of links read alone is not « Aller, Retour, Aller… ».
                  const session = `du ${formatDayShort(row.serviceDate)}, ${row.initials}`;
                  return (
                    <tr key={`${row.serviceDate}-${row.outboundTripId ?? ""}-${row.returnTripId ?? ""}`}>
                      <th scope="row" className="tabular px-3 py-1.5 text-left font-normal whitespace-nowrap text-slate-800">
                        {formatDayShort(row.serviceDate)}
                      </th>
                      <td className="px-3 py-1.5 text-slate-800">{row.initials}</td>
                      <td className="tabular px-3 py-1.5 text-right text-slate-800">{formatMinutes(row.beforeMin)}</td>
                      <td className="tabular px-3 py-1.5 text-right text-slate-800">{formatMinutes(row.afterMin)}</td>
                      <td className="tabular px-3 py-1.5 text-right font-semibold text-red-700">{formatMinutes(row.totalMin)}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        {row.outboundTripId ? (
                          <Link
                            href={`/planning?date=${row.serviceDate}&trip=${row.outboundTripId}`}
                            aria-label={`Aller ${session}`}
                            className="font-medium text-brand-700 underline underline-offset-2"
                          >
                            Aller
                          </Link>
                        ) : null}
                        {row.outboundTripId && row.returnTripId ? <span className="text-slate-400"> · </span> : null}
                        {row.returnTripId ? (
                          <Link
                            href={`/planning?date=${row.serviceDate}&trip=${row.returnTripId}`}
                            aria-label={`Retour ${session}`}
                            className="font-medium text-brand-700 underline underline-offset-2"
                          >
                            Retour
                          </Link>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </>
          ) : null}
        </table>
      </div>
    </section>
  );
}
