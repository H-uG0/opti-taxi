"use client";

/**
 * A stop left without a status, on « Fin de tournée » (FLD-02): the crew enters what happened and when (the real
 * time, the planned one by default), and for an absence its reason. It goes through the status queue like any status
 * (offline too), with the time typed (declaredMinute) instead of the gesture's: the server checks the day is still
 * open (until 03:00 the next day) and that the time keeps the route's statuses in their order.
 */
import { useId, useState } from "react";
import type { NoShowReason, StopKind } from "@prisma/client";
import { Save } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { NO_SHOW_REASON_LABELS, NO_SHOW_REASONS } from "@/lib/domain/field-wait";
import { STOP_KIND_LABELS } from "@/lib/labels";
import { formatMinute, parseMinute } from "@/lib/time";
import { useDriverApp, useQueueSnapshot } from "./driver-app";
import { ActionError, LocalStatusPanel, useRefusal } from "./stop-actions";

type Outcome = "PICKUP" | "DROPOFF" | "NO_SHOW";

const OUTCOME_LABELS: Record<Outcome, string> = { PICKUP: "Pris en charge", DROPOFF: "Déposé", NO_SHOW: "Patient absent" };

const field = "min-h-12 rounded-xl border border-field bg-white px-3 text-base text-slate-900 focus-visible:outline-2 focus-visible:outline-brand-600";

export function LateEntry({
  stopId,
  kind,
  plannedMinute,
  patient,
  town,
  pickupStopId,
}: {
  stopId: string;
  kind: StopKind;
  plannedMinute: number;
  patient: string;
  town: string | null;
  /** A drop-off whose pickup is left without a status too: entered first. */
  pickupStopId: string | null;
}) {
  const { submit } = useDriverApp();
  const { byStop } = useQueueSnapshot();
  const refusal = useRefusal(stopId);
  const id = useId();
  const outcomes: Outcome[] = kind === "PICKUP" ? ["PICKUP", "NO_SHOW"] : ["DROPOFF"];
  const [outcome, setOutcome] = useState<Outcome>(outcomes[0]!);
  const [time, setTime] = useState(formatMinute(plannedMinute));
  const [reason, setReason] = useState<NoShowReason | "">("");
  const local = byStop[stopId];
  const pickupLocal = pickupStopId ? byStop[pickupStopId] : undefined;
  const waitsForPickup = pickupStopId !== null && pickupLocal?.action !== "PICKUP";
  const minute = parseMinute(time);
  const ready = minute !== null && !waitsForPickup && (outcome !== "NO_SHOW" || reason !== "");

  return (
    <li className="space-y-3 rounded-2xl border border-slate-300 bg-white p-4">
      <div>
        <p className="flex flex-wrap items-baseline gap-x-2 text-base">
          <span className="tabular text-xl font-bold text-slate-950">{formatMinute(plannedMinute)}</span>
          <span className="font-semibold text-slate-800">{STOP_KIND_LABELS[kind]}</span>
          {town ? <span className="text-sm text-slate-600">· {town}</span> : null}
        </p>
        <p className="text-lg font-semibold text-slate-950">{patient}</p>
      </div>
      {local && local.action !== "UNDO" ? (
        <LocalStatusPanel stopId={stopId} local={local} />
      ) : (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready || minute === null) return;
            submit(stopId, outcome, { declaredMinute: minute, ...(outcome === "NO_SHOW" && reason ? { reason } : {}) });
          }}
        >
          {outcomes.length > 1 ? (
            <fieldset className="grid grid-cols-2 gap-2">
              <legend className="sr-only">Ce qui s&apos;est passé</legend>
              {outcomes.map((value) => (
                <label
                  key={value}
                  className={cn(
                    "flex min-h-12 cursor-pointer touch-manipulation items-center justify-center gap-2 rounded-xl border px-2 text-base font-semibold",
                    outcome === value
                      ? value === "NO_SHOW"
                        ? "border-red-700 bg-red-50 text-red-900 ring-2 ring-red-700"
                        : "border-brand-700 bg-brand-50 text-brand-900 ring-2 ring-brand-700"
                      : "border-slate-300 bg-white text-slate-800",
                  )}
                >
                  <input type="radio" name={`${id}-outcome`} value={value} checked={outcome === value} onChange={() => setOutcome(value)} className="sr-only" />
                  {OUTCOME_LABELS[value]}
                </label>
              ))}
            </fieldset>
          ) : null}
          <div className="grid grid-cols-[auto_1fr] items-center gap-2">
            <label htmlFor={`${id}-time`} className="text-sm font-medium text-slate-800">
              Heure réelle
            </label>
            <input id={`${id}-time`} type="time" required value={time} onChange={(e) => setTime(e.target.value)} className={cn(field, "tabular")} />
          </div>
          {outcome === "NO_SHOW" ? (
            <div className="grid grid-cols-[auto_1fr] items-center gap-2">
              <label htmlFor={`${id}-reason`} className="text-sm font-medium text-slate-800">
                Motif
              </label>
              <select id={`${id}-reason`} required value={reason} onChange={(e) => setReason(e.target.value as NoShowReason)} className={field}>
                <option value="">Choisir…</option>
                {NO_SHOW_REASONS.map((value) => (
                  <option key={value} value={value}>
                    {NO_SHOW_REASON_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {waitsForPickup ? <p className="text-sm font-medium text-slate-600">Saisissez d&apos;abord la prise en charge de ce patient.</p> : null}
          <button
            type="submit"
            disabled={!ready}
            className="inline-flex min-h-12 w-full touch-manipulation items-center justify-center gap-2 rounded-xl bg-brand-700 px-4 text-base font-semibold text-white hover:bg-brand-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:bg-slate-300 disabled:text-slate-600"
          >
            <Save aria-hidden className="size-5" />
            Enregistrer «&#x202F;{OUTCOME_LABELS[outcome]}&#x202F;» à {minute !== null ? formatMinute(minute) : "…"}
          </button>
        </form>
      )}
      {refusal ? <ActionError message={refusal} /> : null}
    </li>
  );
}
