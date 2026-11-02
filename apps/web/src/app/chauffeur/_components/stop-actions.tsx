"use client";

/**
 * Status buttons of a stop: the only interactive part of a stop card.
 *
 * Built for a phone in a car on a flaky mobile network:
 * - the tapped status shows at once (useOptimistic) while the action runs;
 * - buttons are disabled while it is pending, so a double tap sends nothing twice
 *   (the server actions are idempotent anyway, a retry after a lost response is safe);
 * - a failure (refusal, server error, no network) puts the buttons back with an
 *   error banner, and the driver can simply tap again;
 * - a slow network is announced after a few seconds instead of a silent spinner.
 */
import { useEffect, useId, useOptimistic, useState, useTransition } from "react";
import { unstable_rethrow } from "next/navigation";
import { Check, LoaderCircle, TriangleAlert, Undo2, UserX } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { markDroppedOff, markNoShow, markPickedUp, undoStopStatus, type StopActionResult } from "../actions";
import type { StopAction } from "../_lib/transitions";

const SERVER_ACTIONS: Record<StopAction, (stopId: string) => Promise<StopActionResult>> = {
  PICKUP: markPickedUp,
  DROPOFF: markDroppedOff,
  NO_SHOW: markNoShow,
  UNDO: undoStopStatus,
};

const SENDING_LABELS: Record<StopAction, string> = {
  PICKUP: "Pris en charge",
  DROPOFF: "Déposé",
  NO_SHOW: "Patient absent",
  UNDO: "Annulation du statut",
};

const SLOW_AFTER_MS = 6000;
const OFFLINE_ERROR = "Pas de réseau : statut non envoyé. Réessayez dès que le réseau revient.";
const NETWORK_ERROR = "Envoi impossible (réseau ou serveur). Réessayez : un statut déjà reçu ne sera pas enregistré deux fois.";

const bigButton =
  "inline-flex w-full touch-manipulation select-none items-center justify-center gap-2 rounded-xl px-4 font-semibold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed";

function useStopAction(stopId: string) {
  const [isPending, startTransition] = useTransition();
  const [sending, setSending] = useOptimistic<StopAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!isPending) return;
    const timer = window.setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [isPending]);

  function run(action: StopAction) {
    if (isPending) return;
    setError(null);
    setSlow(false);
    if (typeof navigator.vibrate === "function") navigator.vibrate(25);
    startTransition(async () => {
      setSending(action);
      let failure: string | null = null;
      try {
        const result = await SERVER_ACTIONS[action](stopId);
        if (!result.ok) failure = result.error;
      } catch (err) {
        // Let Next.js handle its own control flow (e.g. redirect to /login when the session expired).
        unstable_rethrow(err);
        failure = navigator.onLine === false ? OFFLINE_ERROR : NETWORK_ERROR;
      }
      startTransition(() => setError(failure));
    });
  }

  return { isPending, sending, error, slow: isPending && slow, run };
}

function SendingPanel({ action, slow }: { action: StopAction; slow: boolean }) {
  const tone = action === "NO_SHOW" ? "border-red-200 bg-red-50 text-red-900" : "border-emerald-200 bg-emerald-50 text-emerald-900";
  return (
    <div role="status" className={cn("rounded-xl border px-4 py-3", tone)}>
      <p className="flex items-center gap-2 text-base font-semibold">
        {action === "UNDO" ? <Undo2 aria-hidden className="size-5" /> : <Check aria-hidden className="size-5" />}
        {SENDING_LABELS[action]}
        <LoaderCircle aria-hidden className="ml-auto size-5 animate-spin" />
      </p>
      <p className="mt-0.5 text-sm">{slow ? "Réseau lent : l'envoi continue, gardez la page ouverte." : "Envoi en cours…"}</p>
    </div>
  );
}

function ActionError({ message }: { message: string }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-xl border border-red-300 bg-red-50 px-3 py-2.5 text-sm font-medium text-red-900">
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      {message}
    </p>
  );
}

/** Buttons of a stop still to do: "Pris en charge" / "Déposé", and "Patient absent" on a pickup. */
export function StopActions({
  stopId,
  primary,
  blockedReason,
  noShow,
  emphasized,
  patient,
}: {
  stopId: string;
  primary: "PICKUP" | "DROPOFF" | null;
  blockedReason: string | null;
  noShow: boolean;
  /** Next stop to do: filled main button. */
  emphasized: boolean;
  patient: string;
}) {
  const { isPending, sending, error, slow, run } = useStopAction(stopId);
  const [confirmingNoShow, setConfirmingNoShow] = useState(false);
  const reasonId = useId();

  if (sending) return <SendingPanel action={sending} slow={slow} />;

  if (confirmingNoShow) {
    return (
      <div role="group" aria-labelledby={`${reasonId}-confirm`} className="space-y-3 rounded-xl border border-red-200 bg-red-50 p-3">
        <div>
          <p id={`${reasonId}-confirm`} className="text-base font-semibold text-red-950">
            Confirmer l&apos;absence de {patient} ?
          </p>
          <p className="text-sm text-red-900">La course passe en « Absent » et sa dépose est retirée de la tournée.</p>
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
            disabled={isPending}
            onClick={() => {
              setConfirmingNoShow(false);
              run("NO_SHOW");
            }}
            className={cn(bigButton, "min-h-12 bg-red-700 text-base text-white hover:bg-red-800")}
          >
            Oui, absent
          </button>
        </div>
      </div>
    );
  }

  const blocked = blockedReason !== null;

  return (
    <div className="space-y-2">
      {primary ? (
        <button
          type="button"
          disabled={isPending || blocked}
          aria-describedby={blocked ? reasonId : undefined}
          onClick={() => run(primary)}
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
          disabled={isPending}
          onClick={() => setConfirmingNoShow(true)}
          className={cn(bigButton, "min-h-12 border border-red-300 bg-white text-base text-red-800 hover:bg-red-50 active:bg-red-100")}
        >
          <UserX aria-hidden className="size-5" />
          Patient absent
          <span className="sr-only"> : {patient}</span>
        </button>
      ) : null}
      {error ? <ActionError message={error} /> : null}
    </div>
  );
}

/** "Annuler" on the stop holding the latest status of the route. */
export function UndoStatus({ stopId, label }: { stopId: string; label: string }) {
  const { isPending, sending, error, slow, run } = useStopAction(stopId);

  return (
    <div className="space-y-2">
      {sending ? (
        <SendingPanel action={sending} slow={slow} />
      ) : (
        <button
          type="button"
          disabled={isPending}
          onClick={() => run("UNDO")}
          className={cn(bigButton, "min-h-12 border border-slate-300 bg-white text-base text-slate-800 hover:bg-slate-50 active:bg-slate-100")}
        >
          <Undo2 aria-hidden className="size-5" />
          {label}
        </button>
      )}
      {error ? <ActionError message={error} /> : null}
    </div>
  );
}
