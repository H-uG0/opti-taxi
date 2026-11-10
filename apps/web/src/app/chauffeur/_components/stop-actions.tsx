"use client";

/**
 * Status buttons of a stop: the only interactive part of a stop card.
 *
 * Built for a phone in a car on a flaky mobile network:
 * - a tap is saved on the phone at once with its time (the status queue, see
 *   driver-app.tsx) and replaces the buttons: « Envoi en cours », then
 *   « Enregistré » until the page is refreshed a moment later, or « En
 *   attente d'envoi » when there is no network (sent again by itself);
 * - a status still waiting can be withdrawn (« Retirer ce statut »); one
 *   whose send got no final answer may be on the server, so withdrawing it
 *   sends an « Annuler » (the queue decides, see cancelQueued);
 * - a refusal (cancelled trip, status changed by the other crew member…)
 *   puts the buttons back with the reason, and the driver can tap again;
 * - a slow network is announced after a few seconds instead of a silent
 *   spinner, and after 15 s the status simply waits in the queue.
 */
import { useEffect, useId, useState } from "react";
import { Check, CloudOff, LoaderCircle, TriangleAlert, Undo2, UserX } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { formatMinute, minuteOfDay } from "@/lib/time";
import { localStatusShown, type LocalStatus } from "../_lib/status-queue";
import type { StopAction } from "../_lib/transitions";
import { useDriverApp, useQueueSnapshot } from "./driver-app";

const STATUS_LABELS: Record<StopAction, string> = {
  PICKUP: "Pris en charge",
  DROPOFF: "Déposé",
  NO_SHOW: "Patient absent",
  UNDO: "Annulation du statut",
};

const SLOW_AFTER_MS = 6000;

const bigButton =
  "inline-flex w-full touch-manipulation select-none items-center justify-center gap-2 rounded-xl px-4 font-semibold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed";

/** True once the status has been sending for SLOW_AFTER_MS. */
function useSlow(sending: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!sending) return;
    const timer = window.setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => {
      window.clearTimeout(timer);
      setSlow(false);
    };
  }, [sending]);
  return slow;
}

/** Where a status waiting on the phone stands (« elle »: the undo, « il »: the status). */
function waitingText(local: LocalStatus, sessionLost: boolean): string {
  const undo = local.action === "UNDO";
  if (local.uncertain) {
    // Sent without a final answer (timeout, cut): the server may already have it; a replay changes nothing.
    return undo
      ? "Envoi incertain\u00a0: elle est peut-être déjà enregistrée\u202f; elle est renvoyée sans doublon."
      : "Envoi incertain\u00a0: il est peut-être déjà enregistré\u202f; il est renvoyé sans doublon.";
  }
  if (sessionLost) return `En attente d'envoi\u00a0: ${undo ? "elle part" : "il part, avec l'heure du geste,"} après la reconnexion.`;
  return undo
    ? "En attente d'envoi\u00a0: elle part dès que le réseau revient."
    : "En attente d'envoi\u00a0: il part dès que le réseau revient, avec l'heure du geste.";
}

/** The latest status tapped on this stop, in place of the buttons until the page shows it. */
function LocalStatusPanel({ stopId, local }: { stopId: string; local: LocalStatus }) {
  const { cancelQueued } = useDriverApp();
  const { sessionLost } = useQueueSnapshot();
  const slow = useSlow(local.phase === "sending");
  const at = formatMinute(minuteOfDay(new Date(local.observedAt)));
  const label = local.action === "UNDO" ? "Annulation du statut" : `${STATUS_LABELS[local.action]} à ${at}`;

  if (local.phase === "queued") {
    const undo = local.action === "UNDO";
    // An undo that may already be on the server is sent again, never taken back (see cancelQueued).
    const withdrawable = !(undo && local.uncertain);
    return (
      <div role="status" className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-amber-950">
        <div>
          <p className="flex items-center gap-2 text-base font-semibold">
            <CloudOff aria-hidden className="size-5 shrink-0" />
            <span className="tabular">{label}</span>
          </p>
          <p className="mt-0.5 text-sm">{waitingText(local, sessionLost !== null)}</p>
        </div>
        {withdrawable ? (
          <button
            type="button"
            onClick={() => cancelQueued(stopId)}
            className={cn(bigButton, "min-h-12 border border-amber-400 bg-white text-base text-amber-950 hover:bg-amber-100")}
          >
            <Undo2 aria-hidden className="size-5" />
            {undo ? "Ne pas annuler" : "Retirer ce statut"}
          </button>
        ) : null}
      </div>
    );
  }

  const tone =
    local.action === "NO_SHOW" ? "border-red-200 bg-red-50 text-red-900" : "border-emerald-200 bg-emerald-50 text-emerald-900";
  return (
    <div role="status" className={cn("rounded-xl border px-4 py-3", tone)}>
      <p className="flex items-center gap-2 text-base font-semibold">
        {local.action === "UNDO" ? <Undo2 aria-hidden className="size-5" /> : <Check aria-hidden className="size-5" />}
        <span className="tabular">{label}</span>
        {local.phase === "sending" ? <LoaderCircle aria-hidden className="ml-auto size-5 motion-safe:animate-spin" /> : null}
      </p>
      <p className="mt-0.5 text-sm">
        {local.phase === "sent"
          ? "Enregistré."
          : slow
            ? "Réseau lent\u00a0: l'envoi continue, le statut est gardé sur le téléphone."
            : "Envoi en cours…"}
      </p>
    </div>
  );
}

/** The reason on the stop itself. Not a live region: the header's refusal bar announces it once. */
function ActionError({ message }: { message: string }) {
  return (
    <p className="flex items-start gap-2 rounded-xl border border-red-300 bg-red-50 px-3 py-2.5 text-sm font-medium text-red-900">
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      {message}
    </p>
  );
}

