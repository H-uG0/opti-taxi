import type { Metadata } from "next";
import Link from "next/link";
import { buttonClasses, LinkButton } from "@/components/ui/button";
import { Card, CardBody, CardHeader, EmptyState, PageHeader } from "@/components/ui/layout";
import { FormMessage } from "@/components/ui/form";
import { auditRead } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { hasPlanning, mixedDistanceSources, pickHeadlineDays, resolveLateTolerance, type DayKpis } from "@/lib/kpis";
import { planViewOf, plannedComparison, realizedComparison } from "@/lib/kpis-compare";
import { groupEnergy, sumEnergy, vehicleEnergy } from "@/lib/kpis-energy";
import { comparisonDates } from "@/lib/kpis-plan";
import { inScope } from "@/lib/kpis-scope";
import { trendPoints } from "@/lib/kpis-trend";
import { formatShortDate } from "@/lib/time";
import { BreakdownSection } from "./breakdown-section";
import { KpiCharts } from "./charts";
import { dashboardLines, leadInDates, loadDashboard, loadExtraDays, type Dashboard } from "./dashboard-data";
import { DemandSection, FleetSection } from "./demand-fleet";
import { EconomySection } from "./economy-section";
import { EnergySection } from "./energy-section";
import { lateThreshold, plural } from "./format";
import { PlannedBlock, RealizedBlock } from "./headline";
import { KpiTable, SCOPED_DEMAND } from "./kpi-table";
import { loadFleetEnergyInputs, loadPatientInitials, loadPeople, loadSharingYear } from "./load-kpis";
import { PlanningSection } from "./planning-section";
import { exportHref, parseDashboardQuery, type DashboardQuery, type HrefState } from "./query";
import { DashboardTabs, RangeForm } from "./range-form";
import { SharingSection } from "./sharing-section";
import { TrendTable } from "./trend-table";
import { WAIT_CASES_SHOWN, WaitsSection, type WaitCaseRow } from "./waits-section";

export const metadata: Metadata = { title: "Tableau de bord" };

type User = Awaited<ReturnType<typeof requireUser>>;

/**
 * The dashboard, in tabs (each its own address, ?vue=): the default view,
 * « Synthèse », stays short (the two days of the headline, the trends against
 * their objectives, the detail by day); each other subject has its tab, and
 * only its own data is loaded (the year of sharing, the patients' initials of
 * the waits, the fill-ups, the names of the people). The period, its step,
 * the lateness tolerance and the depot or vehicle type it is narrowed to are
 * above every tab and kept by every link.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("REGULATOR");
  const params = await searchParams;
  const rawTolerance = params.retard;
  const query = parseDashboardQuery(params, resolveLateTolerance(Array.isArray(rawTolerance) ? rawTolerance[0] : rawTolerance));
  const dashboard = await loadDashboard(query);
  const { range, period, days, scope } = dashboard;
  const base: HrefState = {
    tab: query.tab,
    from: range.from,
    to: range.to,
    granularity: range.explicitGranularity ? range.granularity : null,
    tolerance: query.tolerance,
    depotId: scope.depotId,
    vehicleType: scope.vehicleType,
    axis: query.axis,
    sort: query.sort,
  };
  const anyPlanning = days.some(hasPlanning);
  const depotLabel = scope.depotId ? dashboard.refs.depots.find((d) => d.id === scope.depotId)?.name : null;
  const scopeLabel = [depotLabel ? `dépôt ${depotLabel}` : null, scope.vehicleType ? { TAXI: "taxis", VSL: "VSL", AMBULANCE: "ambulances" }[scope.vehicleType] : null]
    .filter(Boolean)
    .join(", ");

  return (
    <div>
      <PageHeader
        title="Tableau de bord"
        description={`Les indicateurs de la régulation du ${formatShortDate(range.from)} au ${formatShortDate(range.to)} (${plural(period.days, "jour")})${
          scopeLabel ? `, ${scopeLabel} seulement` : ", toute l'entreprise"
        }.`}
        actions={
          <>
            {/* Plain links: a file to download, not a page for the client router. */}
            <a href={exportHref(base, "jour")} download className={buttonClasses("secondary", "sm")}>
              Exporter (CSV)
            </a>
            <a href={exportHref(base, scope.depotId ? "vehicule" : "depot")} download className={buttonClasses("ghost", "sm")}>
              {scope.depotId ? "CSV par véhicule" : "CSV par dépôt"}
            </a>
          </>
        }
      />

      <div className="mb-4 space-y-3">
        <RangeForm range={range} base={base} today={dashboard.today} tomorrow={dashboard.tomorrow} depots={dashboard.refs.depots} />
        {range.error ? <FormMessage tone="info">{range.error}</FormMessage> : null}
      </div>

      <div className="mb-6">
        <DashboardTabs base={base} />
      </div>

      {period.simulatedDays > 0 ? (
        <details className="mb-6 rounded-md border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-900">
          <summary className="cursor-pointer font-medium">
            {/* Compared with the days that have routes: a Sunday or a day without planning is never simulated. */}
            {period.simulatedDays >= period.plannedDays
              ? "Toute la période est simulée"
              : `${plural(period.simulatedDays, "jour simulé", "jours simulés")} sur la période`}{" "}
            (jours marqués «&#x202F;simulé&#x202F;»)&nbsp;: ce qui vient de la simulation
          </summary>
          <p className="mt-1">
            Ces journées ont été simulées pour la démonstration, avec le vrai optimiseur. Sont des paramètres de la simulation, pas
            des mesures&nbsp;: les retards (incidents de circulation tirés au hasard), le temps de planification (sessions et
            validation 15 à 60&nbsp;min après le premier calcul), les annulations, les absences de patients, les dépassements de fin de
            séance (donc les attentes au retour), les refus de partage, les absences du personnel et les véhicules au garage, la part
            d&apos;équipages qui saisissent leurs statuts (environ 85&nbsp;%) et les pleins (tirés des km planifiés). Les kilomètres, le
            partage des tournées, le taux de service et la marge viennent du calcul des tournées sur ces données fictives.
          </p>
        </details>
      ) : null}

      {!anyPlanning ? (
        <EmptyState
          title="Aucune tournée ni optimisation sur la période"
          action={
            <LinkButton href={`/planning?date=${dashboard.tomorrow}`} variant="primary">
              Ouvrir le planning J+1
            </LinkButton>
          }
        >
          Les indicateurs se calculent à partir des tournées&nbsp;: lancez «&#x202F;Optimiser demain&#x202F;» depuis le planning, ou
          choisissez une autre période.
        </EmptyState>
      ) : (
        <TabContent dashboard={dashboard} query={query} base={base} user={user} />
      )}

      {query.tab === "synthese" ? <MethodCard dashboard={dashboard} /> : null}
    </div>
  );
}

