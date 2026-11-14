"use client";

/**
 * « Signaler à la régulation » on a stop (DAY-05): from an outbound drop-off, the end of the session (« Patient prêt
 * à HH:MM », earlier or later than planned), a return asked for when none is planned, the cancellation of the return,
 * the next session of the series; from a pickup still to do, its cancellation. Sent at once
 * (POST /api/chauffeur/stops/:id/requests), online only: without network the crew calls the regulation. Never a free
 * text: a time, a date, a reason from a list. What was sent shows on the stop with where it stands.
 */
import { useState, useTransition, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { MessageSquareShare, Send } from "lucide-react";
import { cn } from "@/components/ui/cn";
import type { FieldRequestResponse } from "@/app/api/chauffeur/stops/[id]/requests/route";
import { FIELD_CANCEL_REASON_LABELS, FIELD_CANCEL_REASONS, type FieldCancelReason } from "@/lib/domain/field-requests";
import { formatMinute, parseMinute } from "@/lib/time";
import { serverReachable } from "../_lib/reachability";
import type { StopFieldView } from "../_lib/view";
import { useDriverApp } from "./driver-app";

type RequestBody = {
  kind: "READY_TIME" | "CANCEL" | "RETURN" | "NEXT_SESSION";
  readyMinute?: number;
  reason?: FieldCancelReason;
  nextSessionDate?: string;
  target?: "return";
};

const field = "min-h-12 rounded-xl border border-field bg-white px-3 text-base text-slate-900 focus-visible:outline-2 focus-visible:outline-brand-600";
const secondary =
  "inline-flex min-h-12 touch-manipulation items-center justify-center rounded-xl border border-slate-300 bg-white px-3 text-base font-semibold text-slate-800 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-60";
const primary =
  "inline-flex min-h-12 touch-manipulation items-center justify-center gap-2 rounded-xl bg-brand-700 px-4 text-base font-semibold text-white hover:bg-brand-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-60";

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-semibold text-slate-900">{title}</legend>
      {children}
    </fieldset>
  );
}

/** A time of the day typed in the form (« 11:20 »), shifted by `minutes` and kept within the day. */
function shifted(value: string, minutes: number): string {
  const minute = parseMinute(value);
  if (minute === null) return value;
  return formatMinute(Math.min(24 * 60 - 1, Math.max(0, minute + minutes)));
}

function ReadyForm({ initial, busy, onSend }: { initial: number | null; busy: boolean; onSend: (body: RequestBody) => void }) {
  const [value, setValue] = useState(initial !== null ? formatMinute(initial) : "");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const minute = parseMinute(value);
    if (minute !== null) onSend({ kind: "READY_TIME", readyMinute: minute });
  };
  return (
    <form onSubmit={submit}>
      <Block title="Fin de séance">
        <p className="text-sm text-slate-600">
          {initial !== null ? (
            <>
              Prévue à <span className="tabular font-semibold">{formatMinute(initial)}</span>. Le patient sort plus tôt ou plus tard&nbsp;?
            </>
          ) : (
            "Heure à laquelle le patient sera prêt pour le retour."
          )}
        </p>
        <div className="grid grid-cols-[1fr_auto_auto] gap-2">
          <label className="sr-only" htmlFor="ready-time">
            Patient prêt à
          </label>
          <input id="ready-time" type="time" step={300} required value={value} onChange={(e) => setValue(e.target.value)} className={cn(field, "tabular")} />
          <button type="button" className={secondary} onClick={() => setValue((v) => shifted(v, -15))} aria-label="15 minutes plus tôt">
            −15
          </button>
          <button type="button" className={secondary} onClick={() => setValue((v) => shifted(v, 15))} aria-label="15 minutes plus tard">
            +15
          </button>
        </div>
        <button type="submit" disabled={busy || parseMinute(value) === null} className={cn(primary, "w-full")}>
          <Send aria-hidden className="size-4" />
          Patient prêt à {parseMinute(value) !== null ? value : "…"}
        </button>
      </Block>
    </form>
  );
}

function AskReturnForm({ busy, onSend }: { busy: boolean; onSend: (body: RequestBody) => void }) {
  const [value, setValue] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const minute = parseMinute(value);
    if (minute !== null) onSend({ kind: "RETURN", readyMinute: minute });
  };
  return (
    <form onSubmit={submit}>
      <Block title="Demander un retour">
        <p className="text-sm text-slate-600">Aucun retour n&apos;est prévu pour ce patient aujourd&apos;hui. La régulation valide la demande.</p>
        <div className="grid grid-cols-[auto_1fr] items-center gap-2">
          <label htmlFor="return-time" className="text-sm font-medium text-slate-800">
            Prêt à
          </label>
          <input id="return-time" type="time" step={300} required value={value} onChange={(e) => setValue(e.target.value)} className={cn(field, "tabular")} />
        </div>
        <button type="submit" disabled={busy || parseMinute(value) === null} className={cn(primary, "w-full")}>
          <Send aria-hidden className="size-4" />
          Demander le retour
        </button>
      </Block>
    </form>
  );
}

