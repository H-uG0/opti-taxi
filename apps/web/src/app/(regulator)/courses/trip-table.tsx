"use client";

import { useActionState, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from "react";
import { useFormStatus } from "react-dom";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, FormMessage, Input, Select } from "@/components/ui/form";
import { Table, TBody, THead, Th } from "@/components/ui/table";
import { CANCELLATION_NOTE_MAX, CANCELLATION_REASON_LABELS, USER_CANCELLATION_REASONS } from "@/lib/domain/cancellation";
import { cancelTrips } from "./actions";
import { INITIAL_ACTION_RESULT, PENDING_LABEL, type ActionResult } from "@/lib/forms";
import { plural, type PairedReturn } from "./trip-list";
import { TripRow, type TripRowData } from "./trip-row";
import { canCancel, RETURN_GOES_TOO } from "./trip-rules";

/**
 * The trips of the day with a box per trip that can still be cancelled, and
 * « Annuler la sélection » (a reason for all, each trip cancelled and traced
 * on its own) in a bar pinned to the bottom of the screen while trips are ticked.
 * Entrée on a box goes to the bar (it is after the whole list for the keyboard).
 * Keyed by the date in the page: the selection and the last answer never follow
 * the date arrows (a client navigation keeps the page's state).
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
  const reasonField = useRef<HTMLSelectElement>(null);
  const jumpHintId = useId();
  useEffect(() => {
    if (headerBox.current) headerBox.current.indeterminate = picked.length > 0 && !all;
  }, [picked.length, all]);
  // Entrée on a box (Espace ticks it): to the reason of the bar, without going through every row.
  const jumpToBar = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || picked.length === 0) return;
    event.preventDefault();
    reasonField.current?.focus();
  };
  const describedBy = picked.length > 0 ? jumpHintId : undefined;

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
                onKeyDown={jumpToBar}
                aria-describedby={describedBy}
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
              selection={
                canCancel(row.status)
                  ? { checked: selected.has(row.id), onChange: (on) => toggle(row.id, on), onKeyDown: jumpToBar, describedBy }
                  : null
              }
            />
          ))}
        </TBody>
      </Table>
      {picked.length > 0 ? (
        <p id={jumpHintId} className="sr-only">
          Entrée&nbsp;: aller à l&apos;annulation des courses sélectionnées, en bas de la liste.
        </p>
      ) : null}
      {picked.length > 0 ? (
        <BulkCancelBar
          tripIds={picked}
          rows={rows}
          action={formAction}
          result={state}
          onClear={() => setSelected(new Set())}
          reasonField={reasonField}
        />
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

/** The open returns of the ticked outbound trips that are not ticked themselves (each once). */
export function untickedReturns(tripIds: readonly string[], rows: readonly TripRowData[]): PairedReturn[] {
  const ticked = new Set(tripIds);
  const returns = new Map<string, PairedReturn>();
  for (const row of rows) {
    const back = row.pairedReturn;
    if (ticked.has(row.id) && back && !ticked.has(back.id)) returns.set(back.id, back);
  }
  return [...returns.values()];
}

/**
 * « Annuler la sélection » : a reason and a note for all, the returns of the
 * ticked outbound trips as for one trip (« Annuler aussi les retours », ticked
 * by default for the same reasons), then a confirmation that says what will happen.
 */
