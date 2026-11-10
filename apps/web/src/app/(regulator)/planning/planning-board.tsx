"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MousePointerClick } from "lucide-react";
import { Card } from "@/components/ui/layout";
import { cn } from "@/components/ui/cn";
import { PlanningMapLazy } from "@/components/map/planning-map-lazy";
import type { MapTrip, MapVehicle } from "@/components/map/planning-geojson";
import { IssuesPanel } from "@/components/planning/issues-panel";
import { KpiStrip } from "@/components/planning/kpi-strip";
import { Timeline } from "@/components/planning/timeline";
import { VehiclePanel } from "@/components/planning/vehicle-panel";
import type { DroppedLock } from "@/lib/optimizer/build-request";
import {
  depotChoices,
  depotGroupViews,
  filterRows,
  isFiltering,
  issueVehicleIds,
  lockableTripCount,
  lockedTripCount,
  subsetKpis,
} from "@/lib/planning/filter";
import type { TimeRange } from "@/lib/planning/timeline";
import type { VehicleIssue } from "@/lib/planning/route-issues";
import type { DayKpis, TripView, UnassignedView, VehicleRowView, ViolationView } from "@/lib/planning/types";
import type { CrewRules } from "@/lib/staff/day-crews";
import type { CrewChoice } from "@/lib/staff/route-crew";
import { STOP_KIND_LABELS } from "@/lib/labels";
import { formatMinute } from "@/lib/time";
import { LockScopeButtons } from "./lock-scope-buttons";
import { PlanningSearch } from "./planning-search";
import { RouteCrewChange, type CrewChangeMode } from "./route-crew-form";
import { TimelineToolbar } from "./timeline-toolbar";
import { TripPanel } from "./trip-panel";
import { usePlanningFilter } from "./use-planning-filter";

export type PlanningBoardProps = {
  date: string;
  vehicles: VehicleRowView[];
  trips: TripView[];
  unassigned: UnassignedView[];
  violations: ViolationView[];
  violationsKnown: boolean;
  staleTrips: UnassignedView[];
  vehicleIssues: VehicleIssue[];
  droppedLocks: DroppedLock[];
  timeRange: TimeRange;
  planned: boolean;
  /** Indicators of the whole day (the strip shows those of the vehicles kept when a filter is on). */
  kpis: DayKpis;
  /** Shown instead of the indicators while the day has no route (« 60 courses à planifier… »). */
  unplannedNote?: ReactNode;
  replanBlocked: string | null;
  /** Why locks cannot change (past date), or null. */
  lockBlocked: string | null;
  initialTripId: string | null;
  /** « Changer l'équipage » of a route: people offered, where the change happens, what blocks it now. */
  crewChoices: CrewChoice[];
  /** Settings of the crews of the day (shared working time of an ambulance pair). */
  crewRules: Pick<CrewRules, "minPairOverlapMin">;
  crewChangeMode: CrewChangeMode;
  crewChangeBlocked: string | null;
  /** Plan version shown (actions on a stale page are refused). */
  version: string;
  className?: string;
};

const ACTIVE = (t: TripView) => t.status !== "CANCELLED" && t.status !== "NO_SHOW";

/**
 * KPI strip, then timeline (left, scrolling in its own box) beside the trip or
 * vehicle panel and the map (right): from xl the board fills the screen's
 * height, so the regulator never scrolls the page to see the panel, the map or
 * an action's result (a toast). The timeline, the KPIs and the map follow the
 * same filter, kept in the URL.
 */
