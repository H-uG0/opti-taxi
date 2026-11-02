"use client";

import type { ReactNode } from "react";
import { OctagonAlert, CircleSlash, LockKeyholeOpen, RotateCcw } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/layout";
import { cn } from "@/components/ui/cn";
import type { DroppedLock } from "@/lib/optimizer/build-request";
import type { TripView, UnassignedView, ViolationView } from "@/lib/planning/types";
import { DIRECTION_LABELS } from "@/lib/labels";
import { formatMinute } from "@/lib/time";

export type IssuesPanelProps = {
  unassigned: UnassignedView[];
  violations: ViolationView[];
  violationsKnown: boolean;
  staleTrips: UnassignedView[];
  droppedLocks: DroppedLock[];
  trips: Record<string, TripView>;
  vehicleLabels: Record<string, string>;
  planned: boolean;
  selectedTripId: string | null;
  onSelectTrip: (tripId: string) => void;
  onSelectVehicle: (vehicleId: string) => void;
};

function tripTimeLabel(trip: TripView | undefined): string {
  if (!trip) return "";
  return trip.direction === "OUTBOUND"
    ? `${DIRECTION_LABELS.OUTBOUND} · RDV ${formatMinute(trip.appointmentMinute)}`
    : `${DIRECTION_LABELS.RETURN} · fin ${formatMinute(trip.readyMinute)}`;
}

function TripButton({
  tripId,
  trips,
  selected,
  onSelect,
  children,
}: {
  tripId: string;
  trips: Record<string, TripView>;
  selected: boolean;
  onSelect: (tripId: string) => void;
  children?: ReactNode;
}) {
  const trip = trips[tripId];
  return (
    <button
      type="button"
      onClick={() => onSelect(tripId)}
      aria-pressed={selected}
      className={cn(
        "block w-full rounded-md px-2 py-1.5 text-left hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-brand-600",
        selected && "bg-brand-50 hover:bg-brand-50",
      )}
    >
      <span className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm font-medium text-slate-900">{trip?.patientName ?? "Course supprimée"}</span>
        <span className="tabular shrink-0 text-xs text-slate-500">{tripTimeLabel(trip)}</span>
      </span>
      {children ? <span className="mt-0.5 block text-xs text-slate-600">{children}</span> : null}
    </button>
  );
}

function Section({ icon, title, tone, children }: { icon: ReactNode; title: string; tone: "red" | "amber" | "slate"; children: ReactNode }) {
  const tones = { red: "text-red-700", amber: "text-amber-700", slate: "text-slate-700" };
  return (
    <section className="px-2 py-2">
      <h3 className={cn("flex items-center gap-1.5 px-2 pb-1 text-xs font-semibold uppercase tracking-wide", tones[tone])}>
        {icon}
        {title}
      </h3>
      <ul className="max-h-72 space-y-0.5 overflow-y-auto">{children}</ul>
    </section>
  );
}

/** Everything the regulator should look at: unassigned trips, violations, stale or ignored locks. */
export function IssuesPanel({
  unassigned,
  violations,
  violationsKnown,
  staleTrips,
  droppedLocks,
  trips,
  vehicleLabels,
  planned,
  selectedTripId,
  onSelectTrip,
  onSelectVehicle,
}: IssuesPanelProps) {
  const count = (planned ? unassigned.length : 0) + violations.length + staleTrips.length + droppedLocks.length + (violationsKnown ? 0 : 1);

  return (
    <Card>
      <CardHeader title={planned ? `À traiter (${count})` : `Courses à planifier (${unassigned.length})`} />
      {count === 0 && planned ? (
        <p className="px-4 py-4 text-sm text-emerald-700">Toutes les courses sont affectées, sans violation.</p>
      ) : (
        <div className="divide-y divide-slate-100">
          {!violationsKnown ? (
            <p className="px-4 py-3 text-sm text-amber-800">
              Le dernier calcul signalait des violations, mais leur détail n&apos;a pas été enregistré (calcul antérieur à
              cette version) : relancez l&apos;optimisation pour les revoir.
            </p>
          ) : null}

          {violations.length > 0 ? (
            <Section icon={<OctagonAlert aria-hidden className="size-3.5" />} title={`Violations (${violations.length})`} tone="red">
              {violations.map((v, i) => (
                <li key={i} className="rounded-md px-2 py-1.5">
                  <p className="text-sm font-medium text-red-800">{v.label}</p>
                  <p className="text-xs text-slate-600">{v.message}</p>
                  <p className="mt-1 flex flex-wrap gap-1.5">
                    {v.tripId ? (
                      <button
                        type="button"
                        onClick={() => onSelectTrip(v.tripId ?? "")}
                        className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-brand-600"
                      >
                        {trips[v.tripId]?.patientName ?? "Course"}
                      </button>
                    ) : null}
                    {v.vehicleId ? (
                      <button
                        type="button"
                        onClick={() => onSelectVehicle(v.vehicleId ?? "")}
                        className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-brand-600"
                      >
                        {vehicleLabels[v.vehicleId] ?? "Véhicule"}
                      </button>
                    ) : null}
                  </p>
                </li>
              ))}
            </Section>
          ) : null}

          {unassigned.length > 0 ? (
            <Section
              icon={<CircleSlash aria-hidden className="size-3.5" />}
              title={planned ? `Non affectées (${unassigned.length})` : "En attente d'optimisation"}
              tone={planned ? "amber" : "slate"}
            >
              {unassigned.map((u) => (
                <li key={u.tripId}>
                  <TripButton tripId={u.tripId} trips={trips} selected={u.tripId === selectedTripId} onSelect={onSelectTrip}>
                    {planned ? u.reason : null}
                  </TripButton>
                </li>
              ))}
            </Section>
          ) : null}

          {staleTrips.length > 0 ? (
            <Section icon={<RotateCcw aria-hidden className="size-3.5" />} title={`À revoir (${staleTrips.length})`} tone="amber">
              {staleTrips.map((s) => (
                <li key={s.tripId}>
                  <TripButton tripId={s.tripId} trips={trips} selected={s.tripId === selectedTripId} onSelect={onSelectTrip}>
                    {s.reason}
                  </TripButton>
                </li>
              ))}
            </Section>
          ) : null}

          {droppedLocks.length > 0 ? (
            <Section icon={<LockKeyholeOpen aria-hidden className="size-3.5" />} title={`Verrous ignorés (${droppedLocks.length})`} tone="amber">
              {droppedLocks.map((d) => (
                <li key={d.tripId}>
                  <TripButton tripId={d.tripId} trips={trips} selected={d.tripId === selectedTripId} onSelect={onSelectTrip}>
                    Figée sur {d.vehicleLabel ?? "un véhicule supprimé"} : {d.reason}
                  </TripButton>
                </li>
              ))}
            </Section>
          ) : null}
        </div>
      )}
    </Card>
  );
}
