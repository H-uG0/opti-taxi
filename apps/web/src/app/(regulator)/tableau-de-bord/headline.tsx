import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import Link from "next/link";
import { SimulatedDayBadge } from "@/components/planning/simulated-day-badge";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/components/ui/cn";
import { Stat } from "@/components/ui/layout";
import { deltaTrend, kpiDelta, mixedDistanceSources, type DayKpis, type KpiSummary } from "@/lib/kpis";
import type { PlannedComparison, PlanView, RealizedComparison } from "@/lib/kpis-compare";
import { lostTrips, placedTrips, tripsToCarry } from "@/lib/kpis-demand";
import { lostVehicleDays } from "@/lib/kpis-fleet";
import { planRates } from "@/lib/kpis-plan";
import { eligibleSharedRate, measuredSharedRate, tapTotal } from "@/lib/kpis-sharing";
import type { TapType } from "@/lib/kpis-rows";
import { KPI_INDICATORS, targetGap, type EffectiveTargets, type KpiIndicator } from "@/lib/kpis-targets";
import { formatKm } from "@/lib/labels";
import { addDays, formatDuration, formatLongDate } from "@/lib/time";
import {
  capitalize,
  describeRealizedRate,
  formatDayShort,
  formatDecimal,
  formatDeltaDecimal,
  formatDeltaEuros,
  formatDeltaPoints,
  formatEurosRounded,
  formatIndicator,
  formatIndicatorGap,
  formatInstant,
  formatRate,
  gapVerdict,
  lateLabel,
  plural,
} from "./format";

function Line({ children }: { children: ReactNode }) {
  return <span className="block">{children}</span>;
}

/**
 * Change against the same weekday of the week before (an arrow and a word,
 * never color alone), and the value of the four same weekdays before.
 */
function Compare({
  current,
  previous,
  fourWeeks,
  higherIsBetter,
  formatDelta,
  formatValue,
}: {
  current: number | null;
  previous: { date: string; value: number | null } | null;
  fourWeeks: { count: number; value: number | null } | null;
  higherIsBetter: boolean;
  formatDelta: (delta: number) => string;
  formatValue: (value: number) => string;
}) {
  const reference =
    fourWeeks && fourWeeks.value !== null ? (
      <span title={`Les ${plural(fourWeeks.count, "même jour", "mêmes jours")} des 4 semaines précédentes, compteurs additionnés`}>
        4&nbsp;sem.&nbsp;: <span className="tabular">{formatValue(fourWeeks.value)}</span>
      </span>
    ) : null;
  if (!previous) {
    return (
      <span className="mt-1 block">
        Semaine précédente&nbsp;: rien à comparer{reference ? <> · {reference}</> : null}
      </span>
    );
  }
  const delta = kpiDelta(current, previous.value);
  const trend = deltaTrend(delta, higherIsBetter);
  if (delta === null || trend === null) {
    return (
      <span className="mt-1 block">
        Pas de comparaison avec {formatDayShort(previous.date)}
        {reference ? <> · {reference}</> : null}
      </span>
    );
  }
  const Icon = trend === "same" ? Minus : delta > 0 ? ArrowUpRight : ArrowDownRight;
  const tone = trend === "better" ? "text-emerald-700" : trend === "worse" ? "text-red-700" : "text-slate-600";
  const verdict = trend === "better" ? "en amélioration" : trend === "worse" ? "en dégradation" : "stable";
  return (
    <span className="mt-1 flex flex-wrap items-center gap-x-1">
      <span className={cn("tabular inline-flex items-center gap-0.5 font-medium", tone)}>
        <Icon aria-hidden className="size-3.5" />
        {trend === "same" ? "stable" : formatDelta(delta)}
      </span>
      <span>vs {formatDayShort(previous.date)}</span>
      {trend !== "same" ? <span className="sr-only">({verdict})</span> : null}
      {reference ? <span>· {reference}</span> : null}
    </span>
  );
}

