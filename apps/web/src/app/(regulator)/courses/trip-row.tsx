"use client";

import Link from "next/link";
import { useActionState, useId, useState, type FormEvent } from "react";
import { useFormStatus } from "react-dom";
import type { Payer, SharingStatus, TripDirection, TripStatus, VehicleType } from "@prisma/client";
import { CalendarClock, Check, ChevronDown, Lock, TriangleAlert, Undo2, UserX, Users, X } from "lucide-react";
import { Badge, VEHICLE_TYPE_COLORS, VehicleTypeBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/form";
import {
  CANCELLATION_NOTE_MAX,
  CANCELLATION_REASON_LABELS,
  USER_CANCELLATION_REASONS,
  type UserCancellationReason,
} from "@/lib/domain/cancellation";
import { OUTBOUND_NO_SHOW_ADVICE, OUTBOUND_NO_SHOW_LABEL } from "@/lib/domain/no-show";
import { EXCEPTIONAL_AMBULANCE_REASON } from "@/lib/planning/exceptional-ambulance";
import { SubmitButton } from "@/components/ui/submit-button";
import { Td } from "@/components/ui/table";
import { DIRECTION_LABELS, PAYER_LABELS, SHARING_STATUS_LABELS, TRIP_STATUS_LABELS, VEHICLE_TYPE_SHORT, formatEuros, formatKm } from "@/lib/labels";
import { formatMinute } from "@/lib/time";
import { cancelTrip, recordSharingDecision, rescheduleTrip, restoreTrip, setTripToll } from "./actions";
import { UnitInput } from "../vehicules/_lib/ui";
import { submitWithoutReset } from "../patients/_components/form-submit";
import { ActionForm, ActionMessage } from "./action-form";
import { INITIAL_ACTION_RESULT } from "./trip-form";
import type { RecordTrace } from "./record-trace";
import {
  canCancel,
  canEditTime,
  canRestore,
  keyMinuteLabel,
  sharingConflict,
  sharingDecisionsFor,
  SHARING_DECISION_LABELS,
  SHARING_STATUS_TONES,
  timeFieldLabel,
  TRIP_STATUS_TONES,
  type SharingDecision,
} from "./trip-rules";

/** Serializable view of a trip for one table row (built by the page). */
export type TripRowData = {
  id: string;
  direction: TripDirection;
  status: TripStatus;
  /** Statuses recorded by the crew behind `status`, who and when ("Prise en charge enregistrée par … le …"), pickup first. */
  statusTraces: string[];
  /** Who recorded the current status and when, under its badge ("par … · 03/11 à 08:12"). */
  statusTraceShort: string | null;
  payer: Payer;
  patientName: string;
  patientPhone: string | null;
  keyMinute: number | null;
  facilityName: string | null;
  pickupAddress: string;
  dropoffAddress: string;
  allowedVehicleTypes: VehicleType[];
  /** "Assis (taxi ou VSL) · partage aller et retour", or why there is no prescription. */
  prescriptionLabel: string;
  /** Recurrence label, or null for a one-off trip. */
  origin: string | null;
  vehicleLabel: string | null;
  vehicleType: VehicleType | null;
  lockedVehicleLabel: string | null;
  /** « Recours exceptionnel à une ambulance » in force (seated trip locked on an ambulance): who proposed it and when. */
  exceptionalAmbulance?: RecordTrace | null;
  plannedPickupMinute: number | null;
  plannedDropoffMinute: number | null;
  shared: boolean;
  coPassengers: string[];
  directKm: number | null;
  detourKm: number | null;
  estimatedRevenue: number | null;
  /** Tolls on this patient's invoice (€), null when none. */
  tollAmount?: number | null;
  sharingAllowed: boolean;
  sharingStatus: SharingStatus;
  sharingProposedAt: string | null;
  /** Who recorded the patient's answer and when ("Refus enregistré par … le 03/11 à 08:12"). */
  sharingAnswer: string | null;
  /** Same, short, under the badge of an accepted or refused sharing ("par … · 03/11 à 08:12"). */
  sharingAnswerShort: string | null;
  sharingNote: string | null;
  notes: string | null;
  /** Return trip still to do whose outbound leg of the day was closed as patient absent. */
  outboundNoShow: boolean;
  /** Who recorded that absence on the outbound leg, and when (null when not traced). */
  outboundNoShowTrace: RecordTrace | null;
  /** Reason of the cancellation ("Hospitalisation · tardive"), null when not cancelled. */
  cancellation: string | null;
  /** The same without the lateness ("Hospitalisation"), for the list: lateness has its own badge. */
  cancellationReason: string | null;
  /** Cancelled late (less than N hours before the pickup). */
  lateCancellation: boolean;
  /** Who cancelled the trip and when (null when not cancelled, or not recorded). */
  cancellationTrace: RecordTrace | null;
  /** Outbound trip: the return of the same care, still open, that « Annuler » offers to cancel along. */
  pairedReturn: { id: string; keyMinute: number | null } | null;
  /** Another trip of the patient that day on the same leg, or during another session (possible duplicate). */
  conflicts: string[];
  /** The trip opened on the planning of its date (/planning?date=…&trip=…); null when the planning does not show it. */
  planningHref?: string | null;
};

export const TRIP_TABLE_COLUMNS = 9;

const PAYER_SHORT: Record<Payer, string> = { CPAM: "CPAM", PRIVATE: "Privé" };

export function TripRow({
  trip,
  selection = null,
}: {
  trip: TripRowData;
  /** The box of « Annuler la sélection », for a trip that can still be cancelled. */
  selection?: { checked: boolean; onChange: (checked: boolean) => void } | null;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const cancelled = trip.status === "CANCELLED";
  const muted = cancelled ? "opacity-55" : undefined;
  const conflict = sharingConflict(trip);
  const background = open ? "bg-brand-50/40" : selection?.checked ? "bg-amber-50/60" : undefined;
  // The pinned « Détails » cell hides what scrolls under it: an opaque background of the same tint.
  const pinnedBackground = open ? "bg-brand-50" : selection?.checked ? "bg-amber-50" : "bg-white group-hover:bg-slate-50";

  return (
    <>
      <tr className={cn("group align-top", background ?? "hover:bg-slate-50")}>
        <Td className="w-10 pr-0">
          {selection ? (
            <input
              type="checkbox"
              checked={selection.checked}
              onChange={(event) => selection.onChange(event.target.checked)}
              aria-label={`Sélectionner la course de ${trip.patientName} (${DIRECTION_LABELS[trip.direction].toLowerCase()}, ${formatMinute(trip.keyMinute)})`}
              className="mt-1 size-4 rounded border-slate-300 accent-brand-700"
            />
          ) : null}
        </Td>
        <Td className={cn("whitespace-nowrap", muted)}>
          <span className="tabular block text-base font-semibold text-slate-900">{formatMinute(trip.keyMinute)}</span>
          <span className="block text-xs text-slate-500">{keyMinuteLabel(trip.direction)}</span>
        </Td>
        <Td className={muted}>
          <span className={cn("block font-medium text-slate-900", cancelled && "line-through")}>{trip.patientName}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1">
            <Badge tone={trip.direction === "OUTBOUND" ? "brand" : "neutral"}>{DIRECTION_LABELS[trip.direction]}</Badge>
            {trip.planningHref ? (
              <Link
                href={trip.planningHref}
                aria-label={`Voir la course de ${trip.patientName} sur le planning`}
                title="Voir sur le planning"
                className="inline-grid size-6 place-items-center rounded text-brand-700 hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-brand-600"
              >
                <CalendarClock aria-hidden className="size-4" />
              </Link>
            ) : null}
            {trip.origin ? null : <span className="text-xs text-slate-500">Ponctuelle</span>}
            {/* The payer only when it is not the usual one; the full « Types · payeur » column from 1 536 px. */}
            {trip.payer === "PRIVATE" ? (
              <span className="2xl:hidden">
                <Badge tone="info">Privé</Badge>
              </span>
            ) : null}
            {trip.conflicts.length > 0 ? (
              <span title={trip.conflicts.join(" ; ")}>
                <Badge tone="warning" className="whitespace-nowrap">
                  <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
                  Doublon ?
                </Badge>
              </span>
            ) : null}
          </span>
          {trip.outboundNoShow ? (
            <>
              <span className="mt-1 flex" title={OUTBOUND_NO_SHOW_ADVICE}>
                <Badge tone="danger">
                  <UserX aria-hidden className="size-3.5 shrink-0" />
                  {OUTBOUND_NO_SHOW_LABEL}
                </Badge>
              </span>
              {trip.outboundNoShowTrace ? (
                <TraceHint full={trip.outboundNoShowTrace.full} short={trip.outboundNoShowTrace.short} />
              ) : null}
            </>
          ) : null}
        </Td>
        <Td className={cn("max-w-60", muted)}>
          <span className="block truncate font-medium text-slate-800" title={trip.facilityName ?? undefined}>
            {trip.facilityName ?? "Adresse libre"}
          </span>
          <span className="block truncate text-xs text-slate-500" title={`${trip.pickupAddress} → ${trip.dropoffAddress}`}>
            {trip.pickupAddress} → {trip.dropoffAddress}
          </span>
        </Td>
        <Td className={cn("hidden 2xl:table-cell", muted)}>
          <span className="flex flex-wrap gap-1">
            {trip.allowedVehicleTypes.map((type) => (
              <VehicleTypeBadge key={type} type={type} />
            ))}
          </span>
          <span className="mt-1 block text-xs text-slate-500">{PAYER_SHORT[trip.payer]}</span>
        </Td>
        <Td className="whitespace-nowrap">
          <span className="flex items-center gap-1">
            <Badge tone={TRIP_STATUS_TONES[trip.status]}>{TRIP_STATUS_LABELS[trip.status]}</Badge>
            {/* Its own badge: never cut off with a long reason. */}
            {trip.lateCancellation ? <Badge tone="warning">Tardive</Badge> : null}
          </span>
          {trip.statusTraceShort ? <TraceHint full={trip.statusTraces.at(-1)} short={trip.statusTraceShort} /> : null}
          {trip.cancellationReason ? (
            <TraceHint
              full={[trip.cancellation, trip.cancellationTrace?.full].filter(Boolean).join(" — ")}
              short={trip.cancellationReason}
            />
          ) : null}
        </Td>
        <Td className={cn("whitespace-nowrap", muted)}>
          <span className={cn("flex items-center gap-1", trip.vehicleLabel ? "font-medium text-slate-800" : "text-slate-500")}>
            {trip.vehicleType ? (
              <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: VEHICLE_TYPE_COLORS[trip.vehicleType] }} />
            ) : null}
            {trip.vehicleLabel ?? "Non affectée"}
            {trip.lockedVehicleLabel ? (
              <Lock role="img" aria-label={`Figée sur ${trip.lockedVehicleLabel}`} className="size-3.5 shrink-0 text-amber-600" />
            ) : null}
          </span>
          {trip.plannedPickupMinute !== null || trip.plannedDropoffMinute !== null ? (
            <span className="tabular block text-xs text-slate-500">
              PEC {formatMinute(trip.plannedPickupMinute)} · dépose {formatMinute(trip.plannedDropoffMinute)}
            </span>
          ) : null}
          {trip.exceptionalAmbulance ? (
            <span className="mt-1 flex" title={`${EXCEPTIONAL_AMBULANCE_REASON}. ${trip.exceptionalAmbulance.full}.`}>
              <Badge tone="warning">Recours exceptionnel</Badge>
            </span>
          ) : null}
        </Td>
        <Td className={cn("max-w-44", muted)}>
          <Badge tone={SHARING_STATUS_TONES[trip.sharingStatus]}>{SHARING_STATUS_LABELS[trip.sharingStatus]}</Badge>
          {trip.sharingAnswerShort ? <TraceHint full={trip.sharingAnswer ?? undefined} short={trip.sharingAnswerShort} /> : null}
          {conflict ? (
            <span className="mt-1 flex items-center gap-1 text-xs font-medium text-red-700">
              <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
              Encore partagée : à réoptimiser
            </span>
          ) : null}
          {trip.shared ? (
            <span className="mt-1 flex items-center gap-1 text-xs text-brand-800">
              <Users aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">
                {trip.coPassengers.length > 0 ? `avec ${trip.coPassengers.join(", ")}` : "Partagée"}
              </span>
            </span>
          ) : null}
        </Td>
        {/* Pinned to the right edge of the frame: « Détails » stays in reach when the table scrolls sideways. */}
        <Td className={cn("sticky right-0 text-right", pinnedBackground)}>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-controls={detailsId}
            aria-label={`Détails de la course de ${trip.patientName}`}
            onClick={() => setOpen((v) => !v)}
          >
            Détails
            <ChevronDown aria-hidden className={cn("size-4 transition-transform", open && "rotate-180")} />
          </Button>
        </Td>
      </tr>
      <tr id={detailsId} hidden={!open} className="bg-slate-50/70">
        <td colSpan={TRIP_TABLE_COLUMNS} className="px-3 pb-4 pt-1">
          {open ? <TripDetails trip={trip} /> : null}
        </td>
      </tr>
    </>
  );
}

