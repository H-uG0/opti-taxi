import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/components/ui/cn";
import { Stat } from "@/components/ui/layout";
import { deltaTrend, kpiDelta, mixedDistanceSources, type DayKpis } from "@/lib/kpis";
import { formatKm, formatPercent } from "@/lib/labels";
import { formatDuration, formatLongDate } from "@/lib/time";
import {
  capitalize,
  describeRealizedRate,
  formatDayShort,
  formatDecimal,
  formatDeltaCount,
  formatDeltaDecimal,
  formatDeltaEuros,
  formatDeltaMinutes,
  formatDeltaPoints,
  formatEurosRounded,
  formatInstant,
  formatPlanningTime,
  measuredLateArrivals,
  plannedMargin,
  plural,
} from "./format";

function Line({ children }: { children: ReactNode }) {
  return <span className="block">{children}</span>;
}

/** Change against the comparison day, with an arrow and a word, never color alone. */
function Delta({
  current,
  previous,
  higherIsBetter,
  format,
}: {
  current: number | null;
  previous: { date: string; value: number | null } | null;
  higherIsBetter: boolean;
  format: (delta: number) => string;
}) {
  if (!previous) return null;
  const delta = kpiDelta(current, previous.value);
  const trend = deltaTrend(delta, higherIsBetter);
  if (delta === null || trend === null) {
    return <Line>Pas de comparaison avec le {formatDayShort(previous.date)}</Line>;
  }
  const Icon = trend === "same" ? Minus : delta > 0 ? ArrowUpRight : ArrowDownRight;
  const tone = trend === "better" ? "text-emerald-700" : trend === "worse" ? "text-red-700" : "text-slate-600";
  const verdict = trend === "better" ? "en amélioration" : trend === "worse" ? "en dégradation" : "stable";
  return (
    <span className="mt-1 flex flex-wrap items-center gap-x-1">
      <span className={cn("tabular inline-flex items-center gap-0.5 font-medium", tone)}>
        <Icon aria-hidden className="size-3.5" />
        {trend === "same" ? "stable" : format(delta)}
      </span>
      <span>vs {formatDayShort(previous.date)}</span>
      {trend !== "same" ? <span className="sr-only">({verdict})</span> : null}
    </span>
  );
}

