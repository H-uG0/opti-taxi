import Link from "next/link";
import { Stat } from "@/components/ui/layout";
import { Table, TBody, THead } from "@/components/ui/table";
import type { DayKpis, PeriodKpis } from "@/lib/kpis";
import { interventionCount, medianTouchUpMinutes, MOVE_RECOMPUTE_MIN, SESSION_IDLE_MIN } from "@/lib/kpis-planning-time";
import { quantile } from "@/lib/kpis-rows";
import { formatDuration } from "@/lib/time";
import { formatDayShort, formatDecimal, formatMinutes, plural } from "./format";

const HEAD_BASE = "px-2 py-2 text-xs font-semibold whitespace-nowrap text-slate-600 uppercase";
const HEAD = `${HEAD_BASE} text-right`;
const HEAD_LEFT = `${HEAD_BASE} text-left`;
const NUM = "tabular px-2 py-2 text-right whitespace-nowrap";

/**
 * Real planning time (KPI-06): the active time of the initial build and of
 * the touch-ups, read from the regulators' actions, and the manual
 * interventions after the optimization, day by day. The whole company: a
 * depot or a type does not narrow it (one planning a day).
 */
export function PlanningSection({ days, period, scoped }: { days: readonly DayKpis[]; period: PeriodKpis; scoped: boolean }) {
  const t = period.planning;
  const measured = [...days].filter((d) => d.planningTime !== null).reverse();
  const clock = days.flatMap((d) => (d.clockMinutes !== null ? [d.clockMinutes] : []));
  const interventions = interventionCount(t.interventions);
  const touched = t.touchUps.filter((m) => m > 0).length;
  return (
    <section aria-labelledby="planning-title" className="mb-8">
      <h2 id="planning-title" className="mb-1 text-base font-semibold text-slate-900">
        Temps de planification et interventions
      </h2>
      <p className="mb-3 max-w-4xl text-sm text-slate-600">
        Temps actif d&apos;après le journal des actions des régulateurs sur la journée planifiée (optimisations, déplacements, verrous,
        réponses au partage, validation…)&nbsp;: une session s&apos;arrête après {SESSION_IDLE_MIN}&nbsp;min sans action, une session de
        simple consultation ne compte pas. La construction initiale va jusqu&apos;à la première validation, les retouches viennent
        après (réouverture, changement le jour même). Médianes plutôt que moyennes&nbsp;: une journée rouverte ne tire pas le chiffre.
        {scoped ? " Toute l'entreprise, quel que soit le filtre (un seul planning par jour)." : ""}
      </p>
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Construction initiale"
          value={formatMinutes(period.medianPlanningMinutes)}
          hint={`Médiane sur ${plural(t.initial.length, "jour validé", "jours validés")} · p90 ${formatMinutes(quantile(t.initial, 0.9))}`}
        />
        <Stat
          label="Retouches après validation"
          value={formatMinutes(medianTouchUpMinutes(t))}
          hint={`Médiane · ${plural(touched, "jour retouché", "jours retouchés")} sur ${t.touchUps.length}`}
        />
        <Stat
          label="Interventions après l'optimisation"
          value={String(interventions)}
          hint={`${plural(t.interventions.moves, "déplacement")} · ${plural(t.interventions.locks, "verrou posé ou retiré", "verrous posés ou retirés")} · ${plural(t.interventions.reoptimizations, "réoptimisation")} · ${formatDecimal(t.initial.length > 0 ? t.validatedInterventions / t.initial.length : null)} par jour validé`}
        />
        <Stat
          label="Durée d'horloge (ancienne mesure)"
          value={formatMinutes(quantile(clock, 0.5))}
          hint="Médiane de la première optimisation à la dernière validation, nuit et réouvertures comprises"
        />
      </div>
      {measured.length === 0 ? (
        <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          Aucune action de planification enregistrée sur la période.
        </p>
      ) : (
        <Table>
          <caption className="sr-only">Temps de planification et interventions par jour, du plus récent au plus ancien.</caption>
          <THead>
            <tr>
              <th scope="col" className={HEAD_LEFT}>
                Jour
              </th>
              <th scope="col" className={HEAD}>
                Construction
              </th>
              <th scope="col" className={HEAD}>
                Sessions
              </th>
              <th scope="col" className={HEAD}>
                Retouches
              </th>
              <th scope="col" className={`${HEAD} border-l border-slate-200`} title={`Une réoptimisation lancée par un déplacement (moins de ${MOVE_RECOMPUTE_MIN} min après) compte avec lui`}>
                Déplacements
              </th>
              <th scope="col" className={HEAD}>
                Verrous
              </th>
              <th scope="col" className={HEAD}>
                Réoptimisations
              </th>
              <th scope="col" className={`${HEAD} border-l border-slate-200`} title="Première optimisation → dernière validation">
                Horloge
              </th>
            </tr>
          </THead>
          <TBody>
            {measured.map((day) => {
              const p = day.planningTime;
              if (!p) return null;
              return (
                <tr key={day.date}>
                  <th scope="row" className="px-3 py-2 text-left font-normal whitespace-nowrap">
                    <Link
                      href={`/planning?date=${day.date}`}
                      className="tabular font-medium text-slate-900 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600"
                    >
                      {formatDayShort(day.date)}
                    </Link>
                    {day.simulated ? (
                      <span className="ml-1.5 rounded-sm bg-violet-100 px-1 py-px text-[11px] font-semibold text-violet-800">simulé</span>
                    ) : null}
                  </th>
                  <td className={NUM}>
                    {p.initialMinutes !== null ? (
                      formatDuration(p.initialMinutes)
                    ) : (
                      <span className="text-amber-700" title={"Jamais validée\u00a0: le temps passé jusqu'ici"}>
                        en cours ({formatDuration(p.pendingMinutes)})
                      </span>
                    )}
                  </td>
                  <td className={NUM}>{p.sessions}</td>
                  <td className={NUM}>{p.touchUpMinutes > 0 ? formatDuration(p.touchUpMinutes) : "—"}</td>
                  <td className={`${NUM} border-l border-slate-100`}>{p.interventions.moves}</td>
                  <td className={NUM}>{p.interventions.locks}</td>
                  <td className={NUM}>{p.interventions.reoptimizations}</td>
                  <td className={`${NUM} border-l border-slate-100 text-slate-600`}>{formatMinutes(day.clockMinutes)}</td>
                </tr>
              );
            })}
          </TBody>
        </Table>
      )}
    </section>
  );
}