function TripDetails({ trip }: { trip: TripRowData }) {
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      {trip.conflicts.length > 0 ? (
        <p
          role="note"
          className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-sm text-amber-950 lg:col-span-3"
        >
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            <span className="font-semibold">Doublon possible.</span> {trip.conflicts.join(" ; ")}. Vérifiez qu&apos;un seul
            véhicule ira chercher le patient ; sinon, annulez l&apos;une des courses.
          </span>
        </p>
      ) : null}
      {trip.outboundNoShow ? (
        <p
          role="note"
          className="flex items-start gap-1.5 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-sm text-red-900 lg:col-span-3"
        >
          <UserX aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            <span className="font-semibold">{OUTBOUND_NO_SHOW_LABEL}.</span>{" "}
            {trip.outboundNoShowTrace ? `${trip.outboundNoShowTrace.full}. ` : null}
            {OUTBOUND_NO_SHOW_ADVICE}
            {trip.patientPhone ? (
              <>
                {" "}
                <a href={`tel:${trip.patientPhone.replace(/\s+/g, "")}`} className="tabular font-medium underline underline-offset-2">
                  Appeler le {trip.patientPhone}
                </a>
              </>
            ) : null}
          </span>
        </p>
      ) : null}
      <Panel title="Course">
        <dl className="space-y-1.5 text-sm">
          <Detail label="Prise en charge">{trip.pickupAddress}</Detail>
          <Detail label="Dépose">{trip.dropoffAddress}</Detail>
          <Detail label="Payeur">{PAYER_LABELS[trip.payer]}</Detail>
          <Detail label="Véhicules possibles">{trip.allowedVehicleTypes.map((type) => VEHICLE_TYPE_SHORT[type]).join(", ")}</Detail>
          <Detail label="Prescription">{trip.prescriptionLabel}</Detail>
          <Detail label="Origine">{trip.origin ? `Récurrence « ${trip.origin} »` : "Course ponctuelle"}</Detail>
          {trip.statusTraces.length > 0 ? (
            <Detail label="Suivi">
              <ul className="space-y-0.5">
                {trip.statusTraces.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </Detail>
          ) : null}
          {trip.patientPhone ? (
            <Detail label="Téléphone">
              <a href={`tel:${trip.patientPhone.replace(/\s+/g, "")}`} className="tabular text-brand-700 underline-offset-2 hover:underline">
                {trip.patientPhone}
              </a>
            </Detail>
          ) : null}
          {trip.cancellation ? (
            <Detail label="Annulation">
              {trip.cancellation}
              {trip.cancellationTrace ? <span className="block text-xs text-slate-500">{trip.cancellationTrace.full}</span> : null}
            </Detail>
          ) : null}
          {trip.lockedVehicleLabel ? <Detail label="Verrou">Figée sur {trip.lockedVehicleLabel}</Detail> : null}
          {trip.exceptionalAmbulance ? (
            <Detail label="Recours exceptionnel">
              {EXCEPTIONAL_AMBULANCE_REASON} : ambulance facturée au tarif VSL.
              <span className="block text-xs text-slate-500">{trip.exceptionalAmbulance.full}.</span>
            </Detail>
          ) : null}
          {trip.directKm !== null ? (
            <Detail label="Distance">
              <span className="tabular">
                {formatKm(trip.directKm)}
                {trip.detourKm ? ` (+ ${formatKm(trip.detourKm)} de détour)` : ""}
              </span>
            </Detail>
          ) : null}
          {trip.estimatedRevenue !== null ? (
            <Detail label="CA estimé">
              <span className="tabular">{formatEuros(trip.estimatedRevenue)}</span>
            </Detail>
          ) : null}
          {trip.notes ? <Detail label="Notes">{trip.notes}</Detail> : null}
        </dl>
        <TollForm trip={trip} />
        <LifecycleForm trip={trip} />
      </Panel>

      <Panel title="Horaire">
        <ScheduleForm trip={trip} />
      </Panel>

      <Panel title="Transport partagé">
        <SharingPanel trip={trip} />
      </Panel>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-md border border-slate-200 bg-white p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      {children}
    </section>
  );
}

