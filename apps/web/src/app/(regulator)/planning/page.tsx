import type { Metadata } from "next";
import { Suspense } from "react";
import { CalendarPlus, ListChecks } from "lucide-react";
import { auditRead } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/ui/layout";
import { AvailabilityNotes } from "@/components/planning/availability-notes";
import { KpiStrip } from "@/components/planning/kpi-strip";
import { RunBanner } from "@/components/planning/run-banner";
import { TariffGapBanner } from "@/components/planning/tariff-gap-banner";
import { formatDayMonth, formatInstant, pluralize } from "@/lib/planning/format";
import { loadPlanningDay } from "@/lib/planning/load";
import type { PlanningDayView } from "@/lib/planning/types";
import { loadDayVersion } from "@/lib/planning/version";
import { formatLongDate, isIsoDate, todayIso, tomorrowIso } from "@/lib/time";
import { currentHorizon, inHorizon } from "@/lib/trips/completion";
import { loadRecurrencesWithoutTrip } from "@/lib/trips/missing-load";
import { MissingRecurrencesNote } from "@/components/trips/missing-recurrences";
import { TripCompletion } from "@/components/trips/trip-completion";
import { DateNav } from "./date-nav";
import { OptimizerStatus, OptimizerStatusPending } from "./optimizer-status";
import { OptimizeHint } from "./optimize-hint";
import { PendingPlanBanner, RestorePlanButton } from "./pending-plan";
import { PlanningActivityBanner, PlanningActivityProvider } from "./planning-activity";
import { PlanningBoard } from "./planning-board";
import { PlanningToolbar } from "./planning-toolbar";
import { PlanningVersionWatcher } from "./version-watcher";