/**
 * The value against the objective and the reference of its indicator (KPI-09):
 * « Objectif 4,5 · −0,3 · réf. 3,8 ». The gap to the objective reads better or
 * worse in words for screen readers, never by its colour alone, and from its
 * rounded value (a gap shown as « 0 € » is met). `per`: the unit of a value
 * that is not the tile's own (the margin per trip under the day's margin).
 */
function TargetHint({ indicator, value, targets, per }: { indicator: KpiIndicator; value: number | null; targets: EffectiveTargets; per?: string }) {
  const target = targets[indicator];
  if (target.objective === null && target.reference === null) return null;
  const { unit, higherIsBetter } = KPI_INDICATORS[indicator];
  const suffix = per ? `\u00a0/ ${per}` : "";
  const gap = targetGap(value, target.objective);
  const verdict = gap === null ? null : gapVerdict(unit, higherIsBetter, gap);
  const referenceGap = targetGap(value, target.reference);
  return (
    <span className="mt-1 flex flex-wrap items-center gap-x-1">
      {target.objective !== null ? (
        <span>
          Objectif <span className="tabular">{`${formatIndicator(unit, target.objective)}${suffix}`}</span>
          {target.objectiveSource === "protocol" ? " (protocole)" : ""}
          {gap !== null ? (
            <>
              {" · "}
              <span
                className={cn(
                  "tabular font-medium",
                  verdict === "better" ? "text-emerald-700" : verdict === "worse" ? "text-red-700" : "text-slate-700",
                )}
              >
                {`${formatIndicatorGap(unit, gap)}${suffix}`}
              </span>
              <span className="sr-only">{verdict === "worse" ? " (non atteint)" : " (atteint)"}</span>
            </>
          ) : null}
        </span>
      ) : null}
      {target.reference !== null ? (
        <span title="Valeur de référence, mesurée avant l'outil">
          {target.objective !== null ? "· " : ""}réf. <span className="tabular">{`${formatIndicator(unit, target.reference)}${suffix}`}</span>
          {referenceGap !== null ? <span className="tabular"> ({formatIndicatorGap(unit, referenceGap)})</span> : null}
        </span>
      ) : null}
    </span>
  );
}

/** Why the demand of a depot or a type is not measured. */
const SCOPED_SERVICE = "Non ventilé\u00a0: une course sans véhicule n'appartient à aucun dépôt ni type";

function BlockTitle({ id, title, date, badges, children }: { id: string; title: string; date: string; badges: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
      <h2 id={id} className="text-base font-semibold text-slate-900">
        {title} <span className="font-normal text-slate-600">— {capitalize(formatLongDate(date))}</span>
      </h2>
      {badges}
      {children}
    </div>
  );
}

function StatusBadges({ day, today, tomorrow }: { day: DayKpis; today: string; tomorrow: string }) {
  return (
    <>
      {day.date === tomorrow ? <Badge tone="brand">J+1</Badge> : null}
      {day.date === today ? <Badge tone="info">Aujourd&apos;hui</Badge> : null}
      {day.simulated ? <SimulatedDayBadge /> : null}
      {day.planningStatus === "VALIDATED" ? (
        <Badge tone="success">Planning validé</Badge>
      ) : day.planningStatus === "NOT_VALIDATED" ? (
        <Badge tone="warning">Planning non validé</Badge>
      ) : (
        <Badge>Pas de planning</Badge>
      )}
    </>
  );
}

function comparedText(date: string, count: number): string {
  return `Comparé au ${formatLongDate(addDays(date, -7))} (même jour la semaine précédente) et ${
    count > 0 ? `aux ${plural(count, "même jour", "mêmes jours")} des 4 semaines précédentes` : "aux 4 semaines précédentes (aucun jour planifié)"
  }.`;
}

/**
 * Shared rate of the « Partage » tile, on one basis chosen from the day shown:
 * measured from the timestamps when its crews recorded both times, else the
 * routes' (served). The days compared are read on the same basis, never a
 * measured rate against a served one.
 */
function sharedRateOf(measured: boolean, day: Pick<KpiSummary, "sharing" | "eligibleSharedRate">, type?: TapType): number | null {
  if (measured) return measuredSharedRate(day.sharing, type);
  return type ? eligibleSharedRate(day.sharing, type) : day.eligibleSharedRate;
}

