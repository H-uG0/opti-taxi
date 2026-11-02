"use client";

import { useId, useState } from "react";
import { useFormStatus } from "react-dom";
import type { Payer, SharingStatus, TripDirection, TripStatus, VehicleType } from "@prisma/client";
import { Check, ChevronDown, Lock, TriangleAlert, Undo2, Users, X } from "lucide-react";
import { Badge, VEHICLE_TYPE_COLORS, VehicleTypeBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Input, Textarea } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { Td } from "@/components/ui/table";
import { DIRECTION_LABELS, PAYER_LABELS, SHARING_STATUS_LABELS, TRIP_STATUS_LABELS, formatEuros, formatKm } from "@/lib/labels";
import { formatMinute } from "@/lib/time";
import { cancelTrip, recordSharingDecision, rescheduleTrip, restoreTrip } from "./actions";
import { ActionForm } from "./action-form";
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
  plannedPickupMinute: number | null;
  plannedDropoffMinute: number | null;
  shared: boolean;
  coPassengers: string[];
  directKm: number | null;
  detourKm: number | null;
  estimatedRevenue: number | null;
  sharingAllowed: boolean;
  sharingStatus: SharingStatus;
  sharingProposedAt: string | null;
  sharingRespondedAt: string | null;
  sharingNote: string | null;
  notes: string | null;
};

export const TRIP_TABLE_COLUMNS = 8;

const PAYER_SHORT: Record<Payer, string> = { CPAM: "CPAM", PRIVATE: "Privé" };

export function TripRow({ trip }: { trip: TripRowData }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const cancelled = trip.status === "CANCELLED";
  const muted = cancelled ? "opacity-55" : undefined;
  const conflict = sharingConflict(trip);

  return (
    <>
      <tr className={cn("align-top", open ? "bg-brand-50/40" : "hover:bg-slate-50")}>
        <Td className={cn("whitespace-nowrap", muted)}>
          <span className="tabular block text-base font-semibold text-slate-900">{formatMinute(trip.keyMinute)}</span>
          <span className="block text-xs text-slate-500">{keyMinuteLabel(trip.direction)}</span>
        </Td>
        <Td className={muted}>
          <span className={cn("block font-medium text-slate-900", cancelled && "line-through")}>{trip.patientName}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1">
            <Badge tone={trip.direction === "OUTBOUND" ? "brand" : "neutral"}>{DIRECTION_LABELS[trip.direction]}</Badge>
            {trip.origin ? null : <span className="text-xs text-slate-500">Ponctuelle</span>}
          </span>
        </Td>
        <Td className={cn("max-w-72", muted)}>
          <span className="block truncate font-medium text-slate-800" title={trip.facilityName ?? undefined}>
            {trip.facilityName ?? "Adresse libre"}
          </span>
          <span className="block truncate text-xs text-slate-500" title={`${trip.pickupAddress} → ${trip.dropoffAddress}`}>
            {trip.pickupAddress} → {trip.dropoffAddress}
          </span>
        </Td>
        <Td className={cn("hidden lg:table-cell", muted)}>
          <span className="flex flex-wrap gap-1">
            {trip.allowedVehicleTypes.map((type) => (
              <VehicleTypeBadge key={type} type={type} />
            ))}
          </span>
          <span className="mt-1 block text-xs text-slate-500">{PAYER_SHORT[trip.payer]}</span>
        </Td>
        <Td className="whitespace-nowrap">
          <Badge tone={TRIP_STATUS_TONES[trip.status]}>{TRIP_STATUS_LABELS[trip.status]}</Badge>
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
        </Td>
        <Td className={muted}>
          <Badge tone={SHARING_STATUS_TONES[trip.sharingStatus]}>{SHARING_STATUS_LABELS[trip.sharingStatus]}</Badge>
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
        <Td className="text-right">
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
      <Panel title="Course">
        <dl className="space-y-1.5 text-sm">
          <Detail label="Prise en charge">{trip.pickupAddress}</Detail>
          <Detail label="Dépose">{trip.dropoffAddress}</Detail>
          <Detail label="Payeur">{PAYER_LABELS[trip.payer]}</Detail>
          <Detail label="Prescription">{trip.prescriptionLabel}</Detail>
          <Detail label="Origine">{trip.origin ? `Récurrence « ${trip.origin} »` : "Course ponctuelle"}</Detail>
          {trip.patientPhone ? (
            <Detail label="Téléphone">
              <a href={`tel:${trip.patientPhone.replace(/\s+/g, "")}`} className="tabular text-brand-700 underline-offset-2 hover:underline">
                {trip.patientPhone}
              </a>
            </Detail>
          ) : null}
          {trip.lockedVehicleLabel ? <Detail label="Verrou">Figée sur {trip.lockedVehicleLabel}</Detail> : null}
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

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className="min-w-0 wrap-break-word text-slate-800">{children}</dd>
    </div>
  );
}

function LifecycleForm({ trip }: { trip: TripRowData }) {
  if (canRestore(trip.status)) {
    return (
      <ActionForm key="lifecycle" action={restoreTrip} hidden={{ tripId: trip.id }} className="border-t border-slate-100 pt-3">
        <SubmitButton variant="secondary" size="sm" pendingLabel="Rétablissement…">
          <Undo2 aria-hidden className="size-4" />
          Rétablir la course
        </SubmitButton>
      </ActionForm>
    );
  }
  if (canCancel(trip.status)) {
    return (
      <ActionForm
        key="lifecycle"
        action={cancelTrip}
        hidden={{ tripId: trip.id }}
        confirmMessage={`Annuler la course de ${trip.patientName} (${DIRECTION_LABELS[trip.direction].toLowerCase()}) ?${
          trip.vehicleLabel ? " Elle sera retirée de sa tournée." : ""
        }${trip.shared ? " Ses co-passagers restés seuls ne seront plus en transport partagé." : ""}`}
        className="border-t border-slate-100 pt-3"
      >
        <SubmitButton variant="secondary" size="sm" className="text-red-700 hover:bg-red-50" pendingLabel="Annulation…">
          <X aria-hidden className="size-4" />
          Annuler la course
        </SubmitButton>
      </ActionForm>
    );
  }
  return (
    <p className="border-t border-slate-100 pt-3 text-xs text-slate-500">
      Course {TRIP_STATUS_LABELS[trip.status].toLowerCase()} : elle ne peut plus être annulée.
    </p>
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
        <Detail label="Réponse le">
          <span className="tabular">{trip.sharingRespondedAt ?? "—"}</span>
        </Detail>
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
            <Textarea id={noteId} name="note" maxLength={500} rows={2} className="min-h-14" />
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