export function PlanningBoard({
  date,
  vehicles,
  trips,
  unassigned,
  violations,
  violationsKnown,
  staleTrips,
  vehicleIssues,
  droppedLocks,
  timeRange,
  planned,
  kpis,
  unplannedNote,
  replanBlocked,
  lockBlocked,
  initialTripId,
  crewChoices,
  crewRules,
  crewChangeMode,
  crewChangeBlocked,
  version,
  className,
}: PlanningBoardProps) {
  const tripsById = useMemo(() => Object.fromEntries(trips.map((t) => [t.id, t])), [trips]);
  const vehicleLabels = useMemo(() => Object.fromEntries(vehicles.map((v) => [v.id, v.label])), [vehicles]);
  const violatingTripIds = useMemo(
    () => new Set(violations.map((v) => v.tripId).filter((id): id is string => id !== null)),
    [violations],
  );
  const returnsToCheck = useMemo(() => trips.filter((t) => t.outboundNoShow).map((t) => t.id), [trips]);
  const issueIds = useMemo(
    () => issueVehicleIds({ trips: tripsById, violations, vehicleIssues, staleTrips, returnsToCheck }),
    [tripsById, violations, vehicleIssues, staleTrips, returnsToCheck],
  );
  const depots = useMemo(() => depotChoices(vehicles), [vehicles]);
  const depotIds = useMemo(() => new Set(depots.map((d) => d.id)), [depots]);
  const { filter, setFilter, setTrip } = usePlanningFilter(depotIds);

  const [selection, setSelection] = useState<{ tripId: string | null; vehicleId: string | null }>(() => ({
    tripId: initialTripId,
    vehicleId: initialTripId ? (trips.find((t) => t.id === initialTripId)?.vehicleId ?? null) : null,
  }));
  // After a refresh the selected trip / vehicle may be gone: treat it as unselected.
  const selectedTrip = selection.tripId ? (tripsById[selection.tripId] ?? null) : null;
  const selectedVehicle = selection.vehicleId ? (vehicles.find((v) => v.id === selection.vehicleId) ?? null) : null;
  // The highlighted vehicle follows the trip when the trip moved to another vehicle.
  const highlightedVehicleId = useMemo(() => {
    const trip = selection.tripId ? tripsById[selection.tripId] : undefined;
    if (trip) return trip.vehicleId;
    return selection.vehicleId !== null && vehicles.some((v) => v.id === selection.vehicleId) ? selection.vehicleId : null;
  }, [selection, tripsById, vehicles]);

  // The trip selected is kept in the address (?trip=): a reload or a copied link opens it again.
  useEffect(() => setTrip(selectedTrip?.id ?? null), [selectedTrip?.id, setTrip]);

  /** A folded depot group opens when one of its vehicles gets selected from outside the timeline. */
  const reveal = useCallback(
    (vehicleId: string | null) => {
      const depotId = vehicleId ? vehicles.find((v) => v.id === vehicleId)?.depot.id : undefined;
      if (depotId && filter.collapsed.includes(depotId)) {
        setFilter({ ...filter, collapsed: filter.collapsed.filter((id) => id !== depotId) });
      }
    },
    [vehicles, filter, setFilter],
  );

  const selectTrip = useCallback(
    (tripId: string) => {
      const vehicleId = tripsById[tripId]?.vehicleId ?? null;
      setSelection({ tripId, vehicleId });
      reveal(vehicleId);
    },
    [tripsById, reveal],
  );
  const selectVehicle = useCallback(
    (vehicleId: string) =>
      setSelection((current) =>
        current.vehicleId === vehicleId && current.tripId === null
          ? { tripId: null, vehicleId: null }
          : { tripId: null, vehicleId },
      ),
    [],
  );
  /** From the search: shows the vehicle (never toggles it off). */
  const showVehicle = useCallback(
    (vehicleId: string) => {
      setSelection({ tripId: null, vehicleId });
      reveal(vehicleId);
    },
    [reveal],
  );
  const clear = useCallback(() => setSelection({ tripId: null, vehicleId: null }), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.key !== "Escape" || target?.closest("input, select, textarea, [role='alertdialog']")) return;
      clear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clear]);

  // The panel shows the new selection from its top (it scrolls in its own box).
  const panelBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = panelBox.current;
    if (!box) return;
    box.scrollTop = 0;
    // Below xl the board is a column: bring the panel into view when something is selected.
    if ((selection.tripId || selection.vehicleId) && box.getBoundingClientRect().top > window.innerHeight) {
      box.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, [selection.tripId, selection.vehicleId]);

  const filtering = isFiltering(filter);
  // Rows the filter keeps (indicators, map), plus the selected vehicle on the timeline whatever the filter.
  const kept = useMemo(() => filterRows(vehicles, filter, issueIds), [vehicles, filter, issueIds]);
  const shown = useMemo(
    () => filterRows(vehicles, filter, issueIds, highlightedVehicleId),
    [vehicles, filter, issueIds, highlightedVehicleId],
  );
  const groups = useMemo(() => depotGroupViews(date, shown, vehicles, trips, tripsById), [date, shown, vehicles, trips, tripsById]);
  const collapsed = useMemo(() => new Set(filter.collapsed), [filter.collapsed]);
  const toggleGroup = useCallback(
    (depotId: string) =>
      setFilter({
        ...filter,
        collapsed: filter.collapsed.includes(depotId) ? filter.collapsed.filter((id) => id !== depotId) : [...filter.collapsed, depotId],
      }),
    [filter, setFilter],
  );
  const shownKpis = useMemo(() => (filtering ? subsetKpis(date, kept, trips, violations) : kpis), [filtering, date, kept, trips, violations, kpis]);
  const availableVehicles = useMemo(() => vehicles.filter((v) => v.available).length, [vehicles]);

  // Locks of a depot and of the day: counted on every vehicle of the scope (the server locks them all).
  const lockCounts = useCallback(
    (rows: readonly VehicleRowView[]) => ({
      lockable: rows.reduce((sum, row) => sum + lockableTripCount(row, tripsById), 0),
      locked: rows.reduce((sum, row) => sum + lockedTripCount(row, tripsById), 0),
    }),
    [tripsById],
  );
  const dayCounts = useMemo(() => lockCounts(vehicles), [lockCounts, vehicles]);

  const visibleIds = useMemo(() => new Set(shown.map((v) => v.id)), [shown]);
  const mapVehicles = useMemo<MapVehicle[]>(
    () =>
      shown.map((v) => ({
        id: v.id,
        label: v.label,
        color: v.color,
        depot: v.depot,
        stops: (v.route?.stops ?? []).map((s) => ({
          tripId: s.tripId,
          kind: s.kind,
          lat: s.lat,
          lng: s.lng,
          title: `${formatMinute(s.startMinute)} · ${STOP_KIND_LABELS[s.kind]} · ${tripsById[s.tripId]?.patientName ?? "Course"} (${v.label})`,
        })),
      })),
    [shown, tripsById],
  );
  // Trips of the vehicles shown, and the trips without a vehicle unless the map is narrowed to depots
  // (an unassigned trip belongs to no depot: it would pull the map away from them).
  const showUnassigned = filter.depots.length === 0;
  const mapTrips = useMemo<MapTrip[]>(
    () =>
      trips
        .filter((t) => ACTIVE(t) && (t.vehicleId === null ? showUnassigned || t.id === selection.tripId : visibleIds.has(t.vehicleId)))
        .map((t) => ({
          id: t.id,
          title: `${t.patientName} · ${t.direction === "OUTBOUND" ? `RDV ${formatMinute(t.appointmentMinute)}` : `fin ${formatMinute(t.readyMinute)}`}`,
          pickup: t.pickup,
          dropoff: t.dropoff,
          vehicleId: t.vehicleId,
        })),
    [trips, visibleIds, showUnassigned, selection.tripId],
  );
  // The map frames the vehicles kept again when the filter changes.
  const mapKey = `${date}|${filter.depots.join(",")}|${filter.types.join(",")}|${filter.states.join(",")}|${filter.hideFree}`;

  const lockedLabel = selectedVehicle ? lockCounts([selectedVehicle]) : null;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {planned ? (
        <KpiStrip
          kpis={shownKpis}
          availableVehicles={availableVehicles}
          scope={filtering ? { vehicles: kept.length, unassignedDay: unassigned.length } : null}
        />
      ) : (
        unplannedNote
      )}

      <div className="grid gap-3 xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(0,1fr)_22rem] xl:grid-rows-[minmax(0,1fr)] 2xl:grid-cols-[minmax(0,1fr)_26rem]">
        <Card aria-label="Frise par véhicule" className="flex h-[75dvh] min-h-0 flex-col xl:h-auto">
          <TimelineToolbar
            search={<PlanningSearch trips={trips} vehicles={vehicles} onSelectTrip={selectTrip} onShowVehicle={showVehicle} />}
            filter={filter}
            onChange={setFilter}
            depots={depots}
            shown={kept.length}
            total={vehicles.length}
            showReturnToCheck={returnsToCheck.length > 0}
            dayLocks={
              <LockScopeButtons
                date={date}
                version={version}
                scope={{ kind: "day" }}
                name={null}
                lockable={dayCounts.lockable}
                locked={dayCounts.locked}
                blocked={lockBlocked}
              />
            }
          />
          <Timeline
            className="min-h-0 flex-1"
            groups={groups}
            trips={tripsById}
            range={timeRange}
            selectedTripId={selectedTrip?.id ?? null}
            selectedVehicleId={highlightedVehicleId}
            violatingTripIds={violatingTripIds}
            onSelectTrip={selectTrip}
            onSelectVehicle={selectVehicle}
            collapsed={collapsed}
            onToggleGroup={toggleGroup}
            compact={filter.compact}
            groupActions={
              planned
                ? (group) => {
                    const counts = lockCounts(vehicles.filter((v) => v.depot.id === group.id));
                    return (
                      <LockScopeButtons
                        date={date}
                        version={version}
                        scope={{ kind: "depot", depotId: group.id }}
                        name={group.label}
                        lockable={counts.lockable}
                        locked={counts.locked}
                        blocked={lockBlocked}
                        variant="icons"
                      />
                    );
                  }
                : undefined
            }
          />
        </Card>

        <div className="flex min-h-0 flex-col gap-3">
          <div ref={panelBox} className="min-w-0 space-y-3 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:overscroll-contain">
            {selectedTrip ? (
              <TripPanel
                key={selectedTrip.id}
                trip={selectedTrip}
                trips={tripsById}
                vehicles={vehicles}
                violations={violations.filter((v) => v.tripId === selectedTrip.id)}
                date={date}
                replanBlocked={replanBlocked}
                lockBlocked={lockBlocked}
                onSelectTrip={selectTrip}
                onClose={clear}
              />
            ) : selectedVehicle ? (
              <VehiclePanel
                vehicle={selectedVehicle}
                trips={tripsById}
                issues={vehicleIssues.find((issue) => issue.vehicleId === selectedVehicle.id)?.changes ?? []}
                lockAction={
                  lockedLabel ? (
                    <LockScopeButtons
                      date={date}
                      version={version}
                      scope={{ kind: "route", vehicleId: selectedVehicle.id }}
                      name={selectedVehicle.label}
                      lockable={lockedLabel.lockable}
                      locked={lockedLabel.locked}
                      blocked={lockBlocked}
                    />
                  ) : null
                }
                crewAction={
                  <RouteCrewChange
                    // Fresh selects for another vehicle, or after the route's crew changed.
                    key={`${selectedVehicle.id}/${selectedVehicle.route?.driverId ?? ""}/${selectedVehicle.route?.crewMateId ?? ""}`}
                    date={date}
                    vehicle={selectedVehicle}
                    choices={crewChoices}
                    rules={crewRules}
                    version={version}
                    mode={crewChangeMode}
                    blocked={crewChangeBlocked}
                  />
                }
                onSelectTrip={selectTrip}
                onClose={clear}
              />
            ) : (
              <p className="flex items-start gap-2 rounded-lg border border-dashed border-slate-300 bg-white px-4 py-3 text-sm text-slate-600">
                <MousePointerClick aria-hidden className="mt-0.5 size-4 shrink-0 text-slate-400" />
                Cliquez sur un arrêt de la frise ou de la carte pour voir la course, la figer ou la déplacer ; sur un
                véhicule pour suivre sa tournée. « / » pour chercher, Échap pour désélectionner.
              </p>
            )}
            <IssuesPanel
              date={date}
              unassigned={unassigned}
              violations={violations}
              violationsKnown={violationsKnown}
              staleTrips={staleTrips}
              droppedLocks={droppedLocks}
              returnsToCheck={returnsToCheck}
              vehicleIssues={vehicleIssues}
              replanBlocked={replanBlocked}
              crewChangeOnRoute={crewChangeMode === "route"}
              trips={tripsById}
              vehicleLabels={vehicleLabels}
              planned={planned}
              selectedTripId={selectedTrip?.id ?? null}
              onSelectTrip={selectTrip}
              onSelectVehicle={showVehicle}
            />
          </div>
          <Card className="h-80 shrink-0 overflow-hidden xl:h-[38%] xl:min-h-44">
            <PlanningMapLazy
              vehicles={mapVehicles}
              trips={mapTrips}
              selectedTripId={selectedTrip?.id ?? null}
              selectedVehicleId={highlightedVehicleId}
              onSelectTrip={selectTrip}
              onSelectVehicle={selectVehicle}
              datasetKey={mapKey}
            />
          </Card>
        </div>
      </div>
    </div>
  );
}
