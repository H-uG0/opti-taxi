"use client";

/**
 * Signals of a stop still to do (FLD-01), sent at once to the regulation (POST /api/chauffeur/stops/:id/requests,
 * online only like DAY-05's requests):
 * - « Retard +10 / +20 / +30 » on the next stop: the day's follow-up moves the route's estimated times from it;
 * - « Patient pas prêt » on a pickup the crew has reached: it waits at the door, the regulator is told.
 * What was sent shows on the stop with where it stands.
 */
import { Hourglass, MessageSquareShare, Timer } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { LATE_SIGNAL_MINUTES } from "@/lib/domain/field-requests";
import { localArrival } from "../_lib/status-queue";
import type { StopSignalsView } from "../_lib/view";
import { useQueueSnapshot } from "./driver-app";
import { useFieldRequest } from "./use-field-request";

const button =
  "inline-flex min-h-12 touch-manipulation items-center justify-center gap-1.5 rounded-xl border px-3 text-base font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-60";

export function StopSignals({
  stopId,
  view,
  arrivedAt,
}: {
  stopId: string;
  view: StopSignalsView;
  /** « Arrivé » recorded on the server (epoch ms): once at the pickup, « Patient pas prêt » is offered. */
  arrivedAt: number | null;
}) {
  const { busy, message, send } = useFieldRequest(stopId);
  const { byStop } = useQueueSnapshot();
  const notReady = view.notReady && localArrival(arrivedAt, byStop[stopId]) !== null;
  if (!view.late && !notReady && view.sent.length === 0 && !message) return null;
  return (
    <div className="space-y-2">
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
      {notReady ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void send({ kind: "NOT_READY" })}
          className={cn(button, "w-full border-amber-400 bg-white text-amber-950 hover:bg-amber-50")}
        >
          <Hourglass aria-hidden className="size-5" />
          Patient pas prêt
        </button>
      ) : null}
      {view.late ? (
        <div role="group" aria-label="Signaler un retard à la régulation" className="grid grid-cols-[auto_1fr_1fr_1fr] items-center gap-2">
          <span className="flex items-center gap-1 text-sm font-semibold text-slate-700">
            <Timer aria-hidden className="size-4" />
            Retard
          </span>
          {LATE_SIGNAL_MINUTES.map((minutes) => (
            <button
              key={minutes}
              type="button"
              disabled={busy}
              onClick={() => void send({ kind: "LATE", lateMinutes: minutes })}
              aria-label={`Signaler un retard de ${minutes} minutes`}
              className={cn(button, "tabular border-slate-300 bg-white text-slate-900 hover:bg-slate-50")}
            >
              +{minutes}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
