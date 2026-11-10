"use client";

import { useActionState, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useFormStatus } from "react-dom";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormMessage, Input, Select } from "@/components/ui/form";
import { Table, TBody, THead, Th } from "@/components/ui/table";
import { CANCELLATION_NOTE_MAX, CANCELLATION_REASON_LABELS, USER_CANCELLATION_REASONS } from "@/lib/domain/cancellation";
import { cancelTrips } from "./actions";
import { INITIAL_ACTION_RESULT, type ActionResult } from "./trip-form";
import { plural } from "./trip-list";
import { TripRow, type TripRowData } from "./trip-row";
import { canCancel } from "./trip-rules";

/**
 * The trips of the day with a box per trip that can still be cancelled, and
 * « Annuler la sélection » (a reason for all, each trip cancelled and traced
 * on its own) in a bar pinned to the bottom of the screen while trips are ticked.
 */
export function TripTable({ rows, caption }: { rows: TripRowData[]; caption: string }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [state, formAction] = useActionState(cancelTrips, INITIAL_ACTION_RESULT);
  const [dismissed, setDismissed] = useState<ActionResult | null>(null);
  const cancellable = rows.filter((row) => canCancel(row.status));
  // A trip no longer shown (filter) or no longer open (cancelled by the bar, the page refreshed with the result) leaves the selection.
  const shown = new Set(cancellable.map((row) => row.id));
  const picked = [...selected].filter((id) => shown.has(id));
  const all = cancellable.length > 0 && picked.length === cancellable.length;
  const headerBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerBox.current) headerBox.current.indeterminate = picked.length > 0 && !all;
  }, [picked.length, all]);

  const toggle = (id: string, on: boolean) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <div className="space-y-3">
      <Table stickyHeader>
        <caption className="sr-only">{caption}</caption>
        <THead>
          <tr>
            <Th className="w-10 pr-0">
              <input
                ref={headerBox}
                type="checkbox"
                aria-label={all ? "Désélectionner toutes les courses affichées" : "Sélectionner toutes les courses affichées qui peuvent être annulées"}
                checked={all}
                disabled={cancellable.length === 0}
                onChange={(event) => setSelected(event.target.checked ? new Set(cancellable.map((row) => row.id)) : new Set())}
                className="size-4 rounded border-slate-300 accent-brand-700"
              />
            </Th>
            <Th>Heure</Th>
            <Th>Patient</Th>
            <Th>Trajet</Th>
            <Th className="hidden 2xl:table-cell">Types · payeur</Th>
            <Th>Statut</Th>
            <Th>Véhicule</Th>
            <Th>Partage</Th>
            <Th className="sticky right-0 bg-slate-50">
              <span className="sr-only">Détails</span>
            </Th>
          </tr>
        </THead>
        <TBody>
          {rows.map((row) => (
            <TripRow
              key={row.id}
              trip={row}
              selection={canCancel(row.status) ? { checked: selected.has(row.id), onChange: (on) => toggle(row.id, on) } : null}
            />
          ))}
        </TBody>
      </Table>
      {picked.length > 0 ? (
        <BulkCancelBar tripIds={picked} rows={rows} action={formAction} result={state} onClear={() => setSelected(new Set())} />
      ) : state.message && state.ok && dismissed !== state ? (
        <div className="sticky bottom-0 z-20 flex items-start gap-2 rounded-t-lg border border-b-0 border-slate-200 bg-white/95 px-4 py-3 shadow-[0_-4px_12px_-6px_rgb(15_23_42/0.15)] backdrop-blur">
          <div className="flex-1">
            <FormMessage tone="success">{state.message}</FormMessage>
          </div>
          <Button variant="ghost" size="sm" aria-label="Fermer le message" onClick={() => setDismissed(state)}>
            <X aria-hidden className="size-4" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** « Annuler la sélection » : a reason and a note for all, then a confirmation that says what will happen. */
function BulkCancelBar({
  tripIds,
  rows,
  action,
  result,
  onClear,
}: {
  tripIds: string[];
  rows: TripRowData[];
  action: (formData: FormData) => void;
  /** The result of the last « Annuler » (some trips may be left, changed meanwhile). */
  result: ActionResult;
  onClear: () => void;
}) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  // The question is for this selection: ticking or unticking a trip asks it again.
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);
  const reasonId = useId();
  const noteId = useId();
  const count = tripIds.length;
  const inRoutes = rows.filter((row) => tripIds.includes(row.id) && row.vehicleLabel !== null).length;
  const shared = rows.filter((row) => tripIds.includes(row.id) && row.shared).length;
  const ids = tripIds.join(",");
  const confirming = confirmedFor === ids;
  const setConfirming = (on: boolean) => setConfirmedFor(on ? ids : null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    if (!confirming) {
      event.preventDefault();
      setConfirming(true);
    }
  };

  return (
    <form
      action={(formData) => {
        setConfirming(false);
        action(formData);
      }}
      onSubmit={submit}
      aria-label="Annuler les courses sélectionnées"
      className="sticky bottom-0 z-20 space-y-2 rounded-t-lg border border-b-0 border-slate-200 bg-white/95 px-4 py-3 shadow-[0_-4px_12px_-6px_rgb(15_23_42/0.15)] backdrop-blur"
    >
      {tripIds.map((id) => (
        <input key={id} type="hidden" name="tripId" value={id} />
      ))}
      <div className="flex flex-wrap items-end gap-3">
        <p className="self-center text-sm font-semibold text-slate-900">{plural(count, "course sélectionnée", "courses sélectionnées")}</p>
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
            placeholder="Ex. centre fermé (panne)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        {confirming ? null : (
          <div className="flex items-center gap-2">
            <Button type="submit" variant="secondary" className="text-red-700 hover:bg-red-50">
              <X aria-hidden className="size-4" />
              {count > 1 ? `Annuler les ${count} courses` : "Annuler la course"}
            </Button>
            <Button variant="ghost" onClick={onClear}>
              Tout désélectionner
            </Button>
          </div>
        )}
      </div>
      {confirming ? (
        <div role="group" aria-label="Confirmer l'annulation" className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2">
          <p className="mr-auto text-sm text-red-900">
            Annuler {plural(count, "course", "courses")} pour le motif « {reason ? CANCELLATION_REASON_LABELS[reason as keyof typeof CANCELLATION_REASON_LABELS] : "?"} » ?
            {inRoutes > 0 ? ` ${inRoutes > 1 ? `${inRoutes} sont retirées de leur tournée` : "Une est retirée de sa tournée"}.` : ""}
            {shared > 0 ? " Les co-passagers restés seuls ne sont plus en transport partagé." : ""} Chaque course garde son motif et
            l&apos;annulation est tracée course par course. Un retour non coché n&apos;est pas annulé.
          </p>
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            Ne pas annuler
          </Button>
          <ConfirmButton count={count} />
        </div>
      ) : null}
      {result.message ? <FormMessage tone={result.ok ? "success" : "error"}>{result.message}</FormMessage> : null}
    </form>
  );
}

function ConfirmButton({ count }: { count: number }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="danger" disabled={pending} aria-busy={pending} autoFocus>
      {pending ? "Annulation…" : `Confirmer l'annulation${count > 1 ? ` des ${count} courses` : ""}`}
    </Button>
  );
}