export const metadata: Metadata = { title: "Planning J+1" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** A computation of the date running now (not one interrupted by a restart), said for the disabled buttons. */
function runningReasonOf(view: PlanningDayView): string | null {
  const run = view.lastRun;
  if (!run || run.status !== "RUNNING" || run.interrupted) return null;
  return `Une optimisation de cette date est en cours (lancée le ${formatInstant(run.startedAt)}${run.requestedBy ? ` par ${run.requestedBy}` : ""}) : attendez la fin du calcul.`;
}

/** Why the routes of the day cannot be recomputed (mirrors replanBlocker on the server). */
function replanBlockedReason(view: PlanningDayView, past: boolean): string | null {
  if (past) return "Date passée : le planning n'est plus modifiable.";
  if (view.dayStatus === "VALIDATED" || view.dayStatus === "MIXED") return "Planning validé : rouvrez-le pour le modifier.";
  if (view.dayStarted) return "Journée commencée : la réoptimisation en cours de journée n'est pas disponible.";
  return null;
}

function headerDescription(view: PlanningDayView, availableVehicles: number): string {
  const vehicles = pluralize(availableVehicles, "véhicule disponible", "véhicules disponibles");
  switch (view.dayStatus) {
    case "EMPTY":
      return `Aucune course ce jour · ${vehicles}.`;
    case "UNPLANNED":
      return `${pluralize(view.kpis.tripsTotal, "course")} à planifier · ${vehicles}.`;
    case "VALIDATED": {
      const validatedAt = view.vehicles.find((v) => v.route?.validatedAt)?.route?.validatedAt;
      return validatedAt
        ? `Planning validé le ${formatInstant(validatedAt)}. Rouvrez-le pour l'ajuster.`
        : "Planning validé. Rouvrez-le pour l'ajuster.";
    }
    default:
      return "Tournées proposées par l'optimiseur : ajustez, figez, réoptimisez puis validez.";
  }
}

export default async function PlanningPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser("REGULATOR");
  const params = await searchParams;
  const today = todayIso();
  const tomorrow = tomorrowIso();
  const requested = firstParam(params.date);
  const date = isIsoDate(requested) ? requested : tomorrow;
  const requestedTrip = firstParam(params.trip) ?? null;

  // Read before the plan: a change made between the two reads makes the version older than the plan shown,
  // so an action on this page is refused (never the other way round).
  const shownVersion = await loadDayVersion(db, date);
  const [view, horizon, missing] = await Promise.all([
    loadPlanningDay(date),
    // Read only: the trips of a date of the horizon are completed by <TripCompletion> once the page is shown.
    currentHorizon(db, today),
    date >= today ? loadRecurrencesWithoutTrip(date) : Promise.resolve([]),
    // The day's patients and stop addresses are on screen (timeline, map, trip panel).
    auditRead(user, { action: "plan.view", entity: "Route", entityId: null, serviceDate: date }),
  ]);
  const completing = inHorizon(date, horizon);

  const past = date < today;
  const hasRoutes = view.vehicles.some((v) => v.route !== null);
  const availableVehicles = view.vehicles.filter((v) => v.available).length;
  const replanBlocked = replanBlockedReason(view, past);
  const runningReason = runningReasonOf(view);
  const optimizeBlocked = replanBlocked ?? (view.kpis.tripsTotal === 0 ? "Aucune course à planifier ce jour." : null);
  const optimizeLabel = hasRoutes ? "Réoptimiser" : date === tomorrow ? "Optimiser demain" : `Optimiser le ${formatDayMonth(date)}`;
  const relativeDay = date === today ? "Aujourd'hui" : date === tomorrow ? "J+1" : null;
  const initialTripId = requestedTrip && view.trips.some((t) => t.id === requestedTrip) ? requestedTrip : null;

  return (
    // Keyed by date: an action's progress or result never shows on another date.
    <PlanningActivityProvider key={date} timeLimitSec={view.timeLimitSec}>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span>Planning du {formatLongDate(date)}</span>
            {relativeDay ? <Badge tone="brand">{relativeDay}</Badge> : null}
            {view.dayStatus === "VALIDATED" ? <Badge tone="success">Validé</Badge> : null}
            {view.dayStatus === "PROPOSED" ? <Badge tone="info">Proposé</Badge> : null}
            {view.dayStatus === "MIXED" ? <Badge tone="warning">Partiellement validé</Badge> : null}
          </span>
        }
        description={headerDescription(view, availableVehicles)}
        actions={
          <>
            <DateNav date={date} tomorrow={tomorrow} />
            <LinkButton href={`/equipages?date=${date}`} variant="ghost" title="Équipages de ce jour : absences, remplaçants, équipages fixés">
              Équipages
            </LinkButton>
            <PlanningToolbar
              date={date}
              version={shownVersion.version}
              optimizeLabel={optimizeLabel}
              optimizeBlocked={optimizeBlocked}
              runningReason={runningReason}
              canValidate={!past && (view.dayStatus === "PROPOSED" || view.dayStatus === "MIXED")}
              canReopen={!past && (view.dayStatus === "VALIDATED" || view.dayStatus === "MIXED")}
            />
          </>
        }
      />

      <div className="space-y-4">
        <PlanningActivityBanner />
        {completing ? <TripCompletion key={date} date={date} /> : null}
        <PlanningVersionWatcher key={`${shownVersion.version}/${shownVersion.run ?? ""}`} date={date} shown={shownVersion} />
        <Suspense fallback={<OptimizerStatusPending />}>
          <OptimizerStatus />
        </Suspense>
        {view.lastRun?.pending && !past ? (
          // Keyed by run: a new plan waiting for confirmation takes the focus again.
          <PendingPlanBanner key={view.lastRun.id} run={{ ...view.lastRun, pending: view.lastRun.pending }} />
        ) : null}
        <RunBanner
          lastRun={view.lastRun}
          planRun={view.planRun}
          restore={
            view.planRun?.previous && hasRoutes && !past && view.dayStatus === "PROPOSED" && !view.dayStarted ? (
              <RestorePlanButton
                date={date}
                version={shownVersion.version}
                previous={view.planRun.previous}
                blocked={runningReason}
              />
            ) : null
          }
        />
        {view.dayStatus !== "EMPTY" && !past ? <TariffGapBanner gaps={view.tariffGaps} date={date} /> : null}
        {!past && view.dayStatus !== "VALIDATED" ? <MissingRecurrencesNote missing={missing} completing={completing} /> : null}

        {view.dayStatus === "EMPTY" ? (
          <>
            <AvailabilityNotes skipped={view.skippedVehicles} notes={view.notes} />
            <EmptyState
              title={`Aucune course le ${formatLongDate(date)}`}
              action={
                <LinkButton href={`/courses?date=${date}`} variant="primary">
                  <CalendarPlus aria-hidden className="size-4" />
                  {completing ? "Voir ou saisir les courses" : "Générer ou saisir les courses"}
                </LinkButton>
              }
            >
              {completing
                ? "Aucune récurrence (dialyse, chimiothérapie…) ne prévoit de course ce jour : les courses régulières sont créées d'office sur les prochains jours. Saisissez une course ponctuelle si besoin."
                : "Les courses régulières sont créées d'office sur les prochains jours ; pour cette date, générez-les depuis la page Courses, puis revenez lancer l'optimisation."}
            </EmptyState>
          </>
        ) : (
          <>
            {hasRoutes ? (
              <KpiStrip kpis={view.kpis} availableVehicles={availableVehicles} />
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
                <p>
                  <span className="font-semibold">{pluralize(view.kpis.tripsTotal, "course")} à planifier</span> avec{" "}
                  {pluralize(availableVehicles, "véhicule disponible", "véhicules disponibles")}.{" "}
                  {optimizeBlocked ?? runningReason ?? <OptimizeHint label={optimizeLabel} />}
                </p>
                <LinkButton href={`/courses?date=${date}`} size="sm">
                  <ListChecks aria-hidden className="size-4" />
                  Voir les courses
                </LinkButton>
              </div>
            )}
            <AvailabilityNotes skipped={view.skippedVehicles} notes={view.notes} />
            <PlanningBoard
              key={date}
              date={date}
              vehicles={view.vehicles}
              trips={view.trips}
              unassigned={view.unassigned}
              violations={view.violations}
              violationsKnown={view.violationsKnown}
              staleTrips={view.staleTrips}
              vehicleIssues={view.vehicleIssues}
              droppedLocks={view.droppedLocks}
              timeRange={view.timeRange}
              planned={hasRoutes}
              replanBlocked={replanBlocked ?? runningReason}
              lockBlocked={past ? "Date passée : les verrous ne servent plus." : null}
              initialTripId={initialTripId}
            />
          </>
        )}
      </div>
    </PlanningActivityProvider>
  );
}
