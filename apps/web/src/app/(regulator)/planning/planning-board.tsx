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
import { scopeLockCounts, scopeTripOf } from "@/lib/planning/bulk-lock";
import { displayColors, IDLE_VEHICLE_COLOR } from "@/lib/planning/colors";
import { depotChoices, depotGroupViews, filterRows, groupByDepot, isFiltering, issueVehicleIds, subsetKpis } from "@/lib/planning/filter";
import { pluralize } from "@/lib/planning/format";
import { isShortcutKey, issueTargets, nextIssueTarget } from "@/lib/planning/shortcuts";
import type { TimeRange } from "@/lib/planning/timeline";
import type { WaitWindows, ZoomLevel } from "@/lib/planning/timeline-layout";
import type { VehicleIssue } from "@/lib/planning/route-issues";
import type { DayKpis, TripView, UnassignedView, VehicleRowView, ViolationView } from "@/lib/planning/types";
import { indexViolations } from "@/lib/planning/violation-index";
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
  /** The optimizer's windows: where the « À placer » row draws a trip without a vehicle. */
  waitWindows: WaitWindows;
  planned: boolean;
  /** Indicators of the whole day (the strip shows those of the vehicles kept when a filter is on). */
  kpis: DayKpis;
  /** Shown instead of the indicators while the day has no route (« 60 courses à planifier… »). */
  unplannedNote?: ReactNode;
  replanBlocked: string | null;
  /** Why locks cannot change (past date), or null. */
  lockBlocked: string | null;
  /** Why « Où placer cette course ? » cannot place a trip now (past date, computation running), or null. */
  placeBlocked: string | null;
  initialTripId: string | null;
  /** The trip of the address (?trip=) gets its places searched at once (?placer=1: a trip just created). */
  initialPlace?: boolean;
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