/** « Hier (réalisé) »: what was done on a day, against the same weekday of the weeks before. */
export function RealizedBlock({
  day,
  comparison,
  today,
  tomorrow,
  toleranceMin,
  targets,
}: {
  day: DayKpis;
  comparison: RealizedComparison;
  today: string;
  tomorrow: string;
  toleranceMin: number;
  targets: EffectiveTargets;
}) {
  const { previous, fourWeeks } = comparison;
  const prev = (value: (d: KpiSummary) => number | null) => (previous ? { date: previous.date, value: value(previous) } : null);
  const four = (value: (d: KpiSummary) => number | null) => (fourWeeks ? { count: fourWeeks.count, value: value(fourWeeks) } : null);
  const realized = describeRealizedRate(day);
  const frozen = day.frozen ? planRates(day.frozen.figures) : null;
  const measuredBasis = measuredSharedRate(day.sharing) !== null;
  const sharedDetail = [
    measuredBasis
      ? `Sur ${plural(tapTotal(day.sharing.measured), "course déposée", "courses déposées")} · servi ${formatRate(day.eligibleSharedRate)}`
      : `Sur ${plural(tapTotal(day.sharing.eligible), "éligible")}`,
    frozen ? `prévu ${formatRate(frozen.sharedRate)}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  const lost = lostTrips(day.demand);
  const fleet = day.fleet;
  const servedMargin = day.servedRevenue - day.cost;
  const title = day.inProgress ? "Aujourd'hui (en cours)" : day.date === addDays(today, -1) ? "Hier (réalisé)" : "Réalisé";

  return (
    <section aria-labelledby="realized-title">
      <BlockTitle id="realized-title" title={title} date={day.date} badges={<StatusBadges day={day} today={today} tomorrow={tomorrow} />}>
        <p className="text-sm text-slate-600">{comparedText(day.date, fourWeeks?.count ?? 0)}</p>
        {previous && mixedDistanceSources(day, previous) ? (
          <p role="note" className="text-sm text-amber-800">
            Distances calculées différemment ces deux jours (routières ou estimées à vol d&apos;oiseau)&nbsp;: comparaison des
            km indicative.
          </p>
        ) : null}
      </BlockTitle>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <Stat
          label="Taux de service"
          tone={!day.scoped && lost > 0 ? "warn" : "default"}
          value={formatRate(day.serviceRate)}
          hint={
            day.scoped ? (
              <Line>{SCOPED_SERVICE}</Line>
            ) : (
            <>
              <Line>
                {placedTrips(day.demand)} placées sur {plural(tripsToCarry(day.demand), "course à transporter", "courses à transporter")}
              </Line>
              <Line>
                {lost > 0
                  ? `${plural(day.demand.unassigned, "non affectée", "non affectées")} · ${plural(day.demand.handedOver, "confiée", "confiées")} · CA perdu ≈ ${formatEurosRounded(day.demand.lostRevenue)}`
                  : "Aucune course perdue"}
              </Line>
              <Compare
                current={day.serviceRate}
                previous={prev((d) => d.serviceRate)}
                fourWeeks={four((d) => d.serviceRate)}
                higherIsBetter
                formatDelta={formatDeltaPoints}
                formatValue={formatRate}
              />
              <TargetHint indicator="serviceRate" value={day.serviceRate} targets={targets} />
            </>
            )
          }
        />
        <Stat
          label="Courses / véhicule (réalisé)"
          value={realized.value ?? "—"}
          hint={
            <>
              <Line>{capitalize(realized.note)}</Line>
              <Line>
                Plan validé&nbsp;: <span className="tabular">{formatDecimal(frozen?.tripsPerVehicle ?? null)}</span> · servi&nbsp;:{" "}
                <span className="tabular">{formatDecimal(day.tripsPerVehiclePlanned)}</span>
              </Line>
              <Line>
                Par véhicule disponible&nbsp;: <span className="tabular">{formatDecimal(day.tripsPerAvailableVehicle)}</span>
              </Line>
              <Compare
                current={day.tripsPerVehicleRealized}
                previous={prev((d) => d.tripsPerVehicleRealized)}
                fourWeeks={four((d) => d.tripsPerVehicleRealized)}
                higherIsBetter
                formatDelta={formatDeltaDecimal}
                formatValue={(v) => formatDecimal(v)}
              />
              <TargetHint indicator="tripsPerVehicle" value={day.tripsPerVehicleRealized} targets={targets} />
            </>
          }
        />
        <Stat
          label="Utilisation de la flotte"
          value={formatRate(day.useRate)}
          hint={
            fleet ? (
              <>
                <Line>
                  {fleet.used} utilisés sur {plural(fleet.available, "disponible")} ({plural(fleet.active, "actif")})
                </Line>
                <Line>
                  {plural(lostVehicleDays(fleet), "journée perdue", "journées perdues")}&nbsp;: {fleet.unavailable} indisponible
                  {fleet.unavailable > 1 ? "s" : ""}, {fleet.crewless} sans équipage
                </Line>
                <Compare
                  current={day.useRate}
                  previous={prev((d) => d.useRate)}
                  fourWeeks={four((d) => d.useRate)}
                  higherIsBetter
                  formatDelta={formatDeltaPoints}
                  formatValue={formatRate}
                />
                <TargetHint indicator="useRate" value={day.useRate} targets={targets} />
              </>
            ) : (
              <Line>Flotte du jour inconnue</Line>
            )
          }
        />
        <Stat
          label={measuredBasis ? "Partage mesuré (CPAM)" : "Partage servi (CPAM)"}
          value={formatRate(sharedRateOf(measuredBasis, day))}
          hint={
            <>
              <Line>
                VSL <span className="tabular">{formatRate(sharedRateOf(measuredBasis, day, "VSL"))}</span> · taxi{" "}
                <span className="tabular">{formatRate(sharedRateOf(measuredBasis, day, "TAXI"))}</span>
              </Line>
              <Line>{sharedDetail}</Line>
              <Compare
                current={sharedRateOf(measuredBasis, day)}
                previous={prev((d) => sharedRateOf(measuredBasis, d))}
                fourWeeks={four((d) => sharedRateOf(measuredBasis, d))}
                higherIsBetter
                formatDelta={formatDeltaPoints}
                formatValue={formatRate}
              />
              <TargetHint indicator="sharedRate" value={sharedRateOf(measuredBasis, day)} targets={targets} />
            </>
          }
        />
        <Stat
          label={lateLabel(toleranceMin)}
          tone={day.measuredOutbound === 0 ? "default" : day.lateArrivals > 0 ? "bad" : "good"}
          value={day.measuredOutbound > 0 ? formatRate(day.lateRate) : "—"}
          hint={
            <>
              <Line>
                {day.measuredOutbound > 0
                  ? `${day.lateArrivals} sur ${plural(day.measuredOutbound, "aller mesuré", "allers mesurés")}`
                  : day.realizedOutbound > 0
                    ? "Heures de dépose non saisies"
                    : "Aucun aller déposé"}
              </Line>
              <Line>
                Au-delà de 15&nbsp;min&nbsp;: {day.lateOver15}
                {day.maxDelayMinutes !== null ? ` · max ${formatDuration(day.maxDelayMinutes)}` : ""}
              </Line>
              <Compare
                current={day.lateRate}
                previous={prev((d) => d.lateRate)}
                fourWeeks={four((d) => d.lateRate)}
                higherIsBetter={false}
                formatDelta={formatDeltaPoints}
                formatValue={formatRate}
              />
              <TargetHint indicator="lateRate" value={day.measuredOutbound > 0 ? day.lateRate : null} targets={targets} />
            </>
          }
        />
        <Stat
          label="Marge sans les absents"
          tone={day.vehicles > 0 && servedMargin < 0 ? "bad" : "default"}
          value={formatEurosRounded(day.vehicles > 0 ? servedMargin : null)}
          hint={
            <>
              <Line>
                CA déposé <span className="tabular">{formatEurosRounded(day.realizedRevenue)}</span> · sans statut{" "}
                <span className="tabular">{formatEurosRounded(day.servedRevenue - day.realizedRevenue)}</span>
              </Line>
              <Line>
                {day.noShowRevenue > 0
                  ? `Absents non facturés : ${formatEurosRounded(day.noShowRevenue)}`
                  : `Par course : ${formatEurosRounded(day.marginPerTrip)}`}
              </Line>
              <Compare
                current={day.marginPerTrip}
                previous={prev((d) => d.marginPerTrip)}
                fourWeeks={four((d) => d.marginPerTrip)}
                higherIsBetter
                formatDelta={(delta) => `${formatDeltaEuros(delta)} / course`}
                formatValue={(v) => `${formatEurosRounded(v)} / course`}
              />
              <TargetHint indicator="marginPerTrip" value={day.marginPerTrip} targets={targets} per="course" />
            </>
          }
        />
      </div>

      <PlannedServedDone day={day} />
    </section>
  );
}

/** Prévu (as validated), servi (what stayed in the routes), réalisé (dropped off): the same day three times. */
function PlannedServedDone({ day }: { day: DayKpis }) {
  const plan = day.frozen?.figures ?? null;
  const measured = tapTotal(day.sharing.measured);
  const rows: { label: string; planned: string; served: string; done: string; title?: string }[] = [
    {
      label: "Courses",
      planned: plan ? String(plan.served) : "—",
      served: String(day.servedTrips),
      done: day.upcoming ? "—" : String(day.realizedTrips),
    },
    {
      label: "Partagées (périmètre CPAM)",
      planned: plan && !plan.partial ? `${tapTotal(plan.eligibleShared)} / ${tapTotal(plan.eligible)}` : "—",
      served: `${tapTotal(day.sharing.eligibleShared)} / ${tapTotal(day.sharing.eligible)}`,
      done: measured > 0 ? `${tapTotal(day.sharing.measuredShared)} / ${measured}` : "—",
      title: "Courses partagées sur les courses éligibles\u202f; réalisé\u00a0: mesuré aux horodatages des équipages",
    },
    {
      label: "CA estimé",
      planned: plan ? formatEurosRounded(plan.revenue) : "—",
      served: formatEurosRounded(day.servedRevenue),
      done: day.upcoming ? "—" : formatEurosRounded(day.realizedRevenue),
    },
    {
      label: "Véhicules",
      planned: plan ? String(plan.vehicles) : "—",
      served: String(day.vehicles),
      done: day.upcoming ? "—" : `${day.realizedVehicles} suivis`,
    },
  ];
  return (
    <div className="mt-3 max-w-3xl overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-xs">
      <table className="min-w-full text-sm">
        <caption className="px-3 pt-2 text-left text-xs text-slate-600">
          {day.frozen ? (
            <>
              Prévu&nbsp;: le plan tel que validé le {formatInstant(day.frozen.validatedAt)}
              {day.planningStatus === "VALIDATED" ? ". " : ", avant la réouverture du planning. "}
            </>
          ) : day.planningStatus === "VALIDATED" ? (
            <>Plan validé avant l&apos;enregistrement des plans validés&nbsp;: pas de prévu figé. </>
          ) : (
            <>Planning non validé&nbsp;: pas de prévu figé. </>
          )}
          Servi&nbsp;: les tournées après les absences ({day.demand.noShows}) et les annulations du jour ({day.demand.cancelledOnDay}).
          Réalisé&nbsp;: les courses déposées.
        </caption>
        <thead>
          <tr className="text-xs text-slate-600">
            <th scope="col" className="px-3 py-1.5 text-left font-semibold">
              <span className="sr-only">Indicateur</span>
            </th>
            <th scope="col" className="px-3 py-1.5 text-right font-semibold">
              Prévu
            </th>
            <th scope="col" className="px-3 py-1.5 text-right font-semibold">
              Servi
            </th>
            <th scope="col" className="px-3 py-1.5 text-right font-semibold">
              Réalisé
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr key={row.label} title={row.title}>
              <th scope="row" className="px-3 py-1.5 text-left font-normal text-slate-700">
                {row.label}
              </th>
              <td className="tabular px-3 py-1.5 text-right text-slate-800">{row.planned}</td>
              <td className="tabular px-3 py-1.5 text-right text-slate-800">{row.served}</td>
              <td className="tabular px-3 py-1.5 text-right font-medium text-slate-900">{row.done}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** « Demain (prévu) »: the plan of a day to come, against the validated plans of the same weekday before. */
export function PlannedBlock({
  day,
  plan,
  comparison,
  today,
  tomorrow,
  targets,
}: {
  day: DayKpis;
  plan: PlanView | null;
  comparison: PlannedComparison;
  today: string;
  tomorrow: string;
  targets: EffectiveTargets;
}) {
  const title = day.date === tomorrow ? "Demain (prévu)" : "Prévu";
  const rates = plan ? planRates(plan.figures) : null;
  const { previous, fourWeeks } = comparison;
  const prevRates = previous ? planRates(previous.figures) : null;
  const fourRates = fourWeeks ? planRates(fourWeeks.figures) : null;
  const prev = (value: (r: ReturnType<typeof planRates>) => number | null) =>
    previous && prevRates ? { date: previous.date, value: value(prevRates) } : null;
  const four = (value: (r: ReturnType<typeof planRates>) => number | null) =>
    fourWeeks && fourRates ? { count: fourWeeks.count, value: value(fourRates) } : null;
  const figures = plan?.figures ?? null;
  const fleet = day.fleet;
  const frozenNote =
    fourWeeks && fourWeeks.frozen < fourWeeks.count
      ? ` (${plural(fourWeeks.count - fourWeeks.frozen, "jour sans plan figé, lu", "jours sans plan figé, lus")} sur ses tournées)`
      : "";

  return (
    <section aria-labelledby="planned-title">
      <BlockTitle id="planned-title" title={title} date={day.date} badges={<StatusBadges day={day} today={today} tomorrow={tomorrow} />}>
        {figures ? (
          <p className="text-sm text-slate-600">
            {`Comparé aux plans validés du ${formatLongDate(addDays(day.date, -7))} et des 4 mêmes jours précédents${frozenNote}.`}
          </p>
        ) : null}
      </BlockTitle>

      {!figures || !rates ? (
        <p className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 shadow-xs">
          {day.scoped ? (
            <>Pas encore de tournée pour ces véhicules.</>
          ) : (
            <>Pas encore de tournée&nbsp;: {plural(placedTrips(day.demand) + day.demand.unassigned, "course à planifier", "courses à planifier")}.</>
          )}{" "}
          <Link href={`/planning?date=${day.date}`} className="font-medium text-brand-700 underline underline-offset-2">
            Ouvrir le planning
          </Link>
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          <Stat
            label="Taux de service prévu"
            tone={!figures.partial && figures.unassigned + figures.handedOver > 0 ? "warn" : "default"}
            value={formatRate(rates.serviceRate)}
            hint={
              figures.partial ? (
                <Line>{SCOPED_SERVICE}</Line>
              ) : (
              <>
                <Line>
                  {figures.served} servies · {plural(figures.unassigned, "non affectée", "non affectées")}
                  {figures.handedOver > 0 ? ` · ${plural(figures.handedOver, "confiée", "confiées")}` : ""}
                </Line>
                <Compare
                  current={rates.serviceRate}
                  previous={prev((r) => r.serviceRate)}
                  fourWeeks={four((r) => r.serviceRate)}
                  higherIsBetter
                  formatDelta={formatDeltaPoints}
                  formatValue={formatRate}
                />
                <TargetHint indicator="serviceRate" value={rates.serviceRate} targets={targets} />
              </>
              )
            }
          />
          <Stat
            label="Courses / véhicule"
            value={formatDecimal(rates.tripsPerVehicle)}
            hint={
              <>
                <Line>
                  {figures.vehicles} utilisés{fleet ? ` sur ${plural(fleet.available, "disponible")}` : ""}
                </Line>
                <Line>
                  Par véhicule disponible&nbsp;: <span className="tabular">{formatDecimal(day.tripsPerAvailableVehicle)}</span>
                </Line>
                <Compare
                  current={rates.tripsPerVehicle}
                  previous={prev((r) => r.tripsPerVehicle)}
                  fourWeeks={four((r) => r.tripsPerVehicle)}
                  higherIsBetter
                  formatDelta={formatDeltaDecimal}
                  formatValue={(v) => formatDecimal(v)}
                />
                <TargetHint indicator="tripsPerVehicle" value={rates.tripsPerVehicle} targets={targets} />
              </>
            }
          />
          <Stat
            label="Km à vide"
            value={formatRate(rates.emptyKmShare)}
            hint={
              <>
                <Line>
                  <span className="tabular">{formatKm(figures.emptyKm, 0)}</span> sur{" "}
                  <span className="tabular">{formatKm(figures.distanceKm, 0)}</span>
                </Line>
                <Compare
                  current={rates.emptyKmShare}
                  previous={prev((r) => r.emptyKmShare)}
                  fourWeeks={four((r) => r.emptyKmShare)}
                  higherIsBetter={false}
                  formatDelta={formatDeltaPoints}
                  formatValue={formatRate}
                />
                <TargetHint indicator="emptyKmShare" value={rates.emptyKmShare} targets={targets} />
              </>
            }
          />
          <Stat
            label="Partage prévu (CPAM)"
            value={formatRate(rates.sharedRate)}
            hint={
              <>
                <Line>
                  VSL <span className="tabular">{formatRate(eligibleSharedRate(figures, "VSL"))}</span> · taxi{" "}
                  <span className="tabular">{formatRate(eligibleSharedRate(figures, "TAXI"))}</span>
                </Line>
                <Line>
                  {tapTotal(figures.eligibleShared)} sur {plural(tapTotal(figures.eligible), "éligible")}
                </Line>
                <Compare
                  current={rates.sharedRate}
                  previous={prev((r) => r.sharedRate)}
                  fourWeeks={four((r) => r.sharedRate)}
                  higherIsBetter
                  formatDelta={formatDeltaPoints}
                  formatValue={formatRate}
                />
                <TargetHint indicator="sharedRate" value={rates.sharedRate} targets={targets} />
              </>
            }
          />
          <Stat
            label="Allers serrés"
            tone={figures.tightOutbound > 0 ? "warn" : "default"}
            value={figures.partial && figures.plannedOutbound === 0 ? "—" : String(figures.tightOutbound)}
            hint={
              <>
                <Line>
                  Dépose prévue moins de 5&nbsp;min avant le RDV, sur {plural(figures.plannedOutbound, "aller")} (
                  {formatRate(rates.tightRate)})
                </Line>
                <Compare
                  current={rates.tightRate}
                  previous={prev((r) => r.tightRate)}
                  fourWeeks={four((r) => r.tightRate)}
                  higherIsBetter={false}
                  formatDelta={formatDeltaPoints}
                  formatValue={formatRate}
                />
              </>
            }
          />
          <Stat
            label="Marge estimée"
            tone={figures.margin < 0 ? "bad" : "default"}
            value={formatEurosRounded(figures.margin)}
            hint={
              <>
                <Line>
                  CA <span className="tabular">{formatEurosRounded(figures.revenue)}</span> · coût{" "}
                  <span className="tabular">{formatEurosRounded(figures.cost)}</span>
                </Line>
                <Compare
                  current={rates.marginPerTrip}
                  previous={prev((r) => r.marginPerTrip)}
                  fourWeeks={four((r) => r.marginPerTrip)}
                  higherIsBetter
                  formatDelta={(delta) => `${formatDeltaEuros(delta)} / course`}
                  formatValue={(v) => `${formatEurosRounded(v)} / course`}
                />
                <TargetHint indicator="marginPerTrip" value={rates.marginPerTrip} targets={targets} per="course" />
              </>
            }
          />
        </div>
      )}
    </section>
  );
}
