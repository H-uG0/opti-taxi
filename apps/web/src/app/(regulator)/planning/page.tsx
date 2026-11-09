import type { Metadata } from "next";
import { Suspense } from "react";
import { CalendarPlus, ListChecks } from "lucide-react";
import { auditRead } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
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
import { formatLongDate, isIsoDate, todayIso, tomorrowIso } from "@/lib/time";
import { DateNav } from "./date-nav";
import { OptimizerStatus, OptimizerStatusPending } from "./optimizer-status";
import { PlanningActivityBanner, PlanningActivityProvider } from "./planning-activity";
import { PlanningBoard } from "./planning-board";
import { PlanningToolbar } from "./planning-toolbar";

export const metadata: Metadata = { title: "Planning J+1" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
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

  const [view] = await Promise.all([
    loadPlanningDay(date),
    // The day's patients and stop addresses are on screen (timeline, map, trip panel).
    auditRead(user, { action: "plan.view", entity: "Route", entityId: null, serviceDate: date }),
  ]);

  const past = date < today;
  const hasRoutes = view.vehicles.some((v) => v.route !== null);
  const availableVehicles = view.vehicles.filter((v) => v.available).length;
  const replanBlocked = replanBlockedReason(view, past);
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
              optimizeLabel={optimizeLabel}
              optimizeBlocked={optimizeBlocked}
              canValidate={!past && (view.dayStatus === "PROPOSED" || view.dayStatus === "MIXED")}
              canReopen={!past && (view.dayStatus === "VALIDATED" || view.dayStatus === "MIXED")}
            />
          </>
        }
      />

      <div className="space-y-4">
        <PlanningActivityBanner />
        <Suspense fallback={<OptimizerStatusPending />}>
          <OptimizerStatus />
        </Suspense>
        <RunBanner lastRun={view.lastRun} planRun={view.planRun} />
        {view.dayStatus !== "EMPTY" && !past ? <TariffGapBanner gaps={view.tariffGaps} date={date} /> : null}

        {view.dayStatus === "EMPTY" ? (
          <>
            <AvailabilityNotes skipped={view.skippedVehicles} notes={view.notes} />
            <EmptyState
              title={`Aucune course le ${formatLongDate(date)}`}
              action={
                <LinkButton href={`/courses?date=${date}`} variant="primary">
                  <CalendarPlus aria-hidden className="size-4" />
                  Générer ou saisir les courses
                </LinkButton>
              }
            >
              Les courses régulières se génèrent à partir des récurrences (dialyse, chimiothérapie…) depuis la page
              Courses ; revenez ensuite ici pour lancer l&apos;optimisation.
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
                  {optimizeBlocked ? optimizeBlocked : `Lancez « ${optimizeLabel} » pour obtenir les tournées.`}
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
              droppedLocks={view.droppedLocks}
              timeRange={view.timeRange}
              planned={hasRoutes}
              replanBlocked={replanBlocked}
              lockBlocked={past ? "Date passée : les verrous ne servent plus." : null}
              initialTripId={initialTripId}
            />
          </>
        )}
      </div>
    </PlanningActivityProvider>
  );
}
