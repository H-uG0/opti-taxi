import Link from "next/link";
import type { ComponentProps } from "react";
import { cn } from "@/components/ui/cn";
import { Table, TBody, THead } from "@/components/ui/table";
import { hasPlanning, type DayKpis, type PeriodKpis } from "@/lib/kpis";
import { lostTrips, placedTrips, tripsToCarry } from "@/lib/kpis-demand";
import { planRates } from "@/lib/kpis-plan";
import { tapTotal } from "@/lib/kpis-sharing";
import { formatKm, formatPercent, MATRIX_SOURCE_LABELS } from "@/lib/labels";
import { formatDuration, formatLongDate } from "@/lib/time";
import {
  capitalize,
  describeRealizedRate,
  formatDayShort,
  formatDecimal,
  formatEurosRounded,
  formatInstant,
  formatPlanningTime,
  plural,
} from "./format";
import { dashboardHref } from "./range-form";

/** Columns after the day column (colSpan of days without planning). */
const DATA_COLUMNS = 13;

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
    title: `Temps et distances : ${sources.map((source) => MATRIX_SOURCE_LABELS[source] ?? source).join(", ")}`,
  };
}

const ALIGN = { left: "text-left", center: "text-center", right: "text-right" } as const;
const TONES = {
  default: "text-slate-800",
  strong: "font-medium text-slate-900",
  bad: "font-semibold text-red-700",
  warn: "text-amber-700",
  muted: "text-slate-600",
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
        "px-2 py-2 text-xs font-semibold whitespace-nowrap text-slate-600 uppercase",
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
        "tabular px-2 py-2 text-right align-middle whitespace-nowrap",
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

function tightCell(tight: number, planned: number): { tone: Tone; text: string } {
  if (planned === 0) return { tone: "muted", text: "—" };
  return { tone: "default", text: String(tight) };
}

function realizedCell(day: DayKpis): { tone: Tone; text: string; title: string } {
  const realized = describeRealizedRate(day);
  if (realized.value === null) return { tone: "muted", text: "—", title: capitalize(realized.note) };
  return { tone: "default", text: realized.value, title: capitalize(realized.note) };
}

/** « Prévu » trips per vehicle: the plan as validated (frozen) for a day started, else the routes as they stand. */
function plannedCell(day: DayKpis, today: string): { text: string; title: string } {
  if (day.date <= today && day.frozen) {
    return {
      text: formatDecimal(planRates(day.frozen.figures).tripsPerVehicle),
      title: `Plan validé le ${formatInstant(day.frozen.validatedAt)} : ${plural(day.frozen.figures.served, "course")}, ${plural(day.frozen.figures.vehicles, "véhicule")}. Servi aujourd'hui : ${formatDecimal(day.tripsPerVehiclePlanned)}`,
    };
  }
  return {
    text: formatDecimal(day.tripsPerVehiclePlanned),
    title: day.date <= today ? "Pas de plan validé figé ce jour : les tournées telles qu'elles sont" : "Tournées prévues",
  };
}

function planningTone(day: Pick<DayKpis, "planningStatus">): Tone {
  return day.planningStatus === "NOT_VALIDATED" ? "warn" : "default";
}

function demandTitle(d: DayKpis["demand"]): string {
  return [
    `${d.requested} demandées`,
    `${d.cancelledBefore + d.cancelledOnDay} annulées (dont ${d.cancelledOnDay} le jour même)`,
    `${d.served} servies`,
    `${d.noShows} absents`,
    `${d.unassigned} non affectées`,
    `${d.handedOver} confiées à un confrère`,
  ].join(" · ");
}

/** Every indicator, day by day (most recent first), with the period totals in the footer. */
export function KpiTable({
  days,
  period,
  highlighted,
  range,
  tolerance,
  today,
  tomorrow,
}: {
  days: readonly DayKpis[];
  period: PeriodKpis;
  /** The days shown at the top of the page. */
  highlighted: readonly string[];
  range: { from: string; to: string };
  tolerance: number;
  today: string;
  tomorrow: string;
}) {
  const rows = [...days].reverse();
  const periodLate = lateCell(period.lateArrivals, period.measuredOutbound);
  const periodTight = tightCell(period.tightOutbound, period.plannedOutbound);
  const periodLost = lostTrips(period.demand);

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
          <HeadCell colSpan={3} scope="colgroup" align="center">
            Demande
          </HeadCell>
          <HeadCell rowSpan={2} divider className="align-bottom" title="Véhicules utilisés / véhicules disponibles (ni indisponibles ni sans équipage)">
            Véhicules
          </HeadCell>
          <HeadCell colSpan={2} scope="colgroup" align="center" divider>
            Courses / véhicule
          </HeadCell>
          <HeadCell rowSpan={2} divider className="align-bottom" title="Part des km roulés sans patient à bord (km totaux au survol)">
            Km à vide
          </HeadCell>
          <HeadCell rowSpan={2} divider className="align-bottom" title="Partage prévu des courses éligibles en taxi ou VSL (Assurance maladie)">
            Partagé
          </HeadCell>
          <HeadCell colSpan={2} scope="colgroup" align="center" divider>
            Ponctualité
          </HeadCell>
          <HeadCell rowSpan={2} divider className="align-bottom">
            Planning
          </HeadCell>
          <HeadCell rowSpan={2} divider className="align-bottom" title="CA estimé des courses servies (absents exclus)">
            CA estimé
          </HeadCell>
          <HeadCell rowSpan={2} className="align-bottom" title="CA estimé des courses servies − coût des tournées">
            Marge
          </HeadCell>
        </tr>
        <tr>
          <HeadCell title="Courses demandées moins les annulations (la veille ou le jour même)">À transp.</HeadCell>
          <HeadCell title="Courses placées (servies ou patient absent) ÷ courses à transporter">Service</HeadCell>
          <HeadCell title={"Courses perdues\u00a0: non affectées ou confiées à un confrère"}>Perdues</HeadCell>
          <HeadCell divider title="Plan validé (figé à la validation) pour un jour commencé, tournées prévues sinon">
            Prévu
          </HeadCell>
          <HeadCell>Réalisé</HeadCell>
          <HeadCell divider title={`Allers déposés plus de ${tolerance} min après le RDV / allers déposés avec heure saisie`}>
            Retards
          </HeadCell>
          <HeadCell title={"Allers dont la dépose est prévue moins de 5\u00a0min avant le RDV"}>Serrés</HeadCell>
        </tr>
      </THead>
      <TBody>
        {rows.map((day) => {
          const isHighlighted = highlighted.includes(day.date);
          const background = isHighlighted ? "bg-brand-50" : "bg-white";
          const sources = sourcesCell(day.matrixSources);
          const dayCell = (
            <th scope="row" className={cn("sticky left-0 z-10 px-3 py-2 text-left font-normal whitespace-nowrap", background)}>
              <Link
                href={dashboardHref({ ...range, day: day.date, tolerance })}
                aria-current={isHighlighted ? "true" : undefined}
                title={`Afficher le ${formatLongDate(day.date)} en tête de page`}
                className={cn(
                  "tabular rounded-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600",
                  isHighlighted ? "text-brand-800" : "text-slate-900",
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
                  title="Journée simulée pour la démonstration&nbsp;: retards, absences, annulations et temps de planification sont des paramètres de la simulation, pas des mesures"
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
                <td colSpan={DATA_COLUMNS} className="px-3 py-2 text-slate-600">
                  {day.demand.requested > 0
                    ? `Aucune tournée · ${plural(day.demand.requested, "course demandée", "courses demandées")}`
                    : "Aucune tournée"}
                </td>
              </tr>
            );
          }

          const noRoutes = day.vehicles === 0;
          const realized = realizedCell(day);
          const planned = plannedCell(day, today);
          const late = lateCell(day.lateArrivals, day.measuredOutbound, day.upcoming);
          const tight = tightCell(day.tightOutbound, day.plannedOutbound);
          const lost = lostTrips(day.demand);
          const servedMargin = day.servedRevenue - day.cost;
          return (
            <tr key={day.date} className={background}>
              {dayCell}
              <Num title={demandTitle(day.demand)}>{tripsToCarry(day.demand)}</Num>
              <Num tone="strong" title={`${placedTrips(day.demand)} placées sur ${tripsToCarry(day.demand)} à transporter`}>
                {formatPercent(day.serviceRate, 1)}
              </Num>
              <Num tone={lost > 0 ? "warn" : "muted"} title={`${day.demand.unassigned} non affectées · ${day.demand.handedOver} confiées`}>
                {lost}
              </Num>
              <Num
                divider
                title={
                  day.fleet
                    ? `${day.fleet.active} actifs · ${day.fleet.unavailable} indisponibles · ${day.fleet.crewless} sans équipage`
                    : undefined
                }
              >
                {day.fleet ? `${day.vehicles} / ${day.fleet.available}` : day.vehicles}
              </Num>
              <Num divider tone="strong" title={planned.title}>
                {planned.text}
              </Num>
              <Num tone={realized.tone} title={realized.title}>
                {realized.text}
                {day.inProgress && realized.tone !== "muted" ? (
                  <span className="ml-1 text-[11px] font-normal text-slate-600">en cours</span>
                ) : null}
              </Num>
              <Num divider title={noRoutes ? undefined : `${formatKm(day.emptyKm, 0)} à vide sur ${formatKm(day.distanceKm, 0)}`}>
                {formatPercent(day.emptyKmShare, 1)}
              </Num>
              <Num
                divider
                title={`${tapTotal(day.sharing.eligibleShared)} sur ${plural(tapTotal(day.sharing.eligible), "course éligible", "courses éligibles")} · mesuré ${formatPercent(day.measuredSharedRate, 1)}`}
              >
                {formatPercent(day.eligibleSharedRate, 1)}
              </Num>
              <Num
                divider
                tone={late.tone}
                title={
                  day.measuredOutbound > 0
                    ? `Au-delà de 15 min : ${day.lateOver15}${day.maxDelayMinutes !== null ? ` · retard maximal ${formatDuration(day.maxDelayMinutes)}` : ""}`
                    : undefined
                }
              >
                {late.text}
              </Num>
              <Num tone={tight.tone} title={`${day.tightOutbound} sur ${plural(day.plannedOutbound, "aller planifié", "allers planifiés")}`}>
                {tight.text}
              </Num>
              <Num
                divider
                tone={planningTone(day)}
                title={
                  day.planningStatus === "VALIDATED" && day.planningMinutes === null
                    ? "Validé sans optimisation enregistrée : durée non mesurable"
                    : plural(day.optimizationRuns, "optimisation")
                }
              >
                {formatPlanningTime(day)}
              </Num>
              <Num divider>{formatEurosRounded(noRoutes ? null : day.servedRevenue)}</Num>
              <Num tone={!noRoutes && servedMargin < 0 ? "bad" : "strong"} title={noRoutes ? undefined : `Coût ${formatEurosRounded(day.cost)}`}>
                {formatEurosRounded(noRoutes ? null : servedMargin)}
              </Num>
            </tr>
          );
        })}
      </TBody>
      <tfoot className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
        <tr>
          <th scope="row" className="sticky left-0 z-10 bg-slate-50 px-3 py-2 text-left whitespace-nowrap text-slate-900">
            Période
            <span className="block text-[11px] font-normal text-slate-600">
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
          <Num tone="strong" title={demandTitle(period.demand)}>
            {tripsToCarry(period.demand)}
          </Num>
          <Num tone="strong">{formatPercent(period.serviceRate, 1)}</Num>
          <Num tone={periodLost > 0 ? "warn" : "strong"}>{periodLost}</Num>
          <Num divider tone="strong" title="Journées-véhicules utilisées / disponibles">
            {period.fleet ? `${period.vehicles} / ${period.fleet.available}` : period.vehicles}
            <span className="block text-[11px] font-normal text-slate-600">journées-véhicules</span>
          </Num>
          <Num divider tone="strong" title="Courses servies ÷ journées-véhicules utilisées">
            {formatDecimal(period.tripsPerVehiclePlanned)}
          </Num>
          <Num
            tone="strong"
            title={
              period.inProgressDate
                ? "Jours terminés uniquement : la journée en cours n'est pas comptée"
                : "Courses déposées ÷ véhicules dont l'équipage a saisi un statut"
            }
          >
            {formatDecimal(period.tripsPerVehicleRealized)}
          </Num>
          <Num divider tone="strong" title={`${formatKm(period.emptyKm, 0)} à vide sur ${formatKm(period.distanceKm, 0)}`}>
            {formatPercent(period.emptyKmShare, 1)}
          </Num>
          <Num divider tone="strong">
            {formatPercent(period.eligibleSharedRate, 1)}
          </Num>
          <Num divider tone={periodLate.tone === "default" ? "strong" : periodLate.tone}>
            {periodLate.text}
          </Num>
          <Num tone={periodTight.tone === "default" ? "strong" : periodTight.tone}>{periodTight.text}</Num>
          <Num divider tone="strong" title="Moyenne des jours validés dont la durée est mesurable">
            {period.averagePlanningMinutes === null ? "—" : `moy. ${formatDuration(period.averagePlanningMinutes)}`}
          </Num>
          <Num divider tone="strong">
            {formatEurosRounded(period.servedRevenue)}
          </Num>
          <Num tone={period.servedRevenue - period.cost < 0 ? "bad" : "strong"} title={`Coût ${formatEurosRounded(period.cost)}`}>
            {formatEurosRounded(period.servedRevenue - period.cost)}
          </Num>
        </tr>
      </tfoot>
    </Table>
  );
}
