"use client";

/**
 * The odometer of the day's vehicle (FLD-03), at the start and the end of the day: typed by the crew, saved on the
 * phone and sent like a status (offline too: the status queue, keyed by odometerKey). Checked before it leaves
 * against the last mileage known (lib/fleet/odometer.ts checkReading: never below it, an unusual jump confirmed),
 * and again by the server, which may know a newer one.
 */
import { useId, useState } from "react";
import { CloudOff, Gauge, LoaderCircle, Pencil } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { checkReading, type KmPoint } from "@/lib/fleet/odometer";
import { formatShortDate } from "@/lib/time";
import { odometerKey } from "../_lib/status-protocol";
import { useDriverApp, useQueueSnapshot } from "./driver-app";
import { ActionError, useRefusal } from "./stop-actions";

const nf = new Intl.NumberFormat("fr-FR");

const LABELS = { START: "Compteur au départ", END: "Compteur au retour" } as const;

/** « 123 456 », « 123456 », « 123.456 » -> 123456; null when it is not a whole number of km. */
export function parseKm(text: string): number | null {
  const digits = text.replace(/[\s  .]/g, "");
  if (!/^\d{1,7}$/.test(digits)) return null;
  return Number(digits);
}

export function OdometerCard({
  routeId,
  date,
  moment,
  recorded,
  lastKnown,
  startKm,
  prominent = false,
}: {
  routeId: string;
  /** The route's day (YYYY-MM-DD): a jump is weighed against the days since the last mileage known. */
  date: string;
  moment: "START" | "END";
  /** The reading of the day on the server, null when none. */
  recorded: number | null;
  /** The last mileage known before the day (fill-ups, readings), the reading's hint. */
  lastKnown: KmPoint | null;
  /** The day's start (for the end's reading). */
  startKm: number | null;
  /** The task of the moment (the start, before the first stop): a framed card. */
  prominent?: boolean;
}) {
  const { submit } = useDriverApp();
  const { byStop, refusals } = useQueueSnapshot();
  const key = odometerKey(routeId, moment);
  const refusal = useRefusal(key);
  const lastRefusal = [...refusals].reverse().find((r) => r.stopId === key);
  const local = byStop[key];
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [question, setQuestion] = useState<{ km: number; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  const send = (km: number, confirmed: boolean) => {
    setQuestion(null);
    setError(null);
    submit(key, "ODOMETER", { km, ...(confirmed ? { confirmed: true } : {}) });
    // Kept in the field: a refusal of the server brings the form back with it.
    setText(String(km));
    setEditing(false);
  };

  const onSubmit = () => {
    const km = parseKm(text);
    if (km === null) {
      setError("Saisissez le kilométrage affiché au compteur, en km entiers.");
      return;
    }
    const check = checkReading({ km, date, moment, others: lastKnown && lastKnown.date < date ? [lastKnown] : [], startKm });
    if (!check.ok && check.kind === "refused") {
      setError(check.message);
      return;
    }
    if (!check.ok) {
      setQuestion({ km, message: check.message });
      return;
    }
    send(km, false);
  };

  const shown = local?.km ?? recorded;
  const frame = cn("space-y-2 rounded-2xl border px-4 py-3", prominent ? "border-brand-700 bg-white ring-1 ring-brand-700" : "border-slate-300 bg-white");

  if (!editing && shown !== null && !(lastRefusal && !local)) {
    // The reading of the day, on the server or still on the phone.
    return (
      <div className={frame}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Gauge aria-hidden className="size-5 shrink-0 text-brand-700" />
          <p className="min-w-0 flex-1 text-base text-slate-900">
            {LABELS[moment]}&nbsp;: <span className="tabular font-semibold">{nf.format(shown)}&nbsp;km</span>
          </p>
          <button
            type="button"
            onClick={() => {
              setText(String(shown));
              setEditing(true);
            }}
            className="inline-flex min-h-11 touch-manipulation items-center gap-1 rounded-lg px-2 text-sm font-semibold text-brand-800 underline underline-offset-2 hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-brand-600"
          >
            <Pencil aria-hidden className="size-4" />
            Corriger
          </button>
        </div>
        {local ? (
          <p role="status" className="flex items-center gap-2 text-sm text-slate-700">
            {local.phase === "queued" ? <CloudOff aria-hidden className="size-4" /> : local.phase === "sending" ? <LoaderCircle aria-hidden className="size-4 motion-safe:animate-spin" /> : null}
            {local.phase === "queued" ? "En attente d'envoi : il part dès que le réseau revient." : local.phase === "sending" ? "Envoi en cours…" : "Enregistré."}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form
      className={frame}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label htmlFor={id} className="flex items-center gap-2 text-base font-semibold text-slate-950">
        <Gauge aria-hidden className="size-5 shrink-0 text-brand-700" />
        {LABELS[moment]}
      </label>
      <p className="text-sm text-slate-600">
        {moment === "END" && startKm !== null
          ? `Départ : ${nf.format(startKm)} km.`
          : lastKnown
            ? `Dernier relevé connu : ${nf.format(lastKnown.km)} km (${formatShortDate(lastKnown.date)}).`
            : "Kilométrage affiché au compteur du véhicule."}
      </p>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <input
          id={id}
          inputMode="numeric"
          autoComplete="off"
          enterKeyHint="done"
          placeholder="km"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setQuestion(null);
            setError(null);
          }}
          className="tabular min-h-12 rounded-xl border border-field bg-white px-3 text-lg text-slate-900 focus-visible:outline-2 focus-visible:outline-brand-600"
        />
        <button
          type="submit"
          className="inline-flex min-h-12 touch-manipulation items-center justify-center rounded-xl bg-brand-700 px-4 text-base font-semibold text-white hover:bg-brand-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
          Enregistrer
        </button>
      </div>
      {question ? (
        <div role="alert" className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-amber-950">
          <p className="text-sm">{question.message}</p>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setQuestion(null)} className="min-h-12 rounded-xl border border-slate-300 bg-white px-3 text-base font-semibold text-slate-900">
              Corriger
            </button>
            <button type="button" onClick={() => send(question.km, true)} className="tabular min-h-12 rounded-xl bg-amber-700 px-3 text-base font-semibold text-white">
              Confirmer {nf.format(question.km)}&nbsp;km
            </button>
          </div>
        </div>
      ) : null}
      {error ? <ActionError message={error} /> : null}
      {refusal && !question ? (
        <>
          <ActionError message={refusal} />
          {lastRefusal?.code === "confirm" ? (
            <button
              type="button"
              onClick={() => {
                const km = parseKm(text) ?? null;
                if (km !== null) send(km, true);
              }}
              className="min-h-12 w-full rounded-xl bg-amber-700 px-3 text-base font-semibold text-white"
            >
              Confirmer ce relevé
            </button>
          ) : null}
        </>
      ) : null}
      {editing && recorded !== null ? (
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="min-h-11 text-sm font-semibold text-slate-700 underline underline-offset-2"
        >
          Garder {nf.format(recorded)}&nbsp;km
        </button>
      ) : null}
    </form>
  );
}
