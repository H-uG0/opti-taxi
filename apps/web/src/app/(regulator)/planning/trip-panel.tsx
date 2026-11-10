"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Ambulance, ExternalLink, ListChecks, Lock, LockOpen, MoveRight, Phone, TriangleAlert, UserRound, UserX, X } from "lucide-react";
import { Badge, VehicleTypeBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/form";
import { Card } from "@/components/ui/layout";
import { OUTBOUND_NO_SHOW_ADVICE, OUTBOUND_NO_SHOW_LABEL } from "@/lib/domain/no-show";
import { exceptionalAmbulanceIssue, OPTIMIZE_FIRST_ISSUE } from "@/lib/planning/exceptional-ambulance";
import { fieldRecordLabel, fieldRecordText, sharingAnswerText } from "@/lib/planning/format";
import { coursesTripHref, patientHref, telHref } from "@/lib/planning/links";
import { isShortcutKey } from "@/lib/planning/shortcuts";
import { appointmentMark, TIGHT_MARGIN_MIN } from "@/lib/planning/timeline-layout";
import type { TripView, VehicleRowView, ViolationView } from "@/lib/planning/types";
import {
  DIRECTION_LABELS,
  formatEuros,
  formatKm,
  MOBILITY_LABELS,
  PAYER_LABELS,
  SHARING_STATUS_LABELS,
  TRIP_STATUS_LABELS,
} from "@/lib/labels";
import { formatDuration, formatMinute } from "@/lib/time";
import { lockTrip, moveTrip, proposeExceptionalAmbulance, unlockTrip } from "./actions";
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
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-2 py-1">
      <dt className="text-slate-500">{label}</dt>
      <dd className="min-w-0 wrap-break-word text-slate-900">{children}</dd>
    </div>
  );
}

function PhoneLink({ phone, label }: { phone: string; label: string }) {
  return (
    <a
      href={telHref(phone)}
      aria-label={`${label} : ${phone}`}
      className="tabular inline-flex items-center gap-1 font-medium text-brand-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600"
    >
      <Phone aria-hidden className="size-3.5" />
      {phone}
    </a>
  );
}

const MOVE_HELP =
  "La course est figée sur ce véhicule, puis le reste de la journée est réoptimisé. Si ce véhicule ne peut pas la prendre, le planning reste inchangé ; si d'autres courses perdaient leur véhicule, le nouveau planning attend votre confirmation.";