async function TabContent({ dashboard, query, base, user }: { dashboard: Dashboard; query: DashboardQuery; base: HrefState; user: User }) {
  const { period, days, options, scoped } = dashboard;
  switch (query.tab) {
    case "demande":
      return scoped ? (
        <FormMessage tone="info">{SCOPED_DEMAND}</FormMessage>
      ) : (
        <>
          <DemandSection
            period={period}
            day={
              pickHeadlineDays(days, {
                from: dashboard.range.from,
                to: dashboard.range.to,
                today: dashboard.today,
                tomorrow: dashboard.tomorrow,
                requested: query.day,
              }).realized
            }
          />
          <ExceptionalAmbulance count={period.exceptionalAmbulanceTrips} />
        </>
      );
    case "flotte":
      return <FleetTab dashboard={dashboard} />;
    case "partage": {
      const year = await loadSharingYear(dashboard.range.to, dashboard.scope);
      return <SharingSection period={period} months={year.months} year={year.total} maxDetourKm={options.maxDetourKm} />;
    }
    case "attentes":
      return <WaitsTab dashboard={dashboard} user={user} />;
    case "economie":
      return (
        <>
          <EconomySection lines={dashboardLines(dashboard)} period={period} />
          {!scoped ? <ExceptionalAmbulance count={period.exceptionalAmbulanceTrips} /> : null}
        </>
      );
    case "planification":
      return <PlanningSection days={days} period={period} scoped={scoped} />;
    case "ventilation":
      return <BreakdownTab dashboard={dashboard} query={query} base={base} />;
    default:
      return <SynthesisTab dashboard={dashboard} query={query} base={base} />;
  }
}

