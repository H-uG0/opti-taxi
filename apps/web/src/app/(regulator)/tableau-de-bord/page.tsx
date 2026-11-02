import type { Metadata } from "next";
import { Info } from "lucide-react";
import { LinkButton } from "@/components/ui/button";
import { Card, CardBody, CardHeader, EmptyState, PageHeader } from "@/components/ui/layout";
import { FormMessage } from "@/components/ui/form";
import { requireUser } from "@/lib/auth";
import { computeKpisByDay, hasPlanning, pickFocusDay, resolveKpiRange, summarizePeriod } from "@/lib/kpis";
import { addDays, formatShortDate, todayIso, tomorrowIso } from "@/lib/time";
import { KpiCharts } from "./charts";
import { plural } from "./format";
import { Headline } from "./headline";
import { KpiTable } from "./kpi-table";
import { loadKpiData } from "./load-kpis";
import { RangeForm } from "./range-form";

export const metadata: Metadata = { title: "Tableau de bord" };

/** Days loaded before the range so that its first day still has a comparison day. */
const COMPARISON_LOOKBACK_DAYS = 7;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser("REGULATOR");
  const params = await searchParams;
  const today = todayIso();
  const tomorrow = tomorrowIso();
  const range = resolveKpiRange({ from: first(params.from), to: first(params.to) }, tomorrow);

  const loadFrom = addDays(range.from, -COMPARISON_LOOKBACK_DAYS);
  const data = await loadKpiData(loadFrom, range.to);
  const allDays = computeKpisByDay(loadFrom, range.to, data, today);
  const days = allDays.filter((d) => d.date >= range.from);
  const period = summarizePeriod(days);
  const { focus, previous } = pickFocusDay(allDays, { from: range.from, requested: first(params.day) ?? null });
  const anyPlanning = days.some(hasPlanning);

  return (
    <div>
      <PageHeader
        title="Tableau de bord"
        description={`Les cinq indicateurs du besoin, jour par jour, du ${formatShortDate(range.from)} au ${formatShortDate(range.to)} (${plural(period.days, "jour")}).`}
      />

      <div className="mb-6 space-y-3">
        <RangeForm from={range.from} to={range.to} tomorrow={tomorrow} />
        {range.error ? <FormMessage tone="info">{range.error}</FormMessage> : null}
      </div>

      <p className="mb-6 flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>
          Valeurs de référence : les valeurs de départ de ces indicateurs sont à mesurer sur l&apos;historique de V
          (2 à 4 semaines de courses du planning manuel) avant tout développement ; c&apos;est la comparaison avec
          elles qui dira si l&apos;optimiseur fait mieux.
        </span>
      </p>

      {!anyPlanning ? (
        <EmptyState
          title="Aucune tournée ni optimisation sur la période"
          action={
            <LinkButton href={`/planning?date=${tomorrow}`} variant="primary">
              Ouvrir le planning J+1
            </LinkButton>
          }
        >
          Les indicateurs se calculent à partir des tournées : lancez « Optimiser demain » depuis le planning, ou
          choisissez une autre période.
        </EmptyState>
      ) : (
        <>
          {focus ? <Headline focus={focus} previous={previous} today={today} tomorrow={tomorrow} /> : null}

          <section aria-labelledby="trends-title" className="mb-8">
            <h2 id="trends-title" className="mb-3 text-base font-semibold text-slate-900">
              Évolution sur la période
            </h2>
            <KpiCharts days={days} period={period} focusDate={focus?.date ?? null} />
          </section>

          <section aria-labelledby="table-title" className="mb-8">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="table-title" className="text-base font-semibold text-slate-900">
                Détail par jour
              </h2>
              <p className="text-xs text-slate-500">Cliquez sur un jour pour l&apos;afficher en tête de page.</p>
            </div>
            <KpiTable days={days} period={period} focusDate={focus?.date ?? null} range={range} today={today} tomorrow={tomorrow} />
          </section>
        </>
      )}

      <Card>
        <CardHeader title="Méthode" />
        <CardBody className="space-y-2 text-sm text-slate-700">
          <p>
            Les indicateurs portent sur les tournées enregistrées pour chaque date (proposées ou validées) qui
            comptent encore au moins un arrêt, comme sur le planning. Une{" "}
            <strong className="font-medium text-slate-900">course servie</strong> est une course placée dans une tournée
            et ni annulée ni absente ; elle est <strong className="font-medium text-slate-900">réalisée</strong> quand le
            chauffeur l&apos;a marquée « déposé ». Les taux d&apos;une période sont recalculés à partir des totaux (et
            non en moyennant les taux journaliers).
          </p>
          <p>
            Km, CA estimé, coût et marge sont ceux calculés par l&apos;optimiseur pour chaque tournée : les distances
            sont celles d&apos;OSRM, ou une estimation à vol d&apos;oiseau quand OSRM n&apos;est pas configuré. Les
            heures réelles (dépose, validation) sont converties à l&apos;heure de Paris.
          </p>
          <p>
            Le détail du calcul de chaque indicateur figure sous son graphique. « — » signale une valeur non
            mesurable (aucune tournée, aucune course réalisée, jour à venir…). Le jour mis en avant est comparé au
            dernier jour planifié qui le précède.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
