"use client";

/**
 * Header bars of the driver app (sticky, under the call button): no network,
 * statuses waiting to be sent, statuses the server refused, and the session
 * about to end or ended. And the « Session valable jusqu'à HH:MM » line of
 * the page.
 */
import { useSyncExternalStore } from "react";
import Link from "next/link";
import { CloudUpload, KeyRound, LoaderCircle, TriangleAlert, WifiOff } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { sessionNotice } from "../_lib/session-notice";
import { STOP_ACTION_LABELS } from "../_lib/transitions";
import { useDriverApp, useMinuteClock, useQueueSnapshot } from "./driver-app";

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/** What the phone says of its network (true during the server render). */
function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

const barButton =
  "inline-flex min-h-11 shrink-0 touch-manipulation items-center justify-center rounded-lg px-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count > 1 ? many : one}`;
}

export function FieldStatusBars() {
  const { sessionExpiresAt, sessionLost, sendNow } = useDriverApp();
  const snapshot = useQueueSnapshot();
  const online = useOnline();
  const now = useMinuteClock();
  const session = now === null ? null : sessionNotice(sessionExpiresAt, now, sessionLost || snapshot.sessionLost === "expired");
  const sending = Object.values(snapshot.byStop).some((local) => local.phase === "sending");

  return (
    <>
      {session?.kind === "expired" || snapshot.sessionLost === "password" ? (
        <div role="alert" className="flex items-center gap-3 bg-red-700 px-4 py-2 text-white">
          <KeyRound aria-hidden className="size-5 shrink-0" />
          <p className="min-w-0 flex-1 text-sm font-semibold">
            {snapshot.sessionLost === "password" ? "Choisissez votre mot de passe" : "Session expirée"}
            {snapshot.pending > 0 ? (
              <span className="block font-normal">
                {plural(snapshot.pending, "statut sera envoyé", "statuts seront envoyés")} après la connexion.
              </span>
            ) : null}
          </p>
          <Link
            href={snapshot.sessionLost === "password" ? "/chauffeur/mot-de-passe" : "/login"}
            className={cn(barButton, "bg-white text-red-800 hover:bg-red-50 focus-visible:outline-white")}
          >
            {snapshot.sessionLost === "password" ? "Continuer" : "Se reconnecter"}
          </Link>
        </div>
      ) : session?.kind === "ending" ? (
        <div role="status" className="flex items-start gap-2 bg-amber-300 px-4 py-2 text-sm text-amber-950">
          <KeyRound aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p>
            <span className="font-semibold">Session valable jusqu&apos;à {session.until}</span> : elle se prolonge dès que
            l&apos;application retrouve le réseau ; sinon, reconnectez-vous.
          </p>
        </div>
      ) : null}

      {!online ? (
        <div role="status" className="flex items-start gap-2 bg-amber-400 px-4 py-2 text-sm text-amber-950">
          <WifiOff aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p>
            <span className="font-semibold">
              Hors connexion
              {snapshot.pending > 0 ? ` · ${plural(snapshot.pending, "statut en attente", "statuts en attente")}` : ""}
            </span>
            <span className="block">
              {snapshot.volatile && snapshot.pending > 0
                ? "Statuts gardés jusqu'au retour du réseau : ne fermez pas l'application."
                : "Statuts gardés sur le téléphone, envoyés au retour du réseau."}
            </span>
          </p>
        </div>
      ) : snapshot.pending > 0 && snapshot.sessionLost === null ? (
        <div role="status" className="flex items-center gap-3 bg-amber-100 px-4 py-2 text-amber-950">
          {sending ? (
            <LoaderCircle aria-hidden className="size-5 shrink-0 animate-spin" />
          ) : (
            <CloudUpload aria-hidden className="size-5 shrink-0" />
          )}
          <p className="min-w-0 flex-1 text-sm">
            <span className="font-semibold">{plural(snapshot.pending, "statut en attente", "statuts en attente")}</span>
            <span className="block">
              {sending
                ? "Envoi en cours…"
                : snapshot.volatile
                  ? "Gardés jusqu'à l'envoi : ne fermez pas l'application."
                  : "Gardés sur le téléphone, envoyés au retour du réseau."}
            </span>
          </p>
          {sending ? null : (
            <button
              type="button"
              onClick={sendNow}
              className={cn(barButton, "border border-amber-400 bg-white text-amber-950 hover:bg-amber-50 focus-visible:outline-amber-700")}
            >
              Envoyer
            </button>
          )}
        </div>
      ) : null}

      {snapshot.refusals.length > 0 ? <RefusalBar /> : null}
    </>
  );
}

function RefusalBar() {
  const { queue } = useDriverApp();
  const { refusals } = useQueueSnapshot();
  return (
    <div role="alert" className="space-y-2 border-y border-red-300 bg-red-50 px-4 py-2 text-red-950">
      <p className="flex items-center gap-2 text-sm font-semibold">
        <TriangleAlert aria-hidden className="size-4 shrink-0 text-red-700" />
        {refusals.length > 1 ? `${refusals.length} statuts non enregistrés` : "Statut non enregistré"}
      </p>
      <ul className="space-y-1 text-sm">
        {refusals.map((refusal) => (
          <li key={refusal.id}>
            <span className="font-semibold">{STOP_ACTION_LABELS[refusal.action]}</span> : {refusal.error}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => queue.dismissRefusals()}
        className={cn(barButton, "w-full border border-red-300 bg-white text-red-900 hover:bg-red-100 focus-visible:outline-red-700")}
      >
        J&apos;ai compris
      </button>
    </div>
  );
}

/** « Session valable jusqu'à HH:MM », at the bottom of the roadmap. */
export function SessionLine() {
  const { sessionExpiresAt, sessionLost } = useDriverApp();
  const now = useMinuteClock();
  if (now === null) return null;
  const notice = sessionNotice(sessionExpiresAt, now, sessionLost);
  if (notice.kind !== "valid" && notice.kind !== "ending") return null;
  return (
    <p className="text-center text-sm text-slate-600">
      Session valable jusqu&apos;à <span className="tabular font-semibold text-slate-800">{notice.until}</span>
    </p>
  );
}
