"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MousePointerClick } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/layout";
import { PlanningMapLazy } from "@/components/map/planning-map-lazy";
import type { MapTrip, MapVehicle } from "@/components/map/planning-geojson";
import { IssuesPanel } from "@/components/planning/issues-panel";
import { Timeline, TimelineLegend } from "@/components/planning/timeline";
import { VehiclePanel } from "@/components/planning/vehicle-panel";
import type { DroppedLock } from "@/lib/optimizer/build-request";
import type { TimeRange } from "@/lib/planning/timeline";
import type { TripView, UnassignedView, VehicleRowView, ViolationView } from "@/lib/planning/types";
import { STOP_KIND_LABELS } from "@/lib/labels";
import { formatMinute } from "@/lib/time";
import { TripPanel } from "./trip-panel";

export type PlanningBoardProps = {
  date: string;
  vehicles: VehicleRowView[];
  trips: TripView[];
  unassigned: UnassignedView[];
  violations: ViolationView[];
  violationsKnown: boolean;
  staleTrips: UnassignedView[];
  droppedLocks: DroppedLock[];
  timeRange: TimeRange;
  planned: boolean;
  replanBlocked: string | null;
  initialTripId: string | null;
};

const ACTIVE = (t: TripView) => t.status !== "CANCELLED" && t.status !== "NO_SHOW";

/** Timeline + map + side panels, sharing the selected trip / vehicle. */
export function PlanningBoard({
  date,
  vehicles,
  trips,
  unassigned,
  violations,
  violationsKnown,
  staleTrips,
  droppedLocks,
  timeRange,
  planned,
  replanBlocked,
  initialTripId,
}: PlanningBoardProps) {
  const tripsById = useMemo(() => Object.fromEntries(trips.map((t) => [t.id, t])), [trips]);
  const vehicleLabels = useMemo(() => Object.fromEntries(vehicles.map((v) => [v.id, v.label])), [vehicles]);
  const violatingTripIds = useMemo(
    () => new Set(violations.map((v) => v.tripId).filter((id): id is string => id !== null)),
    [violations],
  );
  const returnsToCheck = useMemo(() => trips.filter((t) => t.outboundNoShow).map((t) => t.id), [trips]);

  const [selection, setSelection] = useState<{ tripId: string | null; vehicleId: string | null }>(() => ({
    tripId: initialTripId,
    vehicleId: initialTripId ? (trips.find((t) => t.id === initialTripId)?.vehicleId ?? null) : null,
  }));
  // After a refresh the selected trip / vehicle may be gone: treat it as unselected.
  const selectedTrip = selection.tripId ? (tripsById[selection.tripId] ?? null) : null;
  const selectedVehicle = selection.vehicleId ? (vehicles.find((v) => v.id === selection.vehicleId) ?? null) : null;
  // The highlighted vehicle follows the trip when the trip moved to another vehicle.
  const highlightedVehicleId = selectedTrip ? selectedTrip.vehicleId : (selectedVehicle?.id ?? null);

  const selectTrip = useCallback(
    (tripId: string) => setSelection({ tripId, vehicleId: tripsById[tripId]?.vehicleId ?? null }),
    [tripsById],
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

  const mapVehicles = useMemo<MapVehicle[]>(
    () =>
      vehicles.map((v) => ({
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
    [vehicles, tripsById],
  );
  const mapTrips = useMemo<MapTrip[]>(
    () =>
      trips.filter(ACTIVE).map((t) => ({
        id: t.id,
        title: `${t.patientName} · ${t.direction === "OUTBOUND" ? `RDV ${formatMinute(t.appointmentMinute)}` : `fin ${formatMinute(t.readyMinute)}`}`,
        pickup: t.pickup,
        dropoff: t.dropoff,
        vehicleId: t.vehicleId,
      })),
    [trips],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Frise par véhicule" />
        <div className="border-b border-slate-100 px-4 py-2">
          <TimelineLegend showReturnToCheck={returnsToCheck.length > 0} />
        </div>
        <Timeline
          rows={vehicles}
          trips={tripsById}
          range={timeRange}
          selectedTripId={selectedTrip?.id ?? null}
          selectedVehicleId={highlightedVehicleId}
          violatingTripIds={violatingTripIds}
          onSelectTrip={selectTrip}
          onSelectVehicle={selectVehicle}
        />
      </Card>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <Card className="h-[26rem] overflow-hidden lg:sticky lg:top-4 lg:h-[36rem]">
          <PlanningMapLazy
            vehicles={mapVehicles}
            trips={mapTrips}
            selectedTripId={selectedTrip?.id ?? null}
            selectedVehicleId={highlightedVehicleId}
            onSelectTrip={selectTrip}
            onSelectVehicle={selectVehicle}
            datasetKey={date}
          />
        </Card>

        <div className="min-w-0 space-y-4">
          {selectedTrip ? (
            <TripPanel
              key={selectedTrip.id}
              trip={selectedTrip}
              trips={tripsById}
              vehicles={vehicles}
              violations={violations.filter((v) => v.tripId === selectedTrip.id)}
              date={date}
              replanBlocked={replanBlocked}
              onSelectTrip={selectTrip}
              onClose={clear}
            />
          ) : selectedVehicle ? (
            <VehiclePanel vehicle={selectedVehicle} trips={tripsById} onSelectTrip={selectTrip} onClose={clear} />
          ) : (
            <p className="flex items-start gap-2 rounded-lg border border-dashed border-slate-300 bg-white px-4 py-3 text-sm text-slate-600">
              <MousePointerClick aria-hidden className="mt-0.5 size-4 shrink-0 text-slate-400" />
              Cliquez sur un arrêt de la frise ou de la carte pour voir la course, la figer ou la déplacer ; sur un
              véhicule pour suivre sa tournée. Échap pour désélectionner.
            </p>
          )}
          <IssuesPanel
            unassigned={unassigned}
            violations={violations}
            violationsKnown={violationsKnown}
            staleTrips={staleTrips}
            droppedLocks={droppedLocks}
            returnsToCheck={returnsToCheck}
            trips={tripsById}
            vehicleLabels={vehicleLabels}
            planned={planned}
            selectedTripId={selectedTrip?.id ?? null}
            onSelectTrip={selectTrip}
            onSelectVehicle={selectVehicle}
          />
        </div>
      </div>
    </div>
  );
}