/** « Synthèse »: the headline days, the trends against their objectives, the detail. */
async function SynthesisTab({ dashboard, query, base }: { dashboard: Dashboard; query: DashboardQuery; base: HrefState }) {
  const { days, period, range, today, tomorrow, options, targets, scoped } = dashboard;
  const { realized, planned } = pickHeadlineDays(days, { ...range, today, tomorrow, requested: query.day });
  // The headline compares with the same weekday of the 4 weeks before, the moving average reads the days before the range.
  const extraDates = [
    ...[realized, planned].flatMap((day) => (day ? comparisonDates(day.date) : [])),
    ...(range.granularity === "day" ? leadInDates(range) : []),
  ];
  const extraDays = await loadExtraDays(dashboard, extraDates);
  const lookup = new Map<string, DayKpis>([...days, ...extraDays].map((day) => [day.date, day]));
  const points = trendPoints(days, range.granularity, extraDays);

  return (
    <>
      <section aria-label="Jours mis en avant" className="mb-8 space-y-6">
        {realized ? (
          <RealizedBlock
            day={realized}
            comparison={realizedComparison(realized.date, lookup)}
            today={today}
            tomorrow={tomorrow}
            toleranceMin={options.lateToleranceMin}
            targets={targets}
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
            targets={targets}
          />
        ) : null}
      </section>

      <section aria-labelledby="trends-title" className="mb-8">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="trends-title" className="text-base font-semibold text-slate-900">
            Tendances et objectifs
          </h2>
          <p className="text-xs text-slate-600">
            Objectifs et valeurs de référence&nbsp;:{" "}
            <Link href="/parametres#objectifs" className="font-medium text-brand-700 underline underline-offset-2">
              Paramètres
            </Link>
          </p>
        </div>
        {/* Above the charts: they mix the same days as the table. */}
        {mixedDistanceSources(period) ? (
          <p role="note" className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Cette période mélange des tournées calculées avec les distances routières et avec l&apos;estimation à vol d&apos;oiseau
            (indiqué sous chaque jour du détail)&nbsp;: leurs kilomètres et leurs durées ne se comparent pas d&apos;un jour à l&apos;autre.
          </p>
        ) : null}
        <KpiCharts
          points={points}
          period={period}
          granularity={range.granularity}
          focusDate={realized?.date ?? planned?.date ?? null}
          toleranceMin={options.lateToleranceMin}
          targets={targets}
          scoped={scoped}
        />
      </section>

      <section aria-labelledby="table-title" className="mb-8">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="table-title" className="text-base font-semibold text-slate-900">
            {range.granularity === "day" ? "Détail par jour" : range.granularity === "week" ? "Détail par semaine" : "Détail par mois"}
          </h2>
          <p className="text-xs text-slate-600">
            {range.granularity === "day" ? "Cliquez sur un jour pour l'afficher en tête de page." : "Cliquez sur une période pour voir ses jours."}
          </p>
        </div>
        {range.granularity === "day" ? (
          <KpiTable
            days={days}
            period={period}
            highlighted={[realized?.date, planned?.date].filter((d): d is string => Boolean(d))}
            base={base}
            tolerance={query.tolerance}
            today={today}
            tomorrow={tomorrow}
          />
        ) : (
          <TrendTable points={points} period={period} granularity={range.granularity} base={base} />
        )}
      </section>
    </>
  );
}

/** « Flotte »: use of the vehicles, then energy, odometers and deadlines by energy and depot (KPI-10). */
async function FleetTab({ dashboard }: { dashboard: Dashboard }) {
  const { refs, scope, data, range, today, period } = dashboard;
  const vehicles = refs.vehicles.filter((v) => inScope(scope, v.depotId, v.type) && (v.active || data.routes.some((r) => r.vehicleId === v.id)));
  const inputs = await loadFleetEnergyInputs(range, vehicles.map((v) => v.id));
  const offRoad = new Map<string, number>();
  const usedOn = new Map<string, Set<string>>();
  for (const route of data.routes) if (route.stopCount > 0) usedOn.set(route.serviceDate, (usedOn.get(route.serviceDate) ?? new Set()).add(route.vehicleId));
  for (const day of data.fleet ?? []) {
    for (const id of day.unavailable) if (!usedOn.get(day.serviceDate)?.has(id)) offRoad.set(id, (offRoad.get(id) ?? 0) + 1);
  }
  const figures = vehicles.map((vehicle) =>
    vehicleEnergy(vehicle, {
      from: range.from,
      to: range.to < today ? range.to : today,
      today,
      fills: inputs.fills.get(vehicle.id) ?? [],
      plannedKm: inputs.routeKm.get(vehicle.id) ?? new Map(),
      plannedSince: inputs.plannedSince,
      plannedUntil: inputs.plannedUntil,
      offRoadDays: offRoad.get(vehicle.id) ?? 0,
      deadlines: inputs.deadlines.get(vehicle.id) ?? [],
    }),
  );
  const depotOf = new Map(vehicles.map((v) => [v.id, v.depotId]));
  const depotName = new Map(refs.depots.map((d) => [d.id, d.name]));
  return (
    <>
      <FleetSection period={period} />
      <EnergySection
        byEnergy={groupEnergy(figures, (v) => v.energy ?? "NONE")}
        byDepot={groupEnergy(figures, (v) => depotOf.get(v.vehicleId) ?? "")}
        total={sumEnergy(figures)}
        depotName={(id) => depotName.get(id) ?? "Dépôt inconnu"}
      />
    </>
  );
}

