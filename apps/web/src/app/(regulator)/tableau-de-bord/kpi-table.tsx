import Link from "next/link";
import type { ComponentProps } from "react";
import { cn } from "@/components/ui/cn";
import { Table, TBody, THead } from "@/components/ui/table";
import { hasPlanning, type DayKpis, type PeriodKpis } from "@/lib/kpis";
import { formatKm, formatPercent, MATRIX_SOURCE_LABELS } from "@/lib/labels";
import { formatDuration, formatLongDate } from "@/lib/time";
import {
  capitalize,
  describeRealizedRate,
  formatDayShort,
  formatDecimal,
  formatEurosRounded,
  formatPlanningTime,
  plural,
} from "./format";
import { dashboardHref } from "./range-form";

/** Columns after the day column (colSpan of days without planning). */
const DATA_COLUMNS = 14;

const SOURCE_SHORT: Record<string, string> = { osrm: "routières", haversine: "vol d'oiseau", mixed: "mixte" };

/** Distance source(s) of a day or a period, under its date: one is the normal case, several do not compare. */
function sourcesCell(sources: readonly string[]): { tone: Tone; text: string; title: string | undefined } {
  if (sources.length === 0) return { tone: "muted", text: "—", title: undefined };
  const text = sources.map((source) => SOURCE_SHORT[source] ?? source).join(" + ");
  const mixed = sources.length > 1 || sources.includes("mixed");
  return {
    tone: mixed ? "warn" : "default",
    // Short under the date (the column must not widen); the title says what it is.
    text: mixed && sources.length > 1 ? "sources mélangées" : text,
    title: `Temps et distances\u00a0: ${sources.map((source) => MATRIX_SOURCE_LABELS[source] ?? source).join(", ")}`,
  };
}

const ALIGN = { left: "text-left", center: "text-center", right: "text-right" } as const;
const TONES = {
  default: "text-slate-800",
  strong: "font-medium text-slate-900",
  bad: "font-semibold text-red-700",
  warn: "text-amber-700",
  muted: "text-slate-500",
} as const;
type Tone = keyof typeof TONES;

/** Header cell (same look as the UI kit's Th, with alignment and group dividers). */
function HeadCell({
  align = "right",
  divider = false,
  className,
  ...props
}: ComponentProps<"th"> & { align?: keyof typeof ALIGN; divider?: boolean }) {
  return (
    <th
      scope="col"
      className={cn(
        "px-3 py-2 text-xs font-semibold tracking-wide whitespace-nowrap text-slate-600 uppercase",
        ALIGN[align],
        divider && "border-l border-slate-200",
        className,
      )}
      {...props}
    />
  );
}

/** Numeric cell: tabular figures, right-aligned. */
function Num({
  tone = "default",
  divider = false,
  className,
  ...props
}: ComponentProps<"td"> & { tone?: Tone; divider?: boolean }) {
  return (
    <td
      className={cn(
        "tabular px-3 py-2 text-right align-middle whitespace-nowrap",
        TONES[tone],
        divider && "border-l border-slate-100",
        className,
      )}
      {...props}
    />
  );
}

function lateCell(late: number, measured: number, upcoming = false): { tone: Tone; text: string } {
  if (upcoming || measured === 0) return { tone: "muted", text: "—" };
  return { tone: late > 0 ? "bad" : "default", text: `${late} / ${measured}` };
}

function plannedLateCell(late: number, planned: number): { tone: Tone; text: string } {
  if (planned === 0) return { tone: "muted", text: "—" };
  return { tone: late > 0 ? "bad" : "default", text: String(late) };
}

function realizedCell(day: DayKpis): { tone: Tone; text: string; title: string } {
  const realized = describeRealizedRate(day);
  if (realized.value === null) return { tone: "muted", text: "—", title: capitalize(realized.note) };
  return { tone: "default", text: realized.value, title: capitalize(realized.note) };
}

function planningTone(day: Pick<DayKpis, "planningStatus">): Tone {
  return day.planningStatus === "NOT_VALIDATED" ? "warn" : "default";
}