/** Who recorded a status or an answer, under its badge; the full sentence shows on hover and in « Détails ». */
function TraceHint({ full, short }: { full: string | undefined; short: string }) {
  return (
    <span className="mt-0.5 block max-w-48 truncate text-xs text-slate-500" title={full}>
      {short}
    </span>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className="min-w-0 wrap-break-word text-slate-800">{children}</dd>
    </div>
  );
}

/** Reasons after which the return of the same care is usually not needed: « Annuler aussi le retour » starts ticked. */
const RETURN_GOES_TOO: ReadonlySet<string> = new Set<UserCancellationReason>(["PATIENT", "FACILITY", "HOSPITALIZATION", "DECEASED"]);

function cancelConfirmMessage(trip: TripRowData, withReturn: boolean): string {
  const back = trip.pairedReturn;
  const what = withReturn && back
    ? `Annuler la course de ${trip.patientName} (aller) et son retour${back.keyMinute !== null ? ` (fin de séance ${formatMinute(back.keyMinute)})` : ""} ?`
    : `Annuler la course de ${trip.patientName} (${DIRECTION_LABELS[trip.direction].toLowerCase()}) ?`;
  return `${what}${trip.vehicleLabel ? " Elle sera retirée de sa tournée." : ""}${
    trip.shared ? " Ses co-passagers restés seuls ne seront plus en transport partagé." : ""
  }`;
}

