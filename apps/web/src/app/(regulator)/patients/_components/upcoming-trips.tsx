"use client";

import { Fragment, useActionState, useId, useState, type FormEvent } from "react";
import Link from "next/link";
import { Undo2, X } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button, LinkButton } from "@/components/ui/button";
import { ConfirmPanel } from "@/components/ui/confirm-action";
import { Input, Select } from "@/components/ui/form";
import { TBody, Td, Th, THead } from "@/components/ui/table";
import { CANCELLATION_NOTE_MAX, CANCELLATION_REASON_LABELS, USER_CANCELLATION_REASONS } from "@/lib/domain/cancellation";
import { INITIAL_ACTION_RESULT, PENDING_LABEL } from "@/lib/forms";
import { ActionMessage } from "../../courses/action-form";
import { cancelTrips, restoreTrip } from "../../courses/actions";
import { dayCancelLabel, dayCancelQuestion, type UpcomingDay, type UpcomingTrip } from "../_lib/upcoming";

/**
 * « Prochaines courses » of the patient record, one block per day: each trip
 * can be changed (« Modifier »), cancelled with a reason, or restored when it
 * was cancelled; « Annuler ce jour (aller et retour) » cancels every open trip
 * of the day with one reason. The cancellations are those of « Courses »
 * (cancelTrips: who, when, late or not, out of its route, traced trip by trip).
 */
export function UpcomingTrips({ days }: { days: UpcomingDay[] }) {
  // One cancellation form open at a time: a day ("day:2026-11-17") or a trip ("trip:<id>").
  const [open, setOpen] = useState<string | null>(null);
  // « Rétablir » answers here: the trip's row loses its button once restored, the message stays.
  const [restored, restoreAction, restoring] = useActionState(restoreTrip, INITIAL_ACTION_RESULT);
  return (
    <div className="overflow-x-auto">
      {restored.message ? (
        <div className="border-b border-slate-200 px-3 py-2">
          <ActionMessage result={restored} />
        </div>
      ) : null}
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <THead>
          <tr>
            <Th>Sens</Th>
            <Th>Horaire</Th>
            <Th>Établissement</Th>
            <Th>Statut</Th>
            <Th>Partage</Th>
            <Th className="text-right">
              <span className="sr-only">Actions</span>
            </Th>
          </tr>
        </THead>
        <TBody>
          {days.map((day) => {
            const openTrips = day.trips.filter((t) => t.canCancel);
            const dayKey = `day:${day.date}`;
            return (
              <Fragment key={day.date}>
                <tr className="bg-slate-50">
                  <td colSpan={6} className="px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-slate-900">
                        {/* The trips of the day in Courses (this patient only). */}
                        <Link href={day.coursesHref} className="tabular underline-offset-2 hover:text-brand-800 hover:underline" title="Voir ces courses dans Courses">
                          {day.label}
                        </Link>
                        {day.today ? <span className="ml-1.5 text-xs font-normal text-slate-500">aujourd&apos;hui</span> : null}
                        {day.absence ? (
                          <Badge tone="warning" className="ml-2">
                            {day.absence}
                          </Badge>
                        ) : null}
                      </p>
                      {openTrips.length > 0 && open !== dayKey ? (
                        <Button variant="ghost" size="sm" className="text-red-700 hover:bg-red-50" onClick={() => setOpen(dayKey)}>
                          <X aria-hidden className="size-4" />
                          {dayCancelLabel(openTrips)}
                        </Button>
                      ) : null}
                    </div>
                    {open === dayKey ? (
                      <CancelForm
                        tripIds={openTrips.map((t) => t.id)}
                        question={dayCancelQuestion(day.label, openTrips)}
                        confirmLabel={openTrips.length > 1 ? `Oui, annuler les ${openTrips.length} courses` : "Oui, annuler la course"}
                        onClose={() => setOpen(null)}
                      />
                    ) : null}
                  </td>
                </tr>
                {day.trips.map((t) => (
                  <TripRow
                    key={t.id}
                    trip={t}
                    cancelling={open === `trip:${t.id}`}
                    onCancel={() => setOpen(`trip:${t.id}`)}
                    onClose={() => setOpen(null)}
                    restore={{ action: restoreAction, pending: restoring }}
                  />
                ))}
              </Fragment>
            );
          })}
        </TBody>
      </table>
    </div>
  );
}