function BulkCancelBar({
  tripIds,
  rows,
  action,
  result,
  onClear,
  reasonField,
}: {
  tripIds: string[];
  rows: TripRowData[];
  action: (formData: FormData) => void;
  /** The result of the last « Annuler » (some trips may be left, changed meanwhile). */
  result: ActionResult;
  onClear: () => void;
  reasonField: RefObject<HTMLSelectElement | null>;
}) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  // Null while untouched: the box follows the reason (ticked for RETURN_GOES_TOO); a click fixes it.
  const [withReturns, setWithReturns] = useState<boolean | null>(null);
  // The question is for this selection: ticking or unticking a trip asks it again.
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);
  const reasonId = useId();
  const noteId = useId();
  const returns = untickedReturns(tripIds, rows);
  const returnsTaken = returns.length > 0 && (withReturns ?? RETURN_GOES_TOO.has(reason));
  const ids = returnsTaken ? [...tripIds, ...returns.map((r) => r.id)] : tripIds;
  const count = ids.length;
  const ticked = rows.filter((row) => tripIds.includes(row.id));
  const taken = returnsTaken ? returns : [];
  const inRoutes = ticked.filter((row) => row.vehicleLabel !== null).length + taken.filter((r) => r.inRoute).length;
  const shared = ticked.some((row) => row.shared) || taken.some((r) => r.shared);
  const key = ids.join(",");
  const confirming = confirmedFor === key;
  const setConfirming = (on: boolean) => setConfirmedFor(on ? key : null);
  // « Ne pas annuler » gives the focus back to the button that asked.
  const cancelButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (confirming || !refocus.current) return;
    refocus.current = false;
    cancelButton.current?.focus();
  }, [confirming]);

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
      {ids.map((id) => (
        <input key={id} type="hidden" name="tripId" value={id} />
      ))}
      <div className="flex flex-wrap items-end gap-3">
        <p className="self-center text-sm font-semibold text-slate-900">{plural(tripIds.length, "course sélectionnée", "courses sélectionnées")}</p>
        <div className="w-64 space-y-1">
          <label htmlFor={reasonId} className="block text-xs font-medium text-slate-600">
            Motif de l&apos;annulation
          </label>
          <Select ref={reasonField} id={reasonId} name="reason" required value={reason} onChange={(e) => setReason(e.target.value)}>
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
        {returns.length > 0 ? (
          <Checkbox
            className="h-10"
            checked={returnsTaken}
            onChange={(e) => setWithReturns(e.target.checked)}
            label={
              returns.length > 1
                ? `Annuler aussi les ${returns.length} retours de ces patients (non cochés)`
                : "Annuler aussi le retour de ce patient (non coché)"
            }
          />
        ) : null}
        {confirming ? null : (
          <div className="flex items-center gap-2">
            <Button ref={cancelButton} type="submit" variant="secondary" className="text-red-700 hover:bg-red-50">
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
        <div
          role="group"
          aria-label="Confirmer l'annulation"
          className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            refocus.current = true;
            setConfirming(false);
          }}
        >
          <p className="mr-auto text-sm text-red-950">{bulkConfirmText({ count, reason, inRoutes, shared, returnsLeft: returnsTaken ? 0 : returns.length })}</p>
          <Button
            variant="secondary"
            onClick={() => {
              refocus.current = true;
              setConfirming(false);
            }}
          >
            {count > 1 ? "Garder les courses" : "Garder la course"}
          </Button>
          <ConfirmButton count={count} />
        </div>
      ) : null}
      {result.message ? <FormMessage tone={result.ok ? "success" : "error"}>{result.message}</FormMessage> : null}
    </form>
  );
}

/** The question of « Annuler la sélection », in the future: nothing has happened yet. */
export function bulkConfirmText({
  count,
  reason,
  inRoutes,
  shared,
  returnsLeft,
}: {
  count: number;
  reason: string;
  inRoutes: number;
  shared: boolean;
  /** Returns of the ticked outbound trips left planned (box unticked). */
  returnsLeft: number;
}): string {
  const label = reason ? CANCELLATION_REASON_LABELS[reason as keyof typeof CANCELLATION_REASON_LABELS] : "?";
  return [
    `Annuler ${plural(count, "course", "courses")} pour le motif «\u202f${label}\u202f»\u202f?`,
    inRoutes > 0 ? (inRoutes > 1 ? `${inRoutes} seront retirées de leur tournée.` : "Une sera retirée de sa tournée.") : null,
    shared ? "Les co-passagers restés seuls ne seront plus en transport partagé." : null,
    returnsLeft > 0 ? `${returnsLeft > 1 ? `${returnsLeft} retours de ces patients restent prévus` : "Le retour de ce patient reste prévu"}.` : null,
    "Chaque course gardera son motif et l'annulation sera tracée course par course.",
  ]
    .filter(Boolean)
    .join(" ");
}

function ConfirmButton({ count }: { count: number }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="danger" disabled={pending} aria-busy={pending} autoFocus>
      {pending ? PENDING_LABEL : count > 1 ? `Oui, annuler les ${count} courses` : "Oui, annuler la course"}
    </Button>
  );
}
