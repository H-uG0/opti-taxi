import type { Metadata } from "next";
import { Suspense } from "react";
import { CalendarPlus, ListChecks } from "lucide-react";
import { auditRead } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Badge } from "@/components/ui/badge";
import { isSimulatedId } from "@/lib/simulated";
import { LinkButton } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/ui/layout";
import { AvailabilityNotes } from "@/components/planning/availability-notes";
import { PlanRunLine, RunBanner } from "@/components/planning/run-banner";
import { SimulatedDayBadge } from "@/components/planning/simulated-day-badge";
import { TariffGapBanner } from "@/components/planning/tariff-gap-banner";
import { FILTER_PARAMS } from "@/lib/planning/filter";
import { formatDayMonth, formatInstant, pluralize } from "@/lib/planning/format";
import { loadPlanningDay } from "@/lib/planning/load";
import type { PlanningDayView } from "@/lib/planning/types";
import { loadDayVersion } from "@/lib/planning/version";
import { formatLongDate, isIsoDate, todayIso, tomorrowIso } from "@/lib/time";
import { currentHorizon, inHorizon } from "@/lib/trips/completion";
import { loadRecurrencesWithoutTrip } from "@/lib/trips/missing-load";
import { generationStateOf, MissingRecurrencesNote } from "@/components/trips/missing-recurrences";
import type { MissingRecurrence } from "@/lib/trips/missing";
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

function headerDescription(view: PlanningDayView, availableVehicles: number): string | null {
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
      // Proposed: the board and its hint say what to do; the height goes to the timeline.
      return null;
  }
}

/**
 * Text of a day without any trip. When recurrences plan sessions that day
 * (MissingRecurrencesNote above says why they have no trip yet), it never
 * says that no recurrence does.
 */
