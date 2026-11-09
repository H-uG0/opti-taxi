"use client";

import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import { ExternalLink, Lock, LockOpen, MoveRight, UserX, X } from "lucide-react";
import { Badge, VehicleTypeBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/form";
import { Card } from "@/components/ui/layout";
import { OUTBOUND_NO_SHOW_ADVICE, OUTBOUND_NO_SHOW_LABEL } from "@/lib/domain/no-show";
import { fieldRecordLabel, fieldRecordText, sharingAnswerText } from "@/lib/planning/format";
import type { TripView, VehicleRowView, ViolationView } from "@/lib/planning/types";
import {
  DIRECTION_LABELS,
  formatEuros,
  formatKm,
  PAYER_LABELS,
  SHARING_STATUS_LABELS,
  TRIP_STATUS_LABELS,
} from "@/lib/labels";
import { formatDuration, formatMinute } from "@/lib/time";
import { lockTrip, moveTrip, unlockTrip } from "./actions";
import { usePlanningActivity } from "./planning-activity";

export type TripPanelProps = {
  trip: TripView;
  trips: Record<string, TripView>;
  vehicles: VehicleRowView[];
  violations: ViolationView[];
  date: string;
  /** Why the day cannot be re-optimized (validated, past, started), or null. */
  replanBlocked: string | null;
  /** Why locks cannot change (past date), or null. */
  lockBlocked: string | null;
  onSelectTrip: (tripId: string) => void;
  onClose: () => void;
};

const SHARING_TONES = {
  NOT_ELIGIBLE: "neutral",
  NOT_PROPOSED: "neutral",
  PROPOSED: "info",
  ACCEPTED: "success",
  REFUSED: "danger",
} as const;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-2 py-1">
      <dt className="text-slate-500">{label}</dt>
      <dd className="min-w-0 text-slate-900">{children}</dd>
    </div>
  );
}