function TripRow({
  trip,
  cancelling,
  onCancel,
  onClose,
  restore,
}: {
  trip: UpcomingTrip;
  cancelling: boolean;
  onCancel: () => void;
  onClose: () => void;
  restore: { action: (formData: FormData) => void; pending: boolean };
}) {
  return (
    <>
      <tr className={trip.status === "CANCELLED" ? "align-top text-slate-500" : "align-top"}>
        <Td className="whitespace-nowrap">{trip.directionLabel}</Td>
        <Td className="tabular whitespace-nowrap">
          {trip.timeText}
          {trip.plannedText ? <span className="block text-xs text-slate-500">{trip.plannedText}</span> : null}
        </Td>
        <Td>
          {trip.facility ?? <span className="text-slate-500">Adresse libre</span>}
          {trip.oneOffAddress ? <span className="block text-xs font-medium text-amber-800">Adresse ponctuelle du patient</span> : null}
          {trip.notes ? (
            <span className="block max-w-xs truncate text-xs text-slate-500" title={trip.notes}>
              {trip.notes}
            </span>
          ) : null}
        </Td>
        <Td>
          <Badge tone={trip.statusTone as BadgeTone}>{trip.statusLabel}</Badge>
          {trip.cancellation ? <span className="mt-0.5 block text-xs text-slate-500">{trip.cancellation}</span> : null}
        </Td>
        <Td className="whitespace-nowrap">
          {trip.shared ? (
            <Badge tone="shared" className="mr-1.5">
              Partagée
            </Badge>
          ) : null}
          <span className={trip.sharingRefused ? "font-medium text-red-700" : "text-slate-700"}>{trip.sharingLabel}</span>
        </Td>
        <Td>
          <div className="flex flex-wrap items-start justify-end gap-1">
            {trip.editHref ? (
              <LinkButton href={trip.editHref} size="sm" variant="ghost" aria-label={`Modifier la course ${trip.ariaName}`}>
                Modifier
              </LinkButton>
            ) : null}
            {trip.canCancel && !cancelling ? (
              <Button variant="ghost" size="sm" className="text-red-700 hover:bg-red-50" onClick={onCancel} aria-label={`Annuler la course ${trip.ariaName}`}>
                Annuler
              </Button>
            ) : null}
            {trip.canRestore ? <RestoreButton tripId={trip.id} ariaName={trip.ariaName} {...restore} /> : null}
          </div>
        </Td>
      </tr>
      {cancelling ? (
        <tr>
          <td colSpan={6} className="px-3 pb-3">
            <CancelForm
              tripIds={trip.canCancel ? [trip.id] : []}
              question={`Annuler la course ${trip.ariaName} ?${trip.inRoute ? " Elle sera retirée de sa tournée." : ""}`}
              confirmLabel="Oui, annuler la course"
              onClose={onClose}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** « Rétablir » : the trip comes back, outside any route (restoreTrip refuses a past day, an inactive patient…). */
function RestoreButton({
  tripId,
  ariaName,
  action,
  pending,
}: {
  tripId: string;
  ariaName: string;
  action: (formData: FormData) => void;
  pending: boolean;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="tripId" value={tripId} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending} aria-busy={pending} aria-label={`Rétablir la course ${ariaName}`}>
        {pending ? (
          PENDING_LABEL
        ) : (
          <>
            <Undo2 aria-hidden className="size-4" />
            Rétablir
          </>
        )}
      </Button>
    </form>
  );
}

/** Reason (required), note (required for « Autre »), then the confirmation; one or several trips. */
function CancelForm({
  tripIds,
  question,
  confirmLabel,
  onClose,
}: {
  tripIds: string[];
  question: string;
  confirmLabel: string;
  onClose: () => void;
}) {
  const [state, formAction] = useActionState(cancelTrips, INITIAL_ACTION_RESULT);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const reasonId = useId();
  const noteId = useId();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    if (confirming) return;
    event.preventDefault();
    if (event.currentTarget.reportValidity()) setConfirming(true);
  };
  // Done (or nothing left to cancel): the answer stays until the form is closed (reopening starts afresh).
  if (tripIds.length === 0 || (state.ok && state.message)) {
    return (
      <div className="mt-2 flex flex-wrap items-start justify-between gap-2 rounded-md border border-slate-200 bg-white p-3">
        <ActionMessage result={state.message ? state : { ok: true, message: "Plus aucune course à annuler ce jour." }} />
        <Button variant="ghost" size="sm" onClick={onClose}>
          Fermer
        </Button>
      </div>
    );
  }
  return (
    <form
      action={(formData) => {
        setConfirming(false);
        formAction(formData);
      }}
      onSubmit={submit}
      className="mt-2 space-y-2 rounded-md border border-slate-200 bg-white p-3"
    >
      {tripIds.map((id) => (
        <input key={id} type="hidden" name="tripId" value={id} />
      ))}
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-64 space-y-1">
          <label htmlFor={reasonId} className="block text-xs font-medium text-slate-600">
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
        <div className="w-64 space-y-1">
          <label htmlFor={noteId} className="block text-xs font-medium text-slate-600">
            Précision {reason === "OTHER" ? "(obligatoire)" : "(facultative)"}
          </label>
          <Input
            id={noteId}
            name="note"
            maxLength={CANCELLATION_NOTE_MAX}
            required={reason === "OTHER"}
            placeholder="Ex. prévenu par sa fille"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        {confirming ? null : (
          <div className="flex items-center gap-2">
            <Button type="submit" variant="secondary" size="sm" className="text-red-700 hover:bg-red-50">
              {tripIds.length > 1 ? `Annuler les ${tripIds.length} courses` : "Annuler la course"}
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Fermer
            </Button>
          </div>
        )}
      </div>
      <p className="text-xs text-slate-500">Aucune information médicale dans la précision&nbsp;: le motif choisi suffit.</p>
      {confirming ? (
        <ConfirmPanel question={question} confirmLabel={confirmLabel} keepLabel="Garder" onKeep={() => setConfirming(false)} />
      ) : null}
      <ActionMessage result={state} />
    </form>
  );
}