/**
 * « Annuler la course » and « Rétablir la course » share one form: when the
 * status flips, the same form and its action state stay mounted, so the
 * action's message (late cancellation, co-passengers left alone, possible
 * duplicate on restore…) stays on screen. Submitted without React's form reset
 * (submitWithoutReset): a refused cancellation keeps the reason, note and box chosen.
 */
function LifecycleForm({ trip }: { trip: TripRowData }) {
  const restorable = canRestore(trip.status);
  const [state, formAction, pending] = useActionState(restorable ? restoreTrip : cancelTrip, INITIAL_ACTION_RESULT);
  if (!restorable && !canCancel(trip.status)) {
    return (
      <p className="border-t border-slate-100 pt-3 text-xs text-slate-500">
        Course {TRIP_STATUS_LABELS[trip.status].toLowerCase()} : elle ne peut plus être annulée.
      </p>
    );
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    if (!restorable) {
      // The box can be unticked: the question says what will really be cancelled.
      const back = event.currentTarget.querySelector<HTMLInputElement>('input[name="returnTripId"]');
      if (!window.confirm(cancelConfirmMessage(trip, back?.checked === true))) {
        event.preventDefault();
        return;
      }
    }
    submitWithoutReset(formAction)(event);
  }

  return (
    <form action={formAction} onSubmit={onSubmit} className="space-y-2 border-t border-slate-100 pt-3">
      <input type="hidden" name="tripId" value={trip.id} />
      {restorable ? (
        <Button type="submit" variant="secondary" size="sm" disabled={pending} aria-busy={pending}>
          {pending ? (
            "Rétablissement…"
          ) : (
            <>
              <Undo2 aria-hidden className="size-4" />
              Rétablir la course
            </>
          )}
        </Button>
      ) : (
        // Keyed by status: a trip cancelled then restored starts with an empty form.
        <CancelFields key={trip.status} trip={trip} pending={pending} />
      )}
      <ActionMessage result={state} />
    </form>
  );
}