function CancelForm({ target, busy, onSend }: { target: "return" | "trip"; busy: boolean; onSend: (body: RequestBody) => void }) {
  const [reason, setReason] = useState<FieldCancelReason | "">("");
  const id = `cancel-reason-${target}`;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (reason) onSend({ kind: "CANCEL", reason, ...(target === "return" ? { target: "return" as const } : {}) });
  };
  return (
    <form onSubmit={submit}>
      <Block title={target === "return" ? "Annuler le retour" : "Motif de la demande"}>
        <p className="text-sm text-slate-600">La régulation valide la demande avant toute annulation.</p>
        <label htmlFor={id} className="sr-only">
          Motif
        </label>
        <select id={id} required value={reason} onChange={(e) => setReason(e.target.value as FieldCancelReason)} className={cn(field, "w-full")}>
          <option value="">Choisir le motif…</option>
          {FIELD_CANCEL_REASONS.map((value) => (
            <option key={value} value={value}>
              {FIELD_CANCEL_REASON_LABELS[value]}
            </option>
          ))}
        </select>
        <button type="submit" disabled={busy || !reason} className={cn(secondary, "w-full text-red-800")}>
          Demander l&apos;annulation
        </button>
      </Block>
    </form>
  );
}

function NextSessionForm({ min, busy, onSend }: { min: string | null; busy: boolean; onSend: (body: RequestBody) => void }) {
  const [value, setValue] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value) onSend({ kind: "NEXT_SESSION", nextSessionDate: value });
  };
  return (
    <form onSubmit={submit}>
      <Block title="Prochaine séance">
        <p className="text-sm text-slate-600">Date donnée par le patient ou l&apos;accueil, transmise à la régulation.</p>
        <label htmlFor="next-session" className="sr-only">
          Date de la prochaine séance
        </label>
        <input id="next-session" type="date" required min={min ?? undefined} value={value} onChange={(e) => setValue(e.target.value)} className={cn(field, "w-full")} />
        <button type="submit" disabled={busy || !value} className={cn(secondary, "w-full")}>
          Transmettre la date
        </button>
      </Block>
    </form>
  );
}

/** « Fin de séance, prochaine séance, annuler le retour »: what the block offers, said on its summary. */
export function requestsSummary(view: StopFieldView): string {
  const parts = [
    view.signalReady ? "fin de séance" : null,
    view.askReturn ? "demander un retour" : null,
    view.nextSession ? "prochaine séance" : null,
    view.cancelReturn ? "annuler le retour" : null,
    view.askCancel ? "demander l'annulation" : null,
  ].filter((part): part is string => part !== null);
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function StopRequests({ stopId, view }: { stopId: string; view: StopFieldView }) {
  const router = useRouter();
  const { ownerId } = useDriverApp();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [, startTransition] = useTransition();
  const hasForms = view.signalReady || view.askReturn || view.cancelReturn || view.askCancel || view.nextSession;

  const send = async (body: RequestBody) => {
    setBusy(true);
    setMessage(null);
    try {
      if (navigator.onLine === false) throw new Error("offline");
      const response = await fetch(`/api/chauffeur/stops/${encodeURIComponent(stopId)}/requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, ownerId }),
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      });
      const answer = (await response.json().catch(() => null)) as FieldRequestResponse | null;
      if (!answer) throw new Error("unreadable");
      setMessage(answer.ok ? { ok: true, text: answer.message } : { ok: false, text: answer.error });
      if (answer.ok || answer.code === "conflict") {
        if (await serverReachable()) startTransition(() => router.refresh());
      }
    } catch {
      setMessage({ ok: false, text: "Pas de réseau\u00a0: rien n'a été envoyé. Réessayez, ou appelez la régulation." });
    } finally {
      setBusy(false);
    }
  };

  if (!hasForms && view.sent.length === 0) return null;
  return (
    <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
      {view.sent.map((text) => (
        <p key={text} className="flex items-start gap-2 text-sm text-slate-800">
          <MessageSquareShare aria-hidden className="mt-0.5 size-4 shrink-0 text-brand-700" />
          <span>{text}</span>
        </p>
      ))}
      {message ? (
        <p role="status" className={cn("rounded-lg px-3 py-2 text-sm font-medium", message.ok ? "bg-emerald-50 text-emerald-900" : "bg-red-50 text-red-900")}>
          {message.text}
        </p>
      ) : null}
      {hasForms ? (
        <details className="group">
          <summary className="flex min-h-11 cursor-pointer touch-manipulation list-none items-center gap-2 text-base font-semibold text-brand-800 focus-visible:outline-2 focus-visible:outline-brand-600 [&::-webkit-details-marker]:hidden">
            <MessageSquareShare aria-hidden className="size-5" />
            {requestsSummary(view)}
          </summary>
          <div className="space-y-5 pt-3">
            {view.signalReady ? <ReadyForm initial={view.readyMinute} busy={busy} onSend={send} /> : null}
            {view.askReturn ? <AskReturnForm busy={busy} onSend={send} /> : null}
            {view.nextSession ? <NextSessionForm min={view.nextSessionMin} busy={busy} onSend={send} /> : null}
            {view.cancelReturn ? <CancelForm target="return" busy={busy} onSend={send} /> : null}
            {view.askCancel ? <CancelForm target="trip" busy={busy} onSend={send} /> : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}