/** The server's last refusal of a status of this stop, until the crew taps again or dismisses it. */
function useRefusal(stopId: string): string | null {
  const { refusals } = useQueueSnapshot();
  for (let i = refusals.length - 1; i >= 0; i--) if (refusals[i]?.stopId === stopId) return refusals[i]!.error;
  return null;
}

/** Buttons of a stop still to do: "Pris en charge" / "Déposé", and "Patient absent" on a pickup. */
export function StopActions({
  stopId,
  pickupStopId,
  primary,
  blockedReason,
  noShow,
  emphasized,
  patient,
}: {
  stopId: string;
  /** On a dropoff: the pickup stop of the same trip (a pickup tapped on the phone unlocks the dropoff). */
  pickupStopId: string | null;
  primary: "PICKUP" | "DROPOFF" | null;
  blockedReason: string | null;
  noShow: boolean;
  /** Next stop to do: filled main button. */
  emphasized: boolean;
  patient: string;
}) {
  const { submit } = useDriverApp();
  const { byStop } = useQueueSnapshot();
  const refusal = useRefusal(stopId);
  const [confirmingNoShow, setConfirmingNoShow] = useState(false);
  const reasonId = useId();

  const local = localStatusShown(true, byStop[stopId]);
  if (local) return <LocalStatusPanel stopId={stopId} local={local} />;

  if (confirmingNoShow) {
    return (
      <div role="group" aria-labelledby={`${reasonId}-confirm`} className="space-y-3 rounded-xl border border-red-200 bg-red-50 p-3">
        <div>
          <p id={`${reasonId}-confirm`} className="text-base font-semibold text-red-950">
            Confirmer l&apos;absence de {patient}&#x202F;?
          </p>
          <p className="text-sm text-red-900">La course passe en «&#x202F;Absent&#x202F;» et sa dépose est retirée de la tournée.</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setConfirmingNoShow(false)}
            className={cn(bigButton, "min-h-12 border border-slate-300 bg-white text-base text-slate-900 hover:bg-slate-50")}
          >
            Retour
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirmingNoShow(false);
              submit(stopId, "NO_SHOW");
            }}
            className={cn(bigButton, "min-h-12 bg-red-700 text-base text-white hover:bg-red-800")}
          >
            Oui, absent
          </button>
        </div>
      </div>
    );
  }

  // The pickup of this trip, tapped on this phone and not yet on the page, unlocks its dropoff.
  const pickupLocal = pickupStopId ? byStop[pickupStopId] : undefined;
  const blocked = blockedReason !== null && pickupLocal?.action !== "PICKUP";

  return (
    <div className="space-y-2">
      {primary ? (
        <button
          type="button"
          disabled={blocked}
          aria-describedby={blocked ? reasonId : undefined}
          onClick={() => submit(stopId, primary)}
          className={cn(
            bigButton,
            "text-lg",
            emphasized ? "min-h-14" : "min-h-12",
            blocked
              ? "border-2 border-dashed border-slate-300 bg-slate-100 text-slate-500"
              : emphasized
                ? "bg-brand-700 text-white shadow-sm hover:bg-brand-800 active:bg-brand-900"
                : "border-2 border-brand-700 bg-white text-brand-800 hover:bg-brand-50 active:bg-brand-100",
          )}
        >
          <Check aria-hidden className="size-6" />
          {primary === "PICKUP" ? "Pris en charge" : "Déposé"}
          <span className="sr-only"> : {patient}</span>
        </button>
      ) : null}
      {blocked ? (
        <p id={reasonId} className="text-center text-sm font-medium text-slate-600">
          {blockedReason}
        </p>
      ) : null}
      {noShow ? (
        <button
          type="button"
          onClick={() => setConfirmingNoShow(true)}
          className={cn(bigButton, "min-h-12 border border-red-300 bg-white text-base text-red-800 hover:bg-red-50 active:bg-red-100")}
        >
          <UserX aria-hidden className="size-5" />
          Patient absent
          <span className="sr-only"> : {patient}</span>
        </button>
      ) : null}
      {refusal ? <ActionError message={refusal} /> : null}
    </div>
  );
}

/**
 * "Annuler" on the stop holding the latest status of the route (as the page
 * last saw it). Hidden while this phone holds a newer status of the route
 * (waiting, or sent and not yet on the page): the server would refuse this
 * undo, and « Retirer ce statut » on that stop is the undo to offer.
 */
export function UndoStatus({
  stopId,
  label,
  routeStopIds,
}: {
  stopId: string;
  label: string;
  /** Every stop of the route. */
  routeStopIds: readonly string[];
}) {
  const { submit } = useDriverApp();
  const { byStop } = useQueueSnapshot();
  const refusal = useRefusal(stopId);
  const local = localStatusShown(false, byStop[stopId]);
  const newerOnPhone = routeStopIds.some((id) => id !== stopId && byStop[id] !== undefined && byStop[id].action !== "UNDO");
  if (!local && !refusal && newerOnPhone) return null;

  return (
    <div className="space-y-2 border-t border-slate-200 bg-white p-3">
      {local ? (
        <LocalStatusPanel stopId={stopId} local={local} />
      ) : newerOnPhone ? null : (
        <button
          type="button"
          onClick={() => submit(stopId, "UNDO")}
          className={cn(bigButton, "min-h-12 border border-slate-300 bg-white text-base text-slate-800 hover:bg-slate-50 active:bg-slate-100")}
        >
          <Undo2 aria-hidden className="size-5" />
          {label}
        </button>
      )}
      {refusal ? <ActionError message={refusal} /> : null}
    </div>
  );
}