/** Headline tiles of the focus day, compared with the previous planned day. */
export function Headline({
  focus,
  previous,
  today,
  tomorrow,
}: {
  focus: DayKpis;
  previous: DayKpis | null;
  today: string;
  tomorrow: string;
}) {
  const compare = (value: (day: DayKpis) => number | null) =>
    previous ? { date: previous.date, value: value(previous) } : null;
  const late = measuredLateArrivals(focus);
  const lateTone = focus.lateArrivals > 0 || focus.plannedLateArrivals > 0 ? "bad" : late !== null ? "good" : "default";
  const noRoutes = focus.vehicles === 0;
  const realized = describeRealizedRate(focus);

  return (
    <section aria-labelledby="focus-day-title" className="mb-8">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id="focus-day-title" className="text-base font-semibold text-slate-900">
          {capitalize(formatLongDate(focus.date))}
        </h2>
        {focus.date === tomorrow ? <Badge tone="brand">J+1</Badge> : null}
        {focus.date === today ? <Badge tone="info">Aujourd&apos;hui</Badge> : null}
        {focus.simulated ? <Badge tone="simulated">Journée simulée</Badge> : null}
        {focus.planningStatus === "VALIDATED" ? (
          <Badge tone="success">Planning validé</Badge>
        ) : focus.planningStatus === "NOT_VALIDATED" ? (
          <Badge tone="warning">Planning non validé</Badge>
        ) : (
          <Badge>Pas de planning</Badge>
        )}
        <p className="text-sm text-slate-600">
          {previous
            ? `Comparé au ${formatLongDate(previous.date)}, dernier jour planifié avant.`
            : "Aucun jour planifié avant pour comparer."}
        </p>
        {previous && mixedDistanceSources(focus, previous) ? (
          <p role="note" className="text-sm text-amber-800">
            Distances calculées différemment ces deux jours (OSRM ou estimation à vol d&apos;oiseau) : comparaison des
            km et des durées indicative.
          </p>
        ) : null}
      </div>

      {noRoutes ? (
        <p className="mb-3 text-sm text-slate-600">
          Aucune tournée ce jour : les indicateurs s&apos;afficheront après l&apos;optimisation.
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        <Stat
          label="Courses / véhicule"
          value={formatDecimal(focus.tripsPerVehiclePlanned)}
          hint={
            <>
              <Line>
                Réalisé :{" "}
                {realized.value !== null ? (
                  <>
                    <span className="tabular font-medium text-slate-700">{realized.value}</span>
                    {focus.inProgress ? " (en cours)" : null}
                  </>
                ) : (
                  realized.note
                )}
              </Line>
              {realized.value !== null ? <Line>{realized.note}</Line> : null}
              <Line>
                {plural(focus.servedTrips, "course")} · {plural(focus.vehicles, "véhicule")}
              </Line>
              <Delta
                current={focus.tripsPerVehiclePlanned}
                previous={compare((d) => d.tripsPerVehiclePlanned)}
                higherIsBetter
                format={formatDeltaDecimal}
              />
            </>
          }
        />
        <Stat
          label="Km à vide"
          value={formatPercent(focus.emptyKmShare, 1)}
          hint={
            <>
              <Line>
                <span className="tabular">{formatKm(focus.emptyKm, 0)}</span> sur{" "}
                <span className="tabular">{formatKm(focus.distanceKm, 0)}</span>
              </Line>
              <Delta
                current={focus.emptyKmShare}
                previous={compare((d) => d.emptyKmShare)}
                higherIsBetter={false}
                format={formatDeltaPoints}
              />
            </>
          }
        />
        <Stat
          label="Transport partagé"
          value={formatPercent(focus.sharedRate, 1)}
          hint={
            <>
              <Line>
                {focus.sharedTrips} sur {plural(focus.servedTrips, "course servie", "courses servies")}
              </Line>
              <Delta
                current={focus.sharedRate}
                previous={compare((d) => d.sharedRate)}
                higherIsBetter
                format={formatDeltaPoints}
              />
            </>
          }
        />
        <Stat
          label="Arrivées après le RDV"
          tone={lateTone}
          value={late === null ? "—" : String(late)}
          hint={
            <>
              <Line>
                {late !== null
                  ? `${formatPercent(focus.lateRate, 1)} des ${plural(focus.measuredOutbound, "aller mesuré", "allers mesurés")}${
                      focus.maxDelayMinutes !== null ? ` · max ${formatDuration(focus.maxDelayMinutes)}` : ""
                    }`
                  : focus.upcoming
                    ? "Réel : jour à venir"
                    : focus.realizedOutbound > 0
                      ? "Heures de dépose non saisies"
                      : "Aucun aller déposé"}
              </Line>
              <Line>
                Prévu : {focus.plannedLateArrivals} en retard sur{" "}
                {plural(focus.plannedOutbound, "aller")}
              </Line>
              <Delta
                current={late}
                previous={compare(measuredLateArrivals)}
                higherIsBetter={false}
                format={formatDeltaCount}
              />
            </>
          }
        />
        <Stat
          label="Temps de planification"
          tone={focus.planningStatus === "NOT_VALIDATED" ? "warn" : "default"}
          value={formatPlanningTime(focus)}
          hint={
            <>
              <Line>
                {plural(focus.optimizationRuns, "optimisation")}
                {focus.firstRunAt ? ` · 1re le ${formatInstant(focus.firstRunAt)}` : ""}
              </Line>
              {focus.validatedAt ? <Line>Validé le {formatInstant(focus.validatedAt)}</Line> : null}
              <Delta
                current={focus.planningMinutes}
                previous={compare((d) => d.planningMinutes)}
                higherIsBetter={false}
                format={formatDeltaMinutes}
              />
            </>
          }
        />
        <Stat
          label="Marge estimée"
          tone={focus.vehicles > 0 && focus.margin < 0 ? "bad" : "default"}
          value={formatEurosRounded(plannedMargin(focus))}
          hint={
            <>
              <Line>
                CA <span className="tabular">{formatEurosRounded(noRoutes ? null : focus.revenue)}</span> · coût{" "}
                <span className="tabular">{formatEurosRounded(noRoutes ? null : focus.cost)}</span>
              </Line>
              <Delta
                current={plannedMargin(focus)}
                previous={compare(plannedMargin)}
                higherIsBetter
                format={formatDeltaEuros}
              />
            </>
          }
        />
      </div>
    </section>
  );
}
