import type { Metadata } from "next";
import { LinkButton } from "@/components/ui/button";
import { Card, CardBody, CardHeader, EmptyState, PageHeader } from "@/components/ui/layout";
import { FormMessage } from "@/components/ui/form";
import { auditRead } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import {
  computeKpisByDay,
  computeKpisForDates,
  hasPlanning,
  mixedDistanceSources,
  pickHeadlineDays,
  resolveKpiRange,
  resolveLateTolerance,
  summarizePeriod,
} from "@/lib/kpis";
import { planViewOf, plannedComparison, realizedComparison } from "@/lib/kpis-compare";
import { comparisonDates } from "@/lib/kpis-plan";
import { formatShortDate, todayIso, tomorrowIso } from "@/lib/time";
import { KpiCharts } from "./charts";
import { DemandSection, FleetSection } from "./demand-fleet";
import { lateThreshold, plural } from "./format";
import { PlannedBlock, RealizedBlock } from "./headline";
import { KpiTable } from "./kpi-table";
import { loadKpiData, loadKpiOptions, loadPatientInitials, loadSharingYear } from "./load-kpis";
import { RangeForm } from "./range-form";
import { SharingSection } from "./sharing-section";
import { WAIT_CASES_SHOWN, WaitsSection, type WaitCaseRow } from "./waits-section";