const PANEL_LINK =
  "inline-flex min-h-6 items-center gap-1 rounded text-xs font-medium text-brand-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600";

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
  const ambulanceSelectId = useId();
  const [target, setTarget] = useState("");
  const [ambulance, setAmbulance] = useState("");
  const lockButton = useRef<HTMLButtonElement>(null);
  const moveSelect = useRef<HTMLSelectElement>(null);

  // « F »: Figer / Défiger, « D »: « Déplacer vers… » (the same controls, so the same rules and confirmations).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isShortcutKey(e)) return;
      const key = e.key.toLowerCase();
      if (key === "f" && lockButton.current && !lockButton.current.disabled) {
        e.preventDefault();
        lockButton.current.click();
      } else if (key === "d" && moveSelect.current && !moveSelect.current.disabled) {
        e.preventDefault();
        moveSelect.current.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
  const mark = trip.vehicleId ? appointmentMark(trip) : null;
  // « Recours exceptionnel » (TAR-03): only for a seated trip the last optimization left without a vehicle, never
  // proposed by the optimizer itself. Before that computation, the panel says to optimize first.
  const exceptionalCandidate = { status: trip.status, payer: trip.payer, allowedVehicleTypes: trip.allowedVehicleTypes, assigned: false };
  const exceptionalEligible =
    trip.vehicleId === null && exceptionalAmbulanceIssue({ ...exceptionalCandidate, leftByOptimizer: true }) === null;
  const exceptionalOffer = exceptionalEligible && trip.leftByOptimizer === true;
  const ambulances = vehicles.filter((v) => v.available && v.type === "AMBULANCE");
  const ambulanceValid = ambulances.some((v) => v.id === ambulance);
  const sharingAnswerLine = trip.sharingAnswer ? sharingAnswerText(trip.sharingAnswer, trip.sharingStatus) : null;
  // The trip's line in Courses (patient and leg): phone, sharing answer, cancellation, toll.
  const coursesHref = coursesTripHref(date, trip.patientId, trip.direction);

  return (
    <Card aria-labelledby="trip-panel-title">
      <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div className="min-w-0">
          <h2 id="trip-panel-title" className="truncate text-base font-semibold text-slate-900">
            {trip.patientName}
          </h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3">
            <Link href={patientHref(trip.patientId)} className={PANEL_LINK}>
              <UserRound aria-hidden className="size-3.5" />
              Fiche patient
            </Link>
            <Link href={coursesHref} className={PANEL_LINK}>
              <ListChecks aria-hidden className="size-3.5" />
              Voir dans Courses
            </Link>
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge tone="brand">{DIRECTION_LABELS[trip.direction]}</Badge>
            <Badge tone={cancelled ? "danger" : trip.vehicleId ? "success" : "warning"}>{TRIP_STATUS_LABELS[trip.status]}</Badge>
            {trip.payer === "PRIVATE" ? <Badge>{PAYER_LABELS.PRIVATE}</Badge> : null}
            {trip.exceptionalAmbulance ? <Badge tone="warning">Recours exceptionnel</Badge> : null}
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
              href={coursesTripHref(date, trip.patientId, "RETURN")}
              className="inline-flex items-center gap-1 text-xs font-medium underline underline-offset-2"
            >
              Téléphone du patient et annulation dans Courses
              <ExternalLink aria-hidden className="size-3" />
            </Link>
          </div>
        </div>
      ) : null}

      {/* The trip's actions come first: the panel scrolls in a short box beside the map, and each selection shows
          it from its top (planning-board.tsx). */}
      <div aria-label="Actions sur la course" role="group" className="space-y-2.5 border-b border-slate-200 bg-slate-50/60 px-4 py-3">
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
            {trip.exceptionalAmbulance ? (
              <span className="mt-0.5 block text-xs text-slate-500">« Défiger » retire le recours exceptionnel à l&apos;ambulance.</span>
            ) : null}
          </p>
          {trip.lockedVehicleId ? (
            <Button
              ref={lockButton}
              size="sm"
              variant="secondary"
              aria-keyshortcuts="F"
              disabled={busy || lockBlocked !== null}
              onClick={() => run("Défigeage de la course…", () => unlockTrip(trip.id))}
              title={
                lockBlocked ??
                (trip.exceptionalAmbulance
                  ? "Retire le recours exceptionnel : la prochaine optimisation confiera la course à un taxi ou un VSL, ou la laissera sans véhicule"
                  : "L'optimisation pourra de nouveau changer la course de véhicule")
              }
            >
              <LockOpen aria-hidden className="size-3.5" />
              Défiger
            </Button>
          ) : trip.vehicleId && !cancelled ? (
            <Button
              ref={lockButton}
              size="sm"
              variant="secondary"
              aria-keyshortcuts="F"
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
          className="space-y-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (!targetValid) return;
            const label = vehicleById.get(target)?.label ?? "";
            run(`Déplacement vers ${label} et réoptimisation…`, () => moveTrip(trip.id, target), { long: true });
            setTarget("");
          }}
        >
          <label htmlFor={selectId} className="sr-only">
            Déplacer vers…
          </label>
          <div className="flex gap-2">
            <Select
              ref={moveSelect}
              id={selectId}
              aria-keyshortcuts="D"
              value={targetValid ? target : ""}
              onChange={(e) => setTarget(e.currentTarget.value)}
              disabled={busy || moveBlocked !== null || options.length === 0}
              className="min-w-0 flex-1"
            >
              <option value="">{options.length === 0 ? "Aucun véhicule compatible disponible" : "Déplacer vers…"}</option>
              {options.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                  {v.route ? ` — ${v.route.tripCount} course${v.route.tripCount > 1 ? "s" : ""}` : " — libre"}
                </option>
              ))}
            </Select>
            <Button type="submit" disabled={busy || moveBlocked !== null || !targetValid} title={MOVE_HELP}>
              <MoveRight aria-hidden className="size-4" />
              Déplacer
            </Button>
          </div>
          <p className="text-xs text-slate-500">{moveBlocked ?? "Fige la course sur le véhicule choisi et réoptimise le reste."}</p>
        </form>

        {exceptionalOffer ? (
          <form
            aria-labelledby={`${ambulanceSelectId}-title`}
            className="space-y-1.5 border-t border-slate-200 pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!ambulanceValid) return;
              const label = vehicleById.get(ambulance)?.label ?? "";
              run(`Recours exceptionnel à ${label} et réoptimisation…`, () => proposeExceptionalAmbulance(trip.id, ambulance), { long: true });
              setAmbulance("");
            }}
          >
            <p id={`${ambulanceSelectId}-title`} className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
              <Ambulance aria-hidden className="size-4 text-slate-500" />
              Recours exceptionnel à une ambulance
            </p>
            <p className="text-xs text-slate-500">
              Aucun taxi ni VSL ne peut la prendre ? Une ambulance peut faire ce transport assis, facturé au tarif VSL. À
              réserver aux cas sans autre solution : le motif est tracé sur la course et compté au tableau de bord.
            </p>
            <div className="flex gap-2">
              <label htmlFor={ambulanceSelectId} className="sr-only">
                Ambulance proposée
              </label>
              <Select
                id={ambulanceSelectId}
                value={ambulanceValid ? ambulance : ""}
                onChange={(e) => setAmbulance(e.currentTarget.value)}
                disabled={busy || moveBlocked !== null || ambulances.length === 0}
                className="min-w-0 flex-1"
              >
                <option value="">{ambulances.length === 0 ? "Aucune ambulance disponible ce jour" : "Choisir une ambulance"}</option>
                {ambulances.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                    {v.route ? ` — ${v.route.tripCount} course${v.route.tripCount > 1 ? "s" : ""}` : " — libre"}
                  </option>
                ))}
              </Select>
              <Button type="submit" variant="secondary" disabled={busy || moveBlocked !== null || !ambulanceValid}>
                Proposer
              </Button>
            </div>
          </form>
        ) : exceptionalEligible ? (
          <p className="flex items-start gap-1.5 border-t border-slate-200 pt-3 text-xs text-slate-500">
            <Ambulance aria-hidden className="mt-0.5 size-3.5 shrink-0 text-slate-400" />
            <span>{OPTIMIZE_FIRST_ISSUE}</span>
          </p>
        ) : null}
      </div>
      <dl className="divide-y divide-slate-100 px-4 py-2 text-sm">
        <div className="pb-1">
          <Row label="Téléphone">
            {trip.patientPhone ? (
              <PhoneLink phone={trip.patientPhone} label={`Appeler ${trip.patientName}`} />
            ) : (
              <span className="text-slate-500">Non renseigné</span>
            )}
          </Row>
          {trip.mobility ? <Row label="Mobilité">{MOBILITY_LABELS[trip.mobility]}</Row> : null}
          {trip.accessNotes ? (
            <Row label="Accès">
              <span className="whitespace-pre-line">{trip.accessNotes}</span>
            </Row>
          ) : null}
          {trip.notes ? (
            <Row label="Notes de la course">
              <span className="whitespace-pre-line">{trip.notes}</span>
            </Row>
          ) : null}
        </div>
        <div className="py-1">
          <Row label="Prise en charge">{trip.pickupAddress}</Row>
          <Row label="Dépose">{trip.dropoffAddress}</Row>
          {trip.facilityName ? (
            <Row label="Établissement">
              {trip.facilityName}
              {trip.facilityPhone ? (
                <span className="mt-0.5 block">
                  <PhoneLink phone={trip.facilityPhone} label={`Appeler ${trip.facilityName}`} />
                </span>
              ) : null}
            </Row>
          ) : null}
        </div>
        <div className="py-1">
          <Row label={outbound ? "Rendez-vous" : "Fin de séance"}>
            <span className="tabular font-medium">{formatMinute(outbound ? trip.appointmentMinute : trip.readyMinute)}</span>
            {mark?.kind === "appointment" && mark.marginMin !== null ? (
              mark.tight ? (
                <span className="mt-0.5 flex items-center gap-1 text-xs font-medium text-amber-800">
                  <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
                  {mark.marginMin < 0
                    ? `Dépose ${formatDuration(-mark.marginMin)} après le RDV`
                    : `Marge de ${formatDuration(mark.marginMin)} avant le RDV (moins de ${TIGHT_MARGIN_MIN} min)`}
                </span>
              ) : (
                <span className="text-slate-500"> · marge {formatDuration(mark.marginMin)}</span>
              )
            ) : null}
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
              <Link href={coursesHref} className="inline-flex items-center gap-1 text-xs text-brand-700 underline-offset-2 hover:underline">
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
            {trip.exceptionalAmbulance ? (
              <span className="mt-0.5 block text-xs text-slate-500">Ambulance pour un transport assis : tarif VSL.</span>
            ) : null}
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

    </Card>
  );
}