/** A link seen only when it has the focus (« Passer la frise »). */
const SKIP_LINK =
  "sr-only z-40 rounded-md bg-white text-sm font-medium text-brand-800 shadow-md ring-2 ring-brand-600 focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:px-3 focus:py-2 focus:outline-none";

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
  waitWindows,
  planned,
  kpis,
  unplannedNote,
  replanBlocked,
  lockBlocked,
  placeBlocked,
  initialTripId,
  initialPlace = false,
  crewChoices,
  crewRules,
  crewChangeMode,
  crewChangeBlocked,
  version,
  className,
}: PlanningBoardProps) {
  const tripsById = useMemo(() => Object.fromEntries(trips.map((t) => [t.id, t])), [trips]);
  const vehicleLabels = useMemo(() => Object.fromEntries(vehicles.map((v) => [v.id, v.label])), [vehicles]);
  const violationIndex = useMemo(() => indexViolations(violations, tripsById), [violations, tripsById]);
  const returnsToCheck = useMemo(() => trips.filter((t) => t.outboundNoShow).map((t) => t.id), [trips]);
  const issueIds = useMemo(
    () => issueVehicleIds({ trips: tripsById, violations, vehicleIssues, staleTrips, returnsToCheck, droppedLocks }),
    [tripsById, violations, vehicleIssues, staleTrips, returnsToCheck, droppedLocks],
  );
  const depots = useMemo(() => depotChoices(vehicles), [vehicles]);
  const depotIds = useMemo(() => new Set(depots.map((d) => d.id)), [depots]);
  const { filter, setFilter, setTrip } = usePlanningFilter(depotIds);

  const [selection, setSelection] = useState<{ tripId: string | null; vehicleId: string | null }>(() => ({
    tripId: initialTripId,
    vehicleId: initialTripId ? (trips.find((t) => t.id === initialTripId)?.vehicleId ?? null) : null,
  }));
  // ?placer=1 searches the places of the trip of the address once, while it stays selected.
  const [autoPlaceTripId, setAutoPlaceTripId] = useState<string | null>(initialPlace ? initialTripId : null);
  // Once started, the request is spent: neither the panel drawn again after « Appliquer » nor a reload
  // (« Recharger ») searches again, whichever trip is selected then.
  const autoPlaceStarted = useCallback(() => {
    setAutoPlaceTripId(null);
    const current = new URLSearchParams(window.location.search);
    if (!current.has("placer")) return;
    current.delete("placer");
    const query = current.toString();
    // State null: Next.js keeps its own history state and useSearchParams in step (use-planning-filter.ts).
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }, []);
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
      setAutoPlaceTripId(null);
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

  // « N »: the next entry of « À traiter » (its trip, or its vehicle), said to screen readers.
  const [announce, setAnnounce] = useState("");
  const issues = useMemo(
    () => issueTargets({ planned, unassigned, vehicleIssues, returnsToCheck, violations, staleTrips, droppedLocks }),
    [planned, unassigned, vehicleIssues, returnsToCheck, violations, staleTrips, droppedLocks],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "n" || !isShortcutKey(e)) return;
      const next = nextIssueTarget(issues, selection);
      e.preventDefault();
      if (!next) {
        setAnnounce("Rien à traiter.");
        return;
      }
      const name =
        next.target.kind === "trip"
          ? (tripsById[next.target.id]?.patientName ?? "Course")
          : (vehicles.find((v) => v.id === next.target.id)?.label ?? "Véhicule");
      if (next.target.kind === "trip") selectTrip(next.target.id);
      else showVehicle(next.target.id);
      // Named after the panel's title: « Courses à planifier » before the first optimization.
      setAnnounce(`${planned ? "À traiter" : "Courses à planifier"}, ${next.index + 1} sur ${issues.length}\u00a0: ${name}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [issues, planned, selection, tripsById, vehicles, selectTrip, showVehicle]);

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
  const shownKpis = useMemo(
    () => (filtering ? subsetKpis(date, kept, trips, violations, violationsKnown) : kpis),
    [filtering, date, kept, trips, violations, violationsKnown, kpis],
  );
  const availableVehicles = useMemo(() => vehicles.filter((v) => v.available).length, [vehicles]);

  // Locks of a route, a depot and the day: counted by the server's rules (bulk-lock.ts) on every vehicle of the
  // scope, whatever the filter: the buttons, their confirmation and the action agree.
  const scopeTrips = useMemo(() => trips.map(scopeTripOf), [trips]);
  const lockCounts = useCallback(
    (vehicleIds: ReadonlySet<string> | null) => {
      const counts = scopeLockCounts(scopeTrips, (id) => vehicleIds === null || vehicleIds.has(id));
      return { lockable: counts.lockable, locked: counts.unlockable };
    },
    [scopeTrips],
  );
  const dayCounts = useMemo(() => lockCounts(null), [lockCounts]);

  // One color per vehicle with a route the filter keeps (timeline, map, panel), the selected vehicle shown
  // outside the filter after them: selecting it never recolors the others.
  const colors = useMemo(() => {
    // In the timeline's order (by depot): two neighbouring rows never share a color.
    const keptIds = groupByDepot(kept)
      .flatMap((g) => g.rows)
      .filter((v) => v.route !== null)
      .map((v) => v.id);
    const extra =
      highlightedVehicleId && shown.some((v) => v.id === highlightedVehicleId && v.route !== null) ? highlightedVehicleId : null;
    return displayColors(keptIds, extra);
  }, [kept, shown, highlightedVehicleId]);
  const colorOf = useCallback((v: VehicleRowView) => colors.get(v.id) ?? (v.route ? v.color : IDLE_VEHICLE_COLOR), [colors]);
  const unassignedIds = useMemo(() => (planned ? unassigned.map((u) => u.tripId) : []), [planned, unassigned]);

  // « Sélection seule »: the map keeps the selected trip, its vehicle and its co-passengers' vehicles, or the
  // selected vehicle; with nothing selected it shows what the timeline shows, the button staying on (and able to be
  // turned off) until the next selection.
  const hasSelection = selectedTrip !== null || selectedVehicle !== null;
  const selectionOnly = filter.mapSelectionOnly && hasSelection;
  const mapVehicleIds = useMemo(() => {
    if (!selectionOnly) return new Set(shown.map((v) => v.id));
    const ids = new Set<string>();
    if (highlightedVehicleId) ids.add(highlightedVehicleId);
    for (const id of selectedTrip?.coPassengerTripIds ?? []) {
      const vehicleId = tripsById[id]?.vehicleId;
      if (vehicleId) ids.add(vehicleId);
    }
    return ids;
  }, [selectionOnly, shown, highlightedVehicleId, selectedTrip, tripsById]);
  const mapVehicles = useMemo<MapVehicle[]>(
    () =>
      shown
        .filter((v) => mapVehicleIds.has(v.id))
        .map((v) => ({
          id: v.id,
          label: v.label,
          type: v.type,
          color: colorOf(v),
          depot: v.depot,
          stops: (v.route?.stops ?? []).map((s) => ({
            tripId: s.tripId,
            kind: s.kind,
            lat: s.lat,
            lng: s.lng,
            title: `${formatMinute(s.startMinute)} · ${STOP_KIND_LABELS[s.kind]} · ${tripsById[s.tripId]?.patientName ?? "Course"} (${v.label})`,
            violation: violationIndex.byTrip.has(s.tripId),
          })),
        })),
    [shown, mapVehicleIds, colorOf, tripsById, violationIndex],
  );
  // Trips of the vehicles shown and, as on the « À placer » row, the trips without a vehicle.
  const mapTrips = useMemo<MapTrip[]>(
    () =>
      trips
        .filter((t) =>
          ACTIVE(t) &&
          (selectionOnly
            ? t.id === selection.tripId || (t.vehicleId !== null && mapVehicleIds.has(t.vehicleId))
            : t.vehicleId === null || mapVehicleIds.has(t.vehicleId)),
        )
        .map((t) => ({
          id: t.id,
          title: `${t.patientName} · ${t.direction === "OUTBOUND" ? `RDV ${formatMinute(t.appointmentMinute)}` : `fin ${formatMinute(t.readyMinute)}`}`,
          pickup: t.pickup,
          dropoff: t.dropoff,
          vehicleId: t.vehicleId,
          violation: violationIndex.byTrip.has(t.id),
        })),
    [trips, selectionOnly, selection.tripId, mapVehicleIds, violationIndex],
  );
  // The map frames the vehicles kept again when the filter changes; narrowed to depots, it frames their routes
  // only (a trip without a vehicle belongs to no depot: it would pull the map away from them). Not when the
  // selection changes: the map's own selection effect frames it, except after a click on the map itself.
  const mapKey = [
    date,
    filter.depots.join(","),
    filter.types.join(","),
    filter.states.join(","),
    filter.hideFree,
    filter.mapSelectionOnly ? "sel" : "",
  ].join("|");
  const setZoom = useCallback((zoom: ZoomLevel) => setFilter({ ...filter, zoom }), [filter, setFilter]);

  const lockedLabel = selectedVehicle ? lockCounts(new Set([selectedVehicle.id])) : null;
  // « À traiter » as a state lists vehicles: say where the rest of « À traiter » is when none is left.
  const emptyText =
    filter.states.includes("issue") && unassigned.length > 0
      ? `Aucun véhicule à traiter avec ces filtres. ${pluralize(unassigned.length, "course sans véhicule reste", "courses sans véhicule restent")} dans «\u202fÀ traiter\u202f».`
      : undefined;

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

      <p aria-live="polite" className="sr-only">
        {announce}
      </p>
      <div className="grid gap-3 xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(0,1fr)_22rem] xl:grid-rows-[minmax(0,1fr)] 2xl:grid-cols-[minmax(0,1fr)_26rem]">
        <Card aria-label="Frise par véhicule" className="relative flex h-[75dvh] min-h-0 flex-col xl:h-auto">
          {/* One Tab stop for the whole timeline (arrows inside), and this link to go straight past it. */}
          <a href="#planning-panneau" className={SKIP_LINK}>
            Passer la frise
          </a>
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
            violations={violationIndex}
            colors={colors}
            unassignedTripIds={unassignedIds}
            waitWindows={waitWindows}
            onSelectTrip={selectTrip}
            onSelectVehicle={selectVehicle}
            collapsed={collapsed}
            onToggleGroup={toggleGroup}
            compact={filter.compact}
            zoom={filter.zoom}
            onZoomChange={setZoom}
            emptyText={emptyText}
            groupActions={
              planned
                ? (group) => {
                    const counts = lockCounts(new Set(vehicles.filter((v) => v.depot.id === group.id).map((v) => v.id)));
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

        <div
          id="planning-panneau"
          tabIndex={-1}
          role="region"
          aria-label="Détail et «&#x202F;À traiter&#x202F;»"
          className="flex min-h-0 flex-col gap-3 outline-none"
        >
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
                placeBlocked={placeBlocked}
                autoPlace={selectedTrip.id === autoPlaceTripId}
                onAutoPlaceStarted={autoPlaceStarted}
                onSelectTrip={selectTrip}
                onClose={clear}
              />
            ) : selectedVehicle ? (
              <VehiclePanel
                vehicle={{ ...selectedVehicle, color: colorOf(selectedVehicle) }}
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
                Cliquez sur une course de la frise ou de la carte pour la voir, la figer ou la déplacer&#x202F;; sur un véhicule pour
                suivre sa tournée. «&#x202F;/&#x202F;» pour chercher, «&#x202F;?&#x202F;» pour les raccourcis, Échap pour désélectionner.
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
          {/* With a trip or a vehicle selected, the map gives height to its panel: the actions stay in view on a
              1 280 × 800 screen whatever the banners above. */}
          <Card
            className={cn(
              "relative h-80 shrink-0",
              selectedTrip || selectedVehicle ? "xl:h-[30%] xl:min-h-32" : "xl:h-[38%] xl:min-h-44",
            )}
          >
            <PlanningMapLazy
              vehicles={mapVehicles}
              trips={mapTrips}
              selectedTripId={selectedTrip?.id ?? null}
              selectedVehicleId={highlightedVehicleId}
              onSelectTrip={selectTrip}
              onSelectVehicle={selectVehicle}
              datasetKey={mapKey}
              fitUnassigned={filter.depots.length === 0 || selectionOnly}
              selectionOnly={filter.mapSelectionOnly}
              selectionOnlyWaiting={filter.mapSelectionOnly && !hasSelection}
              onSelectionOnlyChange={
                hasSelection || filter.mapSelectionOnly ? (on) => setFilter({ ...filter, mapSelectionOnly: on }) : null
              }
              planned={planned}
            />
          </Card>
        </div>
      </div>
    </div>
  );
}