export const metadata: Metadata = { title: "Tableau de bord" };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("REGULATOR");
  const params = await searchParams;
  const today = todayIso();
  const tomorrow = tomorrowIso();
  const range = resolveKpiRange({ from: first(params.from), to: first(params.to) }, tomorrow);
  const tolerance = resolveLateTolerance(first(params.retard));

  const [options, data, sharingYear] = await Promise.all([loadKpiOptions(tolerance), loadKpiData(range), loadSharingYear(range.to)]);
  const days = computeKpisByDay(range.from, range.to, data, today, options);
  const period = summarizePeriod(days);
  const { realized, planned } = pickHeadlineDays(days, { ...range, today, tomorrow, requested: first(params.day) ?? null });

  // The headline compares with the same weekday of the 4 weeks before: load those outside the range.
  const extraDates = [...new Set([realized, planned].flatMap((day) => (day ? comparisonDates(day.date) : [])))]
    .filter((date) => date < range.from || date > range.to)
    .sort();
  const extraDays = extraDates.length > 0 ? computeKpisForDates(extraDates, await loadKpiData({ dates: extraDates }), today, options) : [];
  const lookup = new Map([...days, ...extraDays].map((day) => [day.date, day]));

  // Shared sessions over the wait limit, the longest first: initials only, and their read is traced.
  const cases = [...period.waits.cases].sort((a, b) => b.totalMin - a.totalMin || a.serviceDate.localeCompare(b.serviceDate));
  const shownCases = cases.slice(0, WAIT_CASES_SHOWN);
  const initials = await loadPatientInitials(shownCases.map((c) => c.patientId));
  if (shownCases.length > 0) {
    await auditRead(user, {
      action: "wait_cases.view",
      entity: "Trip",
      entityId: null,
      details: {
        from: range.from,
        to: range.to,
        tripIds: shownCases.flatMap((c) => [c.outboundTripId, c.returnTripId].filter((id): id is string => id !== null)),
      },
    });
  }
  const caseRows: WaitCaseRow[] = cases.map((c) => ({ ...c, initials: initials.get(c.patientId) ?? "—" }));
  const anyPlanning = days.some(hasPlanning);

  return (
    <div>
      <PageHeader
        title="Tableau de bord"
        description={`Les indicateurs de la régulation, jour par jour, du ${formatShortDate(range.from)} au ${formatShortDate(range.to)} (${plural(period.days, "jour")}).`}
      />

      <div className="mb-6 space-y-3">
        <RangeForm from={range.from} to={range.to} tomorrow={tomorrow} tolerance={tolerance} />
        {range.error ? <FormMessage tone="info">{range.error}</FormMessage> : null}
      </div>

      {period.simulatedDays > 0 ? (
        <div role="note" className="mb-6 rounded-md border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-900">
          <p className="font-medium">
            {/* Compared with the days that have routes: a Sunday or a day without planning is never simulated. */}
            {period.simulatedDays >= period.plannedDays
              ? "Toute la période est simulée"
              : `${plural(period.simulatedDays, "jour simulé", "jours simulés")} sur la période`}{" "}
            (marqués «&#x202F;simulé&#x202F;» dans le détail par jour)
          </p>
          <p className="mt-1">
            Ces journées ont été simulées pour la démonstration, avec le vrai optimiseur. Sont des paramètres de la simulation, pas
            des mesures&nbsp;: les retards (incidents de circulation tirés au hasard), le temps de planification (validation 15 à
            60&nbsp;min après le premier calcul), les annulations, les absences de patients, les dépassements de fin de séance (donc
            les attentes au retour), les refus de partage, les absences du personnel et les véhicules au garage, et la part
            d&apos;équipages qui saisissent leurs statuts (environ 85&nbsp;%). Les kilomètres, le partage des tournées, le taux de service et la
            marge viennent du calcul des tournées sur ces données fictives.
          </p>
        </div>
      ) : null}

      {!anyPlanning ? (
        <EmptyState
          title="Aucune tournée ni optimisation sur la période"
          action={
            <LinkButton href={`/planning?date=${tomorrow}`} variant="primary">
              Ouvrir le planning J+1
            </LinkButton>
          }
        >
          Les indicateurs se calculent à partir des tournées&nbsp;: lancez «&#x202F;Optimiser demain&#x202F;» depuis le planning, ou
          choisissez une autre période.
        </EmptyState>
      ) : (
        <>
          <section aria-label="Jours mis en avant" className="mb-8 space-y-6">
            {realized ? (
              <RealizedBlock
                day={realized}
                comparison={realizedComparison(realized.date, lookup)}
                today={today}
                tomorrow={tomorrow}
                toleranceMin={options.lateToleranceMin}
              />
            ) : (
              <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                Aucun jour réalisé avec des tournées sur la période.
              </p>
            )}
            {planned ? (
              <PlannedBlock
                day={planned}
                plan={planViewOf(planned, today)}
                comparison={plannedComparison(planned.date, lookup, today)}
                today={today}
                tomorrow={tomorrow}
              />
            ) : null}
          </section>

          <p
            role="note"
            className={
              period.exceptionalAmbulanceTrips > 0
                ? "mb-8 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
                : "mb-8 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700"
            }
          >
            <span className="font-medium">Recours exceptionnel à une ambulance pour un transport assis</span> (facturé au tarif VSL,
            protocole du 24 septembre 2025)&nbsp;:{" "}
            {period.exceptionalAmbulanceTrips > 0
              ? `${plural(period.exceptionalAmbulanceTrips, "course servie", "courses servies")} sur la période, à garder exceptionnel.`
              : "aucun sur la période."}
          </p>

          <DemandSection period={period} day={realized} />
          <FleetSection period={period} />
          <SharingSection period={period} months={sharingYear.months} year={sharingYear.total} maxDetourKm={options.maxDetourKm} />
          <WaitsSection period={period} options={options} cases={caseRows} />

          <section aria-labelledby="trends-title" className="mb-8">
            <h2 id="trends-title" className="mb-3 text-base font-semibold text-slate-900">
              Évolution sur la période
            </h2>
            {/* Above the charts: they mix the same days as the table. */}
            {mixedDistanceSources(period) ? (
              <p role="note" className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                Cette période mélange des tournées calculées avec les distances routières et avec l&apos;estimation à
                vol d&apos;oiseau (indiqué sous chaque jour du détail)&nbsp;: leurs kilomètres et leurs durées ne se comparent pas
                d&apos;un jour à l&apos;autre.
              </p>
            ) : null}
            <KpiCharts days={days} period={period} focusDate={realized?.date ?? planned?.date ?? null} toleranceMin={options.lateToleranceMin} />
          </section>

          <section aria-labelledby="table-title" className="mb-8">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="table-title" className="text-base font-semibold text-slate-900">
                Détail par jour
              </h2>
              <p className="text-xs text-slate-600">Cliquez sur un jour pour l&apos;afficher en tête de page.</p>
            </div>
            <KpiTable
              days={days}
              period={period}
              highlighted={[realized?.date, planned?.date].filter((d): d is string => Boolean(d))}
              range={range}
              tolerance={tolerance}
              today={today}
              tomorrow={tomorrow}
            />
          </section>
        </>
      )}

      <Card>
        <CardHeader title="Méthode" />
        <CardBody className="space-y-2 text-sm text-slate-700">
          <p>
            <strong className="font-medium text-slate-900">Toutes les courses</strong> de chaque date sont lues, servies ou non. Une{" "}
            <strong className="font-medium text-slate-900">course servie</strong> est placée dans une tournée et n&apos;est ni annulée ni
            absente&#x202F;; elle est <strong className="font-medium text-slate-900">réalisée</strong> quand l&apos;équipage l&apos;a marquée
            «&#x202F;déposé&#x202F;». Les courses non affectées, confiées à un confrère, annulées et absentes sont comptées dans «&#x202F;Demande
            et service&#x202F;». Les taux d&apos;une période sont recalculés à partir des totaux (et non en moyennant les taux journaliers).
          </p>
          <p>
            <strong className="font-medium text-slate-900">Prévu, servi, réalisé</strong>&nbsp;: le prévu est le plan tel que validé, figé à
            la validation (une validation le jour même ne remplace pas celle de la veille)&#x202F;; le servi, les tournées après les
            absences et les annulations du jour&#x202F;; le réalisé, les courses déposées. Le CA servi et réalisé est la somme des courses
            (une course dont le patient était absent n&apos;y est plus), au prix du dernier calcul&nbsp;: abattement de partage compris, même
            si le co-passager était absent. Le partage réalisé est mesuré aux horodatages&nbsp;: deux patients de la même tournée à bord
            en même temps.
          </p>
          <p>
            Km et coût sont ceux calculés par l&apos;optimiseur pour chaque tournée&nbsp;: les distances sont les distances routières, ou
            une estimation à vol d&apos;oiseau quand le calcul routier n&apos;est pas disponible. Les heures réelles (prise en charge, dépose,
            validation) sont converties à l&apos;heure de Paris. Un patient est en retard quand la dépose est saisie{" "}
            {lateThreshold(options.lateToleranceMin)} (tolérance réglable).
          </p>
          <p>
            La flotte de chaque jour est lue sur les équipages du jour (fixés par le régulateur, sinon proposés), avec la flotte et le
            personnel d&apos;aujourd&apos;hui&nbsp;: un véhicule ou une personne désactivés depuis ne comptent plus. «&#x202F;—&#x202F;» signale une
            valeur non mesurable (aucune tournée, aucune course réalisée, jour à venir…). Les jours mis en avant sont comparés au même
            jour de la semaine précédente et aux 4 mêmes jours précédents (séries de dialyse lundi-mercredi-vendredi ou mardi-jeudi-samedi).
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