/** Every indicator, day by day (most recent first), with the period totals in the footer. */
export function KpiTable({
  days,
  period,
  focusDate,
  range,
  today,
  tomorrow,
}: {
  days: readonly DayKpis[];
  period: PeriodKpis;
  focusDate: string | null;
  range: { from: string; to: string };
  today: string;
  tomorrow: string;
}) {
  const rows = [...days].reverse();
  const periodLate = lateCell(period.lateArrivals, period.measuredOutbound);
  const periodPlannedLate = plannedLateCell(period.plannedLateArrivals, period.plannedOutbound);

  return (
    <Table>
      <caption className="sr-only">
        Indicateurs par jour du {formatLongDate(range.from)} au {formatLongDate(range.to)}, du plus récent au plus
        ancien, et totaux de la période. Le lien de chaque jour l&apos;affiche en tête de page.
      </caption>
      <THead>
        <tr>
          <HeadCell rowSpan={2} align="left" className="sticky left-0 z-10 bg-slate-50 align-bottom">
            Jour
          </HeadCell>
          <HeadCell rowSpan={2} className="align-bottom">
            Véhicules
          </HeadCell>
          <HeadCell rowSpan={2} className="align-bottom">
            Courses servies
          </HeadCell>
          <HeadCell colSpan={2} scope="colgroup" align="center" divider>
            Courses / véhicule
          </HeadCell>
          <HeadCell colSpan={2} scope="colgroup" align="center" divider>
            Kilomètres
          </HeadCell>
          <HeadCell rowSpan={2} divider className="align-bottom">
            Partagé
          </HeadCell>
          <HeadCell colSpan={2} scope="colgroup" align="center" divider>
            Arrivées après le RDV
          </HeadCell>
          <HeadCell rowSpan={2} divider className="align-bottom">
            Planning
          </HeadCell>
          <HeadCell rowSpan={2} className="align-bottom" title="Optimisations lancées pour la date">
            Optim.
          </HeadCell>
          <HeadCell rowSpan={2} divider className="align-bottom">
            CA estimé
          </HeadCell>
          <HeadCell rowSpan={2} className="align-bottom">
            Coût
          </HeadCell>
          <HeadCell rowSpan={2} className="align-bottom">
            Marge
          </HeadCell>
        </tr>
        <tr>
          <HeadCell divider>Prévu</HeadCell>
          <HeadCell>Réalisé</HeadCell>
          <HeadCell divider>Total</HeadCell>
          <HeadCell>À vide</HeadCell>
          <HeadCell divider title="Retards constatés / allers déposés avec heure saisie">
            Réels
          </HeadCell>
          <HeadCell title="Déposes planifiées après l'heure du RDV">Prévus</HeadCell>
        </tr>
      </THead>
      <TBody>
        {rows.map((day) => {
          const isFocus = day.date === focusDate;
          const background = isFocus ? "bg-brand-50" : "bg-white";
          const sources = sourcesCell(day.matrixSources);
          const dayCell = (
            <th scope="row" className={cn("sticky left-0 z-10 px-3 py-2 text-left font-normal whitespace-nowrap", background)}>
              <Link
                href={dashboardHref({ ...range, day: day.date })}
                aria-current={isFocus ? "true" : undefined}
                title={`Afficher le ${formatLongDate(day.date)} en tête de page`}
                className={cn(
                  "tabular rounded-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600",
                  isFocus ? "text-brand-800" : "text-slate-900",
                )}
              >
                {formatDayShort(day.date)}
              </Link>
              {day.date === tomorrow ? (
                <span className="ml-1.5 text-[11px] font-semibold text-brand-700">J+1</span>
              ) : day.date === today ? (
                <span className="ml-1.5 text-[11px] font-semibold text-sky-700">auj.</span>
              ) : null}
              {day.simulated ? (
                <span
                  className="ml-1.5 rounded-sm bg-violet-100 px-1 py-px text-[11px] font-semibold text-violet-800"
                  title="Journée simulée pour la démonstration&nbsp;: retards et temps de planification sont des paramètres de la simulation, pas des mesures"
                >
                  simulé
                </span>
              ) : null}
              {day.matrixSources.length > 0 ? (
                <span className={cn("block text-[11px]", TONES[sources.tone])} title={sources.title}>
                  {sources.text}
                </span>
              ) : null}
            </th>
          );

          if (!hasPlanning(day)) {
            return (
              <tr key={day.date} className={background}>
                {dayCell}
                <td colSpan={DATA_COLUMNS} className="px-3 py-2 text-slate-500">
                  Aucune tournée
                </td>
              </tr>
            );
          }

          const noRoutes = day.vehicles === 0;
          const realized = realizedCell(day);
          const late = lateCell(day.lateArrivals, day.measuredOutbound, day.upcoming);
          const plannedLate = plannedLateCell(day.plannedLateArrivals, day.plannedOutbound);
          return (
            <tr key={day.date} className={background}>
              {dayCell}
              <Num>{day.vehicles}</Num>
              <Num>{day.servedTrips}</Num>
              <Num divider tone="strong">
                {formatDecimal(day.tripsPerVehiclePlanned)}
              </Num>
              <Num tone={realized.tone} title={realized.title}>
                {realized.text}
                {day.inProgress && realized.tone !== "muted" ? (
                  <span className="ml-1 text-[11px] font-normal text-slate-500">en cours</span>
                ) : null}
              </Num>
              <Num divider>{noRoutes ? "—" : formatKm(day.distanceKm, 0)}</Num>
              <Num title={noRoutes ? undefined : `${formatKm(day.emptyKm, 0)} à vide`}>
                {formatPercent(day.emptyKmShare, 1)}
              </Num>
              <Num divider title={`${plural(day.sharedTrips, "course partagée", "courses partagées")}`}>
                {formatPercent(day.sharedRate, 1)}
              </Num>
              <Num
                divider
                tone={late.tone}
                title={day.maxDelayMinutes !== null ? `Retard maximal\u00a0: ${formatDuration(day.maxDelayMinutes)}` : undefined}
              >
                {late.text}
              </Num>
              <Num tone={plannedLate.tone}>{plannedLate.text}</Num>
              <Num
                divider
                tone={planningTone(day)}
                title={
                  day.planningStatus === "VALIDATED" && day.planningMinutes === null
                    ? "Validé sans optimisation enregistrée\u00a0: durée non mesurable"
                    : undefined
                }
              >
                {formatPlanningTime(day)}
              </Num>
              <Num>{day.optimizationRuns}</Num>
              <Num divider>{formatEurosRounded(noRoutes ? null : day.revenue)}</Num>
              <Num>{formatEurosRounded(noRoutes ? null : day.cost)}</Num>
              <Num tone={!noRoutes && day.margin < 0 ? "bad" : "strong"}>
                {formatEurosRounded(noRoutes ? null : day.margin)}
              </Num>
            </tr>
          );
        })}
      </TBody>
      <tfoot className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
        <tr>
          <th scope="row" className="sticky left-0 z-10 bg-slate-50 px-3 py-2 text-left whitespace-nowrap text-slate-900">
            Période
            <span className="block text-[11px] font-normal text-slate-500">
              {plural(period.plannedDays, "jour planifié", "jours planifiés")}
            </span>
            {period.matrixSources.length > 0 ? (
              <span
                className={cn("block text-[11px] font-normal", TONES[sourcesCell(period.matrixSources).tone])}
                title={sourcesCell(period.matrixSources).title}
              >
                {sourcesCell(period.matrixSources).text}
              </span>
            ) : null}
          </th>
          <Num tone="strong" title="Journées-véhicules">
            {period.vehicles}
          </Num>
          <Num tone="strong">{period.servedTrips}</Num>
          <Num divider tone="strong">
            {formatDecimal(period.tripsPerVehiclePlanned)}
          </Num>
          <Num
            tone="strong"
            title={
              period.inProgressDate
                ? "Jours terminés uniquement\u00a0: la journée en cours n'est pas comptée"
                : "Courses déposées ÷ véhicules dont l'équipage a saisi un statut"
            }
          >
            {formatDecimal(period.tripsPerVehicleRealized)}
          </Num>
          <Num divider tone="strong">
            {formatKm(period.distanceKm, 0)}
          </Num>
          <Num tone="strong">{formatPercent(period.emptyKmShare, 1)}</Num>
          <Num divider tone="strong">
            {formatPercent(period.sharedRate, 1)}
          </Num>
          <Num divider tone={periodLate.tone === "default" ? "strong" : periodLate.tone}>
            {periodLate.text}
          </Num>
          <Num tone={periodPlannedLate.tone === "default" ? "strong" : periodPlannedLate.tone}>
            {periodPlannedLate.text}
          </Num>
          <Num divider tone="strong" title="Moyenne des jours validés dont la durée est mesurable">
            {period.averagePlanningMinutes === null ? "—" : `moy. ${formatDuration(period.averagePlanningMinutes)}`}
          </Num>
          <Num tone="strong">{period.optimizationRuns}</Num>
          <Num divider tone="strong">
            {formatEurosRounded(period.revenue)}
          </Num>
          <Num tone="strong">{formatEurosRounded(period.cost)}</Num>
          <Num tone={period.margin < 0 ? "bad" : "strong"}>{formatEurosRounded(period.margin)}</Num>
        </tr>
      </tfoot>
    </Table>
  );
}