/** « Attentes »: the shared sessions over the limit are listed with initials only, and their read is traced. */
async function WaitsTab({ dashboard, user }: { dashboard: Dashboard; user: User }) {
  const { period, options, range } = dashboard;
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
  const rows: WaitCaseRow[] = cases.map((c) => ({ ...c, initials: initials.get(c.patientId) ?? "—" }));
  return <WaitsSection period={period} options={options} cases={rows} />;
}

/** « Ventilation »: by depot, type, vehicle or person (KPI-02). */
async function BreakdownTab({ dashboard, query, base }: { dashboard: Dashboard; query: DashboardQuery; base: HrefState }) {
  const lines = dashboardLines(dashboard);
  // Like the period's fleet: the days with planning only (a Sunday would read « every vehicle idle »).
  const planned = new Set(dashboard.days.filter(hasPlanning).map((d) => d.date));
  const people = query.axis === "chauffeur" ? await loadPeople(lines.flatMap((l) => [l.driverId, l.crewMateId].filter((id): id is string => id !== null))) : [];
  return (
    <BreakdownSection
      axis={query.axis}
      sort={query.sort}
      base={base}
      lines={lines}
      fleet={(dashboard.data.fleet ?? []).filter((day) => planned.has(day.serviceDate))}
      plans={dashboard.data.plans ?? []}
      dates={dashboard.days.map((d) => d.date)}
      today={dashboard.today}
      scope={dashboard.scope}
      vehicles={dashboard.refs.vehicles}
      depots={dashboard.refs.depots}
      people={people}
    />
  );
}

function ExceptionalAmbulance({ count }: { count: number }) {
  return (
    <p
      role="note"
      className={
        count > 0
          ? "mb-8 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          : "mb-8 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700"
      }
    >
      <span className="font-medium">Recours exceptionnel à une ambulance pour un transport assis</span> (facturé au tarif VSL, protocole
      du 24 septembre 2025)&nbsp;:{" "}
      {count > 0 ? `${plural(count, "course servie", "courses servies")} sur la période, à garder exceptionnel.` : "aucun sur la période."}
    </p>
  );
}

function MethodCard({ dashboard }: { dashboard: Dashboard }) {
  return (
    <Card>
      <CardHeader title="Méthode" />
      <CardBody className="space-y-2 text-sm text-slate-700">
        <p>
          <strong className="font-medium text-slate-900">Toutes les courses</strong> de chaque date sont lues, servies ou non. Une{" "}
          <strong className="font-medium text-slate-900">course servie</strong> est placée dans une tournée et n&apos;est ni annulée ni
          absente&#x202F;; elle est <strong className="font-medium text-slate-900">réalisée</strong> quand l&apos;équipage l&apos;a marquée
          «&#x202F;déposé&#x202F;». Les taux d&apos;une période, d&apos;une semaine ou d&apos;un mois sont recalculés à partir des totaux (et non en
          moyennant les taux journaliers)&#x202F;; la moyenne glissante reprend les 7 derniers jours ouvrés (jours avec des tournées) de
          la même façon.
        </p>
        <p>
          <strong className="font-medium text-slate-900">Prévu, servi, réalisé</strong>&nbsp;: le prévu est le plan tel que validé, figé à
          la validation (une validation le jour même ne remplace pas celle de la veille)&#x202F;; le servi, les tournées après les
          absences et les annulations du jour&#x202F;; le réalisé, les courses déposées. Le CA servi et réalisé est la somme des courses
          (une course dont le patient était absent n&apos;y est plus), au prix du dernier calcul.
        </p>
        <p>
          Km et coût sont ceux calculés par l&apos;optimiseur pour chaque tournée (distances routières, ou estimation à vol d&apos;oiseau
          quand le calcul routier n&apos;est pas disponible). Un patient est en retard quand la dépose est saisie{" "}
          {lateThreshold(dashboard.options.lateToleranceMin)} (tolérance réglable). Filtré sur un dépôt ou un type, le tableau de bord lit
          les tournées de ses véhicules et les courses qu&apos;elles portent&nbsp;; la demande non servie, qui n&apos;appartient à aucun
          véhicule, se lit sans filtre.
        </p>
        <p>
          La flotte de chaque jour est lue sur les équipages du jour (fixés par le régulateur, sinon proposés), avec la flotte et le
          personnel d&apos;aujourd&apos;hui&nbsp;: un véhicule ou une personne désactivés depuis ne comptent plus, et un véhicule compte dans
          son dépôt actuel. «&#x202F;—&#x202F;» signale une valeur non mesurable. Les jours mis en avant sont comparés au même jour de la
          semaine précédente et aux 4 mêmes jours précédents (séries de dialyse lundi-mercredi-vendredi ou mardi-jeudi-samedi).
        </p>
      </CardBody>
    </Card>
  );
}