function emptyDayText(past: boolean, missing: readonly MissingRecurrence[]): string {
  if (past) return "Journée passée : aucune course n'y a été enregistrée.";
  if (missing.length > 0) {
    const sessions = missing.length > 1 ? `${missing.length} récurrences actives prévoient des séances` : "1 récurrence active prévoit une séance";
    return `${sessions} ce jour, mais aucune course n'existe encore (voir ci-dessus). Saisissez une course ponctuelle si besoin.`;
  }
  return "Aucune récurrence (dialyse, chimiothérapie…) ne prévoit de séance ce jour. Saisissez une course ponctuelle si besoin.";
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
    // The day's patients, stop addresses, phones, access and trip notes are on screen (timeline, map, trip panel).
    auditRead(user, { action: "plan.view", entity: "Route", entityId: null, serviceDate: date }),
  ]);
  const completing = inHorizon(date, horizon);

  const past = date < today;
  const showMissing = !past && view.dayStatus !== "VALIDATED";
  const hasRoutes = view.vehicles.some((v) => v.route !== null);
  const availableVehicles = view.vehicles.filter((v) => v.available).length;
  const replanBlocked = replanBlockedReason(view, past);
  // A validated or started day keeps its routes: their crew changes on the route itself.
  const dayLocked = view.dayStatus === "VALIDATED" || view.dayStatus === "MIXED" || view.dayStarted;
  const runningReason = runningReasonOf(view);
  const optimizeBlocked = replanBlocked ?? (view.kpis.tripsTotal === 0 ? "Aucune course à planifier ce jour." : null);
  const optimizeLabel = hasRoutes ? "Réoptimiser" : date === tomorrow ? "Optimiser demain" : `Optimiser le ${formatDayMonth(date)}`;
  const relativeDay = date === today ? "Aujourd'hui" : date === tomorrow ? "J+1" : null;
  const initialTripId = requestedTrip && view.trips.some((t) => t.id === requestedTrip) ? requestedTrip : null;
  // « Placer les non affectées » places only the trips the optimizer is sent (incomplete ones never are).
  const incomplete = new Set(view.excludedTrips.map((t) => t.tripId));
  const placeable = view.unassigned.filter((u) => !incomplete.has(u.tripId)).length;

  return (
    // Keyed by date: an action's progress or result never shows on another date.
    <PlanningActivityProvider key={date} timeLimitSec={view.timeLimitSec}>
      {/* From xl (1 280 px) the page is as tall as the screen: the board below takes what the header and banners
          leave, and scrolls inside (timeline, panel), never the page (3rem: the main area's vertical padding).
          Narrower, the board's parts stack and the page scrolls. */}
      <div className="flex flex-col gap-2 xl:h-[calc(100dvh-var(--demo-banner-h)-3rem)]">
        <PageHeader
          className="mb-0"
          title={
            <span className="flex flex-wrap items-center gap-2">
              <span>Planning du {formatLongDate(date)}</span>
              {relativeDay ? <Badge tone="brand">{relativeDay}</Badge> : null}
              {view.dayStatus === "VALIDATED" ? <Badge tone="success">Validé</Badge> : null}
              {view.dayStatus === "PROPOSED" ? <Badge tone="info">Proposé</Badge> : null}
              {view.dayStatus === "MIXED" ? <Badge tone="warning">Partiellement validé</Badge> : null}
              {isSimulatedId(view.planRun?.id ?? view.lastRun?.id) ? <SimulatedDayBadge /> : null}
            </span>
          }
          description={headerDescription(view, availableVehicles)}
          actions={
            <>
              <DateNav date={date} tomorrow={tomorrow} keepParams={FILTER_PARAMS} />
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
                unassignedCount={hasRoutes && !past ? placeable : 0}
              />
            </>
          }
        />

        <PlanningActivityBanner />
        <PlanningVersionWatcher key={`${shownVersion.version}/${shownVersion.run ?? ""}`} date={date} shown={shownVersion} />
        {/* One line of context: the optimizer service, then the plan in place (when, how, what to keep in mind). */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <Suspense fallback={<OptimizerStatusPending />}>
            <OptimizerStatus />
          </Suspense>
          {view.dayStatus !== "EMPTY" ? <AvailabilityNotes skipped={view.skippedVehicles} notes={view.notes} inline /> : null}
          <PlanRunLine
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
        </div>
        {view.lastRun?.pending && !past ? (
          // Keyed by run: a new plan waiting for confirmation takes the focus again.
          <PendingPlanBanner key={view.lastRun.id} run={{ ...view.lastRun, pending: view.lastRun.pending }} />
        ) : null}
        <RunBanner lastRun={view.lastRun} planRun={view.planRun} />
        {view.dayStatus !== "EMPTY" && !past ? <TariffGapBanner gaps={view.tariffGaps} date={date} /> : null}
        {completing ? (
          <TripCompletion key={date} date={date} missing={showMissing ? missing : []} />
        ) : showMissing ? (
          <MissingRecurrencesNote missing={missing} state={generationStateOf(date, today, false)} />
        ) : null}

        {view.dayStatus === "EMPTY" ? (
          <>
            <AvailabilityNotes skipped={view.skippedVehicles} notes={view.notes} />
            <EmptyState
              title={`Aucune course le ${formatLongDate(date)}`}
              action={
                <LinkButton href={`/courses?date=${date}`} variant="primary">
                  <CalendarPlus aria-hidden className="size-4" />
                  {past
                    ? "Voir les courses"
                    : completing
                      ? "Voir ou saisir les courses"
                      : date === today
                        ? "Saisir les courses"
                        : "Générer ou saisir les courses"}
                </LinkButton>
              }
            >
              {emptyDayText(past, missing)}
            </EmptyState>
          </>
        ) : (
          <>
            <PlanningBoard
              key={date}
              className="xl:min-h-[26rem] xl:flex-1"
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
              kpis={view.kpis}
              unplannedNote={
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
              }
              replanBlocked={replanBlocked ?? runningReason}
              lockBlocked={past ? "Date passée : les verrous ne servent plus." : null}
              initialTripId={initialTripId}
              crewChoices={view.crewChoices}
              crewRules={view.crewRules}
              crewChangeMode={past ? "none" : dayLocked ? "route" : "equipages"}
              crewChangeBlocked={runningReason}
              version={shownVersion.version}
            />
          </>
        )}
      </div>
    </PlanningActivityProvider>
  );
}