export function TripPanel({
  trip,
  trips,
  vehicles,
  violations,
  date,
  replanBlocked,
  lockBlocked,
  onSelectTrip,
  onClose,
}: TripPanelProps) {
  const { busy, run, optimizerOffline } = usePlanningActivity();
  const selectId = useId();
  const [target, setTarget] = useState("");

  const vehicleById = new Map(vehicles.map((v) => [v.id, v]));
  const current = trip.vehicleId ? vehicleById.get(trip.vehicleId) : undefined;
  const locked = trip.lockedVehicleId ? vehicleById.get(trip.lockedVehicleId) : undefined;
  const cancelled = trip.status === "CANCELLED" || trip.status === "NO_SHOW";
  const inField = trip.status === "PICKED_UP" || trip.status === "DROPPED_OFF";
  const options = vehicles.filter(
    (v) => v.available && v.id !== trip.vehicleId && trip.allowedVehicleTypes.includes(v.type),
  );
  const targetValid = options.some((v) => v.id === target);
  const moveBlocked = cancelled
    ? "Course annulée."
    : inField
      ? "Course déjà commencée."
      : (replanBlocked ?? optimizerOffline);
  const outbound = trip.direction === "OUTBOUND";
  const sharingAnswerLine = trip.sharingAnswer ? sharingAnswerText(trip.sharingAnswer, trip.sharingStatus) : null;

  return (
    <Card aria-labelledby="trip-panel-title">
      <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div className="min-w-0">
          <h2 id="trip-panel-title" className="truncate text-base font-semibold text-slate-900">
            {trip.patientName}
          </h2>
          <p className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge tone="brand">{DIRECTION_LABELS[trip.direction]}</Badge>
            <Badge tone={cancelled ? "danger" : trip.vehicleId ? "success" : "warning"}>{TRIP_STATUS_LABELS[trip.status]}</Badge>
            {trip.payer === "PRIVATE" ? <Badge>{PAYER_LABELS.PRIVATE}</Badge> : null}
            {trip.allowedVehicleTypes.map((t) => (
              <VehicleTypeBadge key={t} type={t} />
            ))}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="-m-1 rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-brand-600"
          aria-label="Fermer le détail de la course"
        >
          <X aria-hidden className="size-4" />
        </button>
      </div>

      {trip.outboundNoShow ? (
        <div role="note" className="flex items-start gap-2 border-b border-red-200 bg-red-50 px-4 py-2.5 text-red-900">
          <UserX aria-hidden className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-semibold">{OUTBOUND_NO_SHOW_LABEL}</p>
            <p className="text-xs text-red-800">{OUTBOUND_NO_SHOW_ADVICE}</p>
            <Link
              href={`/courses?${new URLSearchParams({ date, sens: "RETURN", q: trip.patientName }).toString()}`}
              className="inline-flex items-center gap-1 text-xs font-medium underline underline-offset-2"
            >
              Téléphone du patient et annulation dans Courses
              <ExternalLink aria-hidden className="size-3" />
            </Link>
          </div>
        </div>
      ) : null}

      <dl className="divide-y divide-slate-100 px-4 py-2 text-sm">
        <div className="pb-1">
          <Row label="Prise en charge">{trip.pickupAddress}</Row>
          <Row label="Dépose">{trip.dropoffAddress}</Row>
          {trip.facilityName ? <Row label="Établissement">{trip.facilityName}</Row> : null}
        </div>
        <div className="py-1">
          <Row label={outbound ? "Rendez-vous" : "Fin de séance"}>
            <span className="tabular font-medium">{formatMinute(outbound ? trip.appointmentMinute : trip.readyMinute)}</span>
          </Row>
          <Row label="Prise en charge prévue">
            <span className="tabular">{formatMinute(trip.plannedPickupMinute)}</span>
          </Row>
          <Row label="Dépose prévue">
            <span className="tabular">{formatMinute(trip.plannedDropoffMinute)}</span>
          </Row>
          {trip.fieldRecords.map((record) => (
            <Row key={record.stopId} label={fieldRecordLabel(record.kind, trip.status)}>
              <span className="tabular">{fieldRecordText(record, date)}</span>
            </Row>
          ))}
          <Row label="Attente sur place">
            <span className="tabular">
              {trip.waitAtFacilityMin === null ? "—" : formatDuration(trip.waitAtFacilityMin)}
            </span>
            <span className="text-slate-500"> {outbound ? "avant le RDV" : "après la séance"}</span>
          </Row>
        </div>
        <div className="py-1">
          <Row label="Partage">
            {trip.coPassengerTripIds.length > 0 ? (
              <span className="flex flex-wrap gap-1">
                {trip.coPassengerTripIds.map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => onSelectTrip(id)}
                    className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-xs text-amber-900 hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-brand-600"
                  >
                    {trips[id]?.patientName ?? "Course"}
                  </button>
                ))}
              </span>
            ) : (
              <span className="text-slate-600">
                {trip.sharingAllowed ? "Non partagée (partage autorisé)" : "Non autorisé par la prescription"}
              </span>
            )}
          </Row>
          <Row label="Statut du partage">
            <span className="flex flex-wrap items-center gap-2">
              <Badge tone={SHARING_TONES[trip.sharingStatus]}>{SHARING_STATUS_LABELS[trip.sharingStatus]}</Badge>
              <Link
                href={`/courses?date=${date}`}
                className="inline-flex items-center gap-1 text-xs text-brand-700 underline-offset-2 hover:underline"
              >
                Accord du patient
                <ExternalLink aria-hidden className="size-3" />
              </Link>
            </span>
            {sharingAnswerLine ? <span className="mt-0.5 block text-xs text-slate-500">{sharingAnswerLine}</span> : null}
          </Row>
          {trip.shared ? (
            <Row label="Détour">
              <span className="tabular">{formatKm(trip.detourKm)}</span>
            </Row>
          ) : null}
          <Row label="Distance directe">
            <span className="tabular">{formatKm(trip.directKm)}</span>
          </Row>
          <Row label="CA estimé">
            <span className="tabular font-medium">{formatEuros(trip.estimatedRevenue)}</span>
          </Row>
        </div>

        {violations.length > 0 ? (
          <div className="py-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-red-700">Violations</p>
            <ul className="mt-1 space-y-1">
              {violations.map((v, i) => (
                <li key={i} className="text-sm text-red-800">
                  <span className="font-medium">{v.label}</span> — {v.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </dl>

      <div className="space-y-3 border-t border-slate-200 bg-slate-50/60 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <p className="min-w-0 text-slate-700">
            {current ? (
              <>
                Sur <span className="font-medium text-slate-900">{current.label}</span>
              </>
            ) : (
              <span className="text-amber-800">Non affectée</span>
            )}
            {locked ? (
              <span className="ml-1.5 inline-flex items-center gap-1 text-xs font-medium text-slate-700">
                <Lock aria-hidden className="size-3" /> figée sur {locked.label}
              </span>
            ) : trip.lockedVehicleId ? (
              <span className="ml-1.5 text-xs text-amber-800">figée sur un véhicule indisponible</span>
            ) : null}
          </p>
          {trip.lockedVehicleId ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || lockBlocked !== null}
              onClick={() => run("Défigeage de la course…", () => unlockTrip(trip.id))}
              title={lockBlocked ?? "L'optimisation pourra de nouveau changer la course de véhicule"}
            >
              <LockOpen aria-hidden className="size-3.5" />
              Défiger
            </Button>
          ) : trip.vehicleId && !cancelled ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || lockBlocked !== null}
              onClick={() => run("Verrouillage de la course…", () => lockTrip(trip.id, trip.vehicleId ?? ""))}
              title={lockBlocked ?? "La course restera sur ce véhicule à la prochaine optimisation"}
            >
              <Lock aria-hidden className="size-3.5" />
              Figer
            </Button>
          ) : null}
        </div>

        <form
          className="space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!targetValid) return;
            const label = vehicleById.get(target)?.label ?? "";
            run(`Déplacement vers ${label} et réoptimisation…`, () => moveTrip(trip.id, target), { long: true });
            setTarget("");
          }}
        >
          <label htmlFor={selectId} className="block text-sm font-medium text-slate-700">
            Déplacer vers…
          </label>
          <div className="flex gap-2">
            <Select
              id={selectId}
              value={targetValid ? target : ""}
              onChange={(e) => setTarget(e.currentTarget.value)}
              disabled={busy || moveBlocked !== null || options.length === 0}
              className="min-w-0 flex-1"
            >
              <option value="">{options.length === 0 ? "Aucun véhicule compatible disponible" : "Choisir un véhicule"}</option>
              {options.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                  {v.route ? ` — ${v.route.tripCount} course${v.route.tripCount > 1 ? "s" : ""}` : " — libre"}
                </option>
              ))}
            </Select>
            <Button type="submit" disabled={busy || moveBlocked !== null || !targetValid}>
              <MoveRight aria-hidden className="size-4" />
              Déplacer
            </Button>
          </div>
          <p className="text-xs text-slate-500">
            {moveBlocked ??
              "La course est figée sur ce véhicule, puis le reste de la journée est réoptimisé. Si ce véhicule ne peut pas la servir, le planning reste inchangé."}
          </p>
        </form>
      </div>
    </Card>
  );
}
