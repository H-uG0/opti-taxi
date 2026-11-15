"use client";

/**
 * « Corriger un statut » in the trip panel (FLD-02): on a day started or past, the regulator records a status the crew
 * forgot or fixes a wrong one, with the real time and a reason from a list (status-correction-actions.ts). The stop,
 * the status it ends with, its time (the one recorded, else the planned one), the reason; « Patient absent » asks the
 * absence's reason too.
 */
import { useId, useState } from "react";
import { PencilLine } from "lucide-react";
import type { NoShowReason, StatusCorrectionReason, StopKind } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { NO_SHOW_REASON_LABELS, NO_SHOW_REASONS } from "@/lib/domain/field-wait";
import {
  CORRECTION_REASON_LABELS,
  CORRECTION_REASONS,
  CORRECTION_TARGET_LABELS,
  correctionTargets,
  type CorrectionTarget,
} from "@/lib/domain/stop-correction";
import { STOP_KIND_LABELS } from "@/lib/labels";
import { formatMinute } from "@/lib/time";
import { correctStopStatus } from "./status-correction-actions";
import { usePlanningActivity } from "./planning-activity";

export type CorrectableStop = {
  id: string;
  kind: StopKind;
  /** The status it shows now. */
  current: CorrectionTarget;
  /** Recorded minute, else the planned start: the time field's default. */
  minute: number;
};

export function StatusCorrection({ stops, patient }: { stops: readonly CorrectableStop[]; patient: string }) {
  const { busy, run } = usePlanningActivity();
  const [open, setOpen] = useState(false);
  const [stopId, setStopId] = useState(stops[0]?.id ?? "");
  const stop = stops.find((s) => s.id === stopId) ?? stops[0];
  const [target, setTarget] = useState<CorrectionTarget>(() => (stop ? correctionTargets(stop.kind)[0]! : "NONE"));
  const [time, setTime] = useState(() => formatMinute(stop?.minute ?? 480));
  const [reason, setReason] = useState<StatusCorrectionReason | "">("");
  const [absence, setAbsence] = useState<NoShowReason | "">("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const ids = { stop: useId(), target: useId(), time: useId(), reason: useId(), absence: useId() };
  if (!stop) return null;

  const chooseStop = (id: string) => {
    const next = stops.find((s) => s.id === id);
    if (!next) return;
    setStopId(id);
    setTarget(correctionTargets(next.kind)[0]!);
    setTime(formatMinute(next.minute));
    setRefusal(null);
  };

  if (!open) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
        <p className="min-w-0 flex-1 text-xs text-slate-600">Statut oublié ou erroné&nbsp;: corrigez-le avec l&apos;heure réelle et un motif.</p>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => setOpen(true)}>
          <PencilLine aria-hidden className="size-3.5" />
          Corriger un statut…
        </Button>
      </div>
    );
  }

  const submit = () => {
    setRefusal(null);
    run(`Correction du statut de ${patient}…`, () => correctStopStatus({ stopId: stop.id, target, time, reason, noShowReason: absence || null }), {
      onResult: (result) => {
        if (!result.ok) {
          setRefusal(result.error);
          return;
        }
        setOpen(false);
        setReason("");
        setAbsence("");
      },
    });
  };

  return (
    <form
      className="space-y-2.5 border-t border-slate-100 bg-slate-50/60 px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="text-sm font-medium text-slate-900">Corriger un statut</p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor={ids.stop} className="text-xs font-medium text-slate-700">
            Arrêt
          </label>
          <Select id={ids.stop} value={stop.id} onChange={(e) => chooseStop(e.target.value)} disabled={busy} className="mt-1">
            {stops.map((s) => (
              <option key={s.id} value={s.id}>
                {STOP_KIND_LABELS[s.kind]} ({CORRECTION_TARGET_LABELS[s.current].toLowerCase()})
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label htmlFor={ids.target} className="text-xs font-medium text-slate-700">
            Statut
          </label>
          <Select id={ids.target} value={target} onChange={(e) => setTarget(e.target.value as CorrectionTarget)} disabled={busy} className="mt-1">
            {correctionTargets(stop.kind).map((value) => (
              <option key={value} value={value}>
                {CORRECTION_TARGET_LABELS[value]}
              </option>
            ))}
          </Select>
        </div>
        {target !== "NONE" ? (
          <div>
            <label htmlFor={ids.time} className="text-xs font-medium text-slate-700">
              Heure réelle
            </label>
            <Input
              id={ids.time}
              type="time"
              required
              value={time}
              onChange={(e) => setTime(e.target.value)}
              disabled={busy}
              className="mt-1 tabular-nums"
            />
          </div>
        ) : null}
        {target === "NO_SHOW" ? (
          <div>
            <label htmlFor={ids.absence} className="text-xs font-medium text-slate-700">
              Motif de l&apos;absence
            </label>
            <Select id={ids.absence} required value={absence} onChange={(e) => setAbsence(e.target.value as NoShowReason)} disabled={busy} className="mt-1">
              <option value="">Choisir…</option>
              {NO_SHOW_REASONS.map((value) => (
                <option key={value} value={value}>
                  {NO_SHOW_REASON_LABELS[value]}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
      </div>
      <div>
        <label htmlFor={ids.reason} className="text-xs font-medium text-slate-700">
          Motif de la correction (obligatoire)
        </label>
        <Select id={ids.reason} required value={reason} onChange={(e) => setReason(e.target.value as StatusCorrectionReason)} disabled={busy} className="mt-1">
          <option value="">Choisir…</option>
          {CORRECTION_REASONS.map((value) => (
            <option key={value} value={value}>
              {CORRECTION_REASON_LABELS[value]}
            </option>
          ))}
        </Select>
      </div>
      {refusal ? (
        <p role="alert" className="text-sm text-red-800">
          {refusal}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setRefusal(null);
          }}
        >
          Annuler
        </Button>
        <Button type="submit" size="sm" variant="primary" disabled={busy || !reason || (target === "NO_SHOW" && !absence)}>
          Enregistrer la correction
        </Button>
      </div>
      <p className="text-xs text-slate-500">La correction est tracée (auteur, heure, motif) et l&apos;équipage la voit sur sa feuille de route.</p>
    </form>
  );
}
