"use client";

/**
 * Header bars of the driver app (sticky, under the call button): no network,
 * statuses waiting to be sent, statuses the server refused, and the session
 * about to end or ended. And the « Session valable jusqu'à HH:MM » line of
 * the page. They stay short (the roadmap is read through what is left of the
 * screen): a refusal is one line in the header, its detail is on the stop's
 * card and in the list « Voir » opens.
 */
import { useId, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { CloudUpload, KeyRound, LoaderCircle, TriangleAlert, WifiOff } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { DRIVER_MAX_SESSION_DAYS } from "@/lib/auth/session-renewal";
import { formatMinute, minuteOfDay } from "@/lib/time";
import { sessionNotice } from "../_lib/session-notice";
import type { Refusal } from "../_lib/status-queue";
import type { StopAction } from "../_lib/transitions";
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
export function useOnline(): boolean {
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

/** Where the waiting statuses are, agreed with their number (none, one or several). */
function keptSentence(pending: number, volatile: boolean, online: boolean): string {
  const many = pending > 1;
  if (volatile && pending > 0) {
    return `${many ? "Gardés" : "Gardé"} ${online ? "jusqu'à l'envoi" : "jusqu'au retour du réseau"}\u00a0: ne fermez pas l'application.`;
  }
  if (pending === 0) return "Les statuts saisis restent sur le téléphone jusqu'au retour du réseau.";
  return many ? "Gardés sur le téléphone, envoyés au retour du réseau." : "Gardé sur le téléphone, envoyé au retour du réseau.";
}

export function FieldStatusBars() {
  const { sessionExpiresAt, sessionRenewable, sessionLost, sendNow, lastRenderAt } = useDriverApp();
  const snapshot = useQueueSnapshot();
  const online = useOnline();
  const now = useMinuteClock();
  const session = now === null ? null : sessionNotice(sessionExpiresAt, now, sessionLost || snapshot.sessionLost === "expired");
  const sending = Object.values(snapshot.byStop).some((local) => local.phase === "sending");
  const password = snapshot.sessionLost === "password";

  return (
    <>
      {session?.kind === "expired" || password ? (
        <div role="alert" className="flex items-center gap-3 bg-red-700 px-4 py-2 text-white">
          <KeyRound aria-hidden className="size-5 shrink-0" />
          <p className="min-w-0 flex-1 text-sm font-semibold">
            {password ? "Choisissez votre mot de passe" : "Session expirée"}
            {snapshot.pending > 0 ? (
              <span className="block font-normal">
                {plural(snapshot.pending, "statut sera envoyé", "statuts seront envoyés")} après la connexion.
              </span>
            ) : null}
            {/* The sign-in page is outside the app (no offline page there): wait for the network. */}
            {online ? null : (
              <span className="block font-normal">
                {password ? "Changez-le dès le retour du réseau." : "Reconnectez-vous dès le retour du réseau."}
              </span>
            )}
          </p>
          {online ? (
            <Link
              href={password ? "/chauffeur/mot-de-passe" : "/login"}
              className={cn(barButton, "bg-white text-red-800 hover:bg-red-50 focus-visible:outline-white")}
            >
              {password ? "Continuer" : "Se reconnecter"}
            </Link>
          ) : null}
        </div>
      ) : session?.kind === "ending" ? (
        <div role="status" className="flex items-start gap-2 bg-amber-300 px-4 py-2 text-sm text-amber-950">
          <KeyRound aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p>
            <span className="font-semibold">Session valable jusqu&apos;à {session.until}</span>
            {sessionRenewable
              ? "\u00a0: elle se prolonge dès que l'application retrouve le réseau\u00a0; sinon, reconnectez-vous."
              : `\u00a0: connexion ouverte depuis ${DRIVER_MAX_SESSION_DAYS} jours, elle ne se prolonge plus. Reconnectez-vous avant.`}
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
              {keptSentence(snapshot.pending, snapshot.volatile, false)}
              {/* Trips cancelled or moved by the regulation since then are not shown. */}
              {lastRenderAt !== null ? (
                <>
                  {" "}
                  Feuille de route du dernier chargement (
                  <span className="tabular">{formatMinute(minuteOfDay(new Date(lastRenderAt)))}</span>).
                </>
              ) : null}
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
            <span className="block">{sending ? "Envoi en cours…" : keptSentence(snapshot.pending, snapshot.volatile, true)}</span>
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

/** What a refused status was, as the crew tapped it: « Annulation », never the order « Annuler ». */
const REFUSED_LABELS: Record<StopAction, { label: string; tapped: string }> = {
  PICKUP: { label: "Pris en charge", tapped: "saisi" },
  DROPOFF: { label: "Déposé", tapped: "saisi" },
  NO_SHOW: { label: "Patient absent", tapped: "saisi" },
  UNDO: { label: "Annulation", tapped: "saisie" },
};

/** « Pris en charge, saisi à 10:02 » : which status and when, to tell the regulation. */
function refusedStatusLabel(refusal: Pick<Refusal, "action" | "observedAt">): string {
  const { label, tapped } = REFUSED_LABELS[refusal.action];
  return `${label}, ${tapped} à ${formatMinute(minuteOfDay(new Date(refusal.observedAt)))}`;
}

/**
 * One line in the header (the roadmap stays readable); the reasons are on the
 * stops' cards and in the list « Voir » opens, with a link to each stop. The
 * only live announcement of a refusal (the card's message is not one).
 */
function RefusalBar() {
  const { queue } = useDriverApp();
  const { refusals } = useQueueSnapshot();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const smallButton = cn(barButton, "border border-red-300 bg-white text-red-900 hover:bg-red-100 focus-visible:outline-red-700");
  return (
    <div role="alert" className="border-y border-red-300 bg-red-50 px-4 text-red-950">
      <div className="flex items-center gap-2">
        <TriangleAlert aria-hidden className="size-4 shrink-0 text-red-700" />
        <p className="min-w-0 flex-1 text-sm font-semibold">
          {plural(refusals.length, "statut non enregistré", "statuts non enregistrés")}
        </p>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((shown) => !shown)}
          className={smallButton}
        >
          {open ? "Masquer" : "Voir"}
        </button>
        <button
          type="button"
          aria-label="OK, j'ai compris"
          onClick={() => queue.dismissRefusals()}
          className={smallButton}
        >
          OK
        </button>
      </div>
      {open ? (
        <ul id={listId} className="max-h-[40vh] space-y-2 overflow-y-auto pb-2 text-sm">
          {refusals.map((refusal) => (
            <li key={refusal.id}>
              <span className="tabular font-semibold">{refusedStatusLabel(refusal)}</span>&nbsp;: {refusal.error}{" "}
              <a
                href={`#stop-${refusal.stopId}`}
                onClick={() => setOpen(false)}
                className="font-semibold whitespace-nowrap underline underline-offset-2"
              >
                Voir l&apos;arrêt
              </a>
            </li>
          ))}
        </ul>
      ) : null}
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