/** Fields of « Annuler la course » : a reason from the list, an optional note, and the return of the same care if any. */
function CancelFields({ trip, pending }: { trip: TripRowData; pending: boolean }) {
  const reasonId = useId();
  const noteId = useId();
  const back = trip.pairedReturn;
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  // Null while untouched: the box follows the reason (ticked for RETURN_GOES_TOO); a click fixes it.
  const [withReturn, setWithReturn] = useState<boolean | null>(null);
  const returnChecked = withReturn ?? RETURN_GOES_TOO.has(reason);
  return (
    <>
      <div className="space-y-2">
        <div className="space-y-1">
          <label htmlFor={reasonId} className="block text-sm font-medium text-slate-700">
            Motif de l&apos;annulation
          </label>
          <Select id={reasonId} name="reason" required value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="" disabled>
              Choisir un motif…
            </option>
            {USER_CANCELLATION_REASONS.map((r) => (
              <option key={r} value={r}>
                {CANCELLATION_REASON_LABELS[r]}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <label htmlFor={noteId} className="block text-sm font-medium text-slate-700">
            Précision{" "}
            <span className="font-normal text-slate-500">
              (obligatoire pour « {CANCELLATION_REASON_LABELS.OTHER} »)
            </span>
          </label>
          <Input
            id={noteId}
            name="note"
            maxLength={CANCELLATION_NOTE_MAX}
            placeholder="Ex. prévenu par sa fille"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-describedby={`${noteId}-hint`}
          />
          <p id={`${noteId}-hint`} className="text-xs text-slate-500">
            Aucune information médicale : le motif choisi suffit.
          </p>
        </div>
      </div>
      {back ? (
        <Checkbox
          name="returnTripId"
          value={back.id}
          checked={returnChecked}
          onChange={(e) => setWithReturn(e.target.checked)}
          label={`Annuler aussi le retour${back.keyMinute !== null ? ` (fin de séance ${formatMinute(back.keyMinute)})` : ""}`}
        />
      ) : null}
      <Button
        type="submit"
        variant="secondary"
        size="sm"
        className="text-red-700 hover:bg-red-50"
        disabled={pending}
        aria-busy={pending}
      >
        {pending ? (
          "Annulation…"
        ) : (
          <>
            <X aria-hidden className="size-4" />
            Annuler la course
          </>
        )}
      </Button>
    </>
  );
}

/** « Péage » of the trip: added to the patient's invoice, outside surcharges and discounts. */
function TollForm({ trip }: { trip: TripRowData }) {
  const inputId = useId();
  if (trip.status === "CANCELLED" || trip.status === "NO_SHOW") return null;
  return (
    <ActionForm action={setTripToll} hidden={{ tripId: trip.id }}>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <label htmlFor={inputId} className="block text-sm font-medium text-slate-700">
            Péage (facultatif)
          </label>
          <UnitInput
            id={inputId}
            name="toll"
            inputMode="decimal"
            autoComplete="off"
            unit="€"
            defaultValue={trip.tollAmount ? trip.tollAmount.toFixed(2).replace(".", ",") : ""}
            className="tabular w-32"
          />
        </div>
        <SubmitButton variant="secondary" size="sm" pendingLabel="Enregistrement…">
          Enregistrer le péage
        </SubmitButton>
      </div>
      <p className="text-xs text-slate-500">Part de ce patient, sur justificatif : ajoutée à sa facture, hors majorations et abattements.</p>
    </ActionForm>
  );
}

function ScheduleForm({ trip }: { trip: TripRowData }) {
  const inputId = useId();
  if (!canEditTime(trip.status)) {
    return (
      <div className="space-y-1 text-sm">
        <p className="text-slate-700">
          {timeFieldLabel(trip.direction)} : <span className="tabular font-medium">{formatMinute(trip.keyMinute)}</span>
        </p>
        <p className="text-xs text-slate-500">Horaire figé : la course est commencée, terminée ou annulée.</p>
      </div>
    );
  }
  return (
    <ActionForm action={rescheduleTrip} hidden={{ tripId: trip.id }}>
      <div className="space-y-1">
        <label htmlFor={inputId} className="block text-sm font-medium text-slate-700">
          {timeFieldLabel(trip.direction)}
        </label>
        <div className="flex items-center gap-2">
          <Input
            id={inputId}
            name="time"
            type="time"
            required
            defaultValue={trip.keyMinute !== null ? formatMinute(trip.keyMinute) : ""}
            className="tabular w-32"
          />
          <SubmitButton variant="secondary" size="sm" pendingLabel="Modification…">
            Modifier l&apos;horaire
          </SubmitButton>
        </div>
      </div>
      <p className="text-xs text-slate-500">
        {trip.vehicleLabel
          ? "Si l'horaire prévu dans la tournée ne respecte plus le nouvel horaire, la course en est retirée : réoptimisez alors le planning pour la replacer."
          : "Pris en compte à la prochaine optimisation."}
      </p>
    </ActionForm>
  );
}

function SharingPanel({ trip }: { trip: TripRowData }) {
  const noteId = useId();
  const decisions = sharingDecisionsFor(trip);

  return (
    <div className="space-y-3">
      {sharingConflict(trip) ? (
        <p role="note" className="flex items-start gap-1.5 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-800">
          <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
          <span>
            Le planning actuel transporte encore ce patient avec un autre malgré son refus : réoptimisez le planning pour
            qu&apos;il voyage seul avant de prévenir l&apos;accueil.
          </span>
        </p>
      ) : null}
      <dl className="space-y-1.5 text-sm">
        <Detail label="Statut">
          <Badge tone={SHARING_STATUS_TONES[trip.sharingStatus]}>{SHARING_STATUS_LABELS[trip.sharingStatus]}</Badge>
        </Detail>
        <Detail label="Prescription">{trip.sharingAllowed ? "Partage autorisé sur ce trajet" : "Partage non autorisé"}</Detail>
        <Detail label="Proposé le">
          <span className="tabular">{trip.sharingProposedAt ?? "—"}</span>
        </Detail>
        <Detail label="Réponse">{trip.sharingAnswer ?? "—"}</Detail>
        {trip.sharingNote ? (
          <Detail label="Note">
            <span className="whitespace-pre-line">{trip.sharingNote}</span>
          </Detail>
        ) : null}
        {trip.shared ? (
          <Detail label="Planning">
            Partagée{trip.coPassengers.length > 0 ? ` avec ${trip.coPassengers.join(", ")}` : ""}
          </Detail>
        ) : null}
      </dl>

      {decisions.length > 0 ? (
        <ActionForm action={recordSharingDecision} hidden={{ tripId: trip.id }} className="border-t border-slate-100 pt-3">
          <p className="text-xs text-slate-500">
            Réponse du patient au transport partagé. La proposition est horodatée par l&apos;optimisation quand elle
            regroupe la course ; une réponse corrigée garde la trace de la précédente dans la note.
          </p>
          <div className="space-y-1">
            <label htmlFor={noteId} className="block text-sm font-medium text-slate-700">
              Note <span className="font-normal text-slate-500">(facultatif : motif du refus, canal…)</span>
            </label>
            <Textarea
              id={noteId}
              name="note"
              maxLength={500}
              rows={2}
              className="min-h-14"
              aria-describedby={`${noteId}-hint`}
            />
            {/* A refusal is often explained by the patient's health: the reason stays non-medical. */}
            <p id={`${noteId}-hint`} className="text-xs text-slate-500">
              Aucune information médicale (diagnostic, traitement) : « préfère voyager seul » suffit.
            </p>
          </div>
          <DecisionButtons decisions={decisions} />
        </ActionForm>
      ) : (
        <p className="border-t border-slate-100 pt-3 text-xs text-slate-500">
          {trip.status === "CANCELLED"
            ? "Course annulée : pas de décision de partage."
            : "La prescription n'autorise pas le transport partagé sur ce trajet : aucune décision à tracer."}
        </p>
      )}
      <p className="text-xs text-slate-500">
        Un refus est mentionné sur la facture ; le patient avance alors les frais (décret 2025-202, art. R. 322-11-4).
      </p>
    </div>
  );
}

const DECISION_ICONS: Record<SharingDecision, typeof Check> = { ACCEPTED: Check, REFUSED: X };

/** One submit button per decision; only the clicked one shows the pending state. */
function DecisionButtons({ decisions }: { decisions: SharingDecision[] }) {
  const { pending, data } = useFormStatus();
  const submitted = data?.get("decision");
  return (
    <div className="flex flex-wrap gap-2">
      {decisions.map((decision) => {
        const Icon = DECISION_ICONS[decision];
        return (
          <Button
            key={decision}
            type="submit"
            name="decision"
            value={decision}
            variant="secondary"
            size="sm"
            disabled={pending}
            aria-busy={pending && submitted === decision}
            className={cn(decision === "REFUSED" && "text-red-700 hover:bg-red-50", decision === "ACCEPTED" && "text-emerald-800 hover:bg-emerald-50")}
          >
            <Icon aria-hidden className="size-4" />
            {pending && submitted === decision ? "Enregistrement…" : SHARING_DECISION_LABELS[decision]}
          </Button>
        );
      })}
    </div>
  );
}
