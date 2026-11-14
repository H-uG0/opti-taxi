"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { CircleOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import type { VehicleRowView } from "@/lib/planning/types";
import { formatMinute } from "@/lib/time";
import { interruptRoute } from "./actions";
import { usePlanningActivity } from "./planning-activity";

type Who = "VEHICLE" | "DRIVER" | "CREW_MATE";

/** Motives offered for each choice: a vehicle stops for a repair or a maintenance; a person is unavailable. */
const KINDS: Record<Who, { value: string; label: string }[]> = {
  VEHICLE: [
    { value: "REPAIR", label: "Panne ou réparation" },
    { value: "MAINTENANCE", label: "Entretien" },
    { value: "OTHER", label: "Autre motif" },
  ],
  DRIVER: [
    { value: "OTHER", label: "Indisponible" },
    { value: "SICK", label: "Maladie" },
  ],
  CREW_MATE: [
    { value: "OTHER", label: "Indisponible" },
    { value: "SICK", label: "Maladie" },
  ],
};

/** « 11:20 » for the time field: now on today's date, rounded down to 5 min; the route's start otherwise. */
function defaultTime(today: boolean, fallback: number): string {
  if (!today) return formatMinute(fallback);
  const now = new Date();
  const minute = now.getHours() * 60 + now.getMinutes();
  return formatMinute(minute - (minute % 5));
}

/**
 * « Hors service ou indisponible à partir de HH:MM » (DAY-03) in the vehicle panel: the vehicle out of
 * service, or its driver (or the ambulance's crew mate) unavailable, from a time. The route closes there:
 * what was done stays, the trips not picked up go back « À placer », a patient on board is picked up
 * again at the last stop done by a continuation trip. The trips to place again are then listed above
 * the timeline (?replacer=), one by one with « Où placer » or all at once.
 */
export function RouteOutage({
  date,
  today,
  vehicle,
  blocked,
}: {
  date: string;
  /** The planning shown is today's: the time defaults to now. */
  today: boolean;
  vehicle: VehicleRowView;
  /** Why it is not possible right now (a past date, a computation running), or null. */
  blocked: string | null;
}) {
  const router = useRouter();
  const { busy, run } = usePlanningActivity();
  const route = vehicle.route;
  const [open, setOpen] = useState(false);
  const [who, setWho] = useState<Who>("VEHICLE");
  const [kind, setKind] = useState("REPAIR");
  const [from, setFrom] = useState(() => defaultTime(today, route?.startMinute ?? 480));
  const [note, setNote] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const timeId = useId();
  const kindId = useId();
  const noteId = useId();
  if (!route) return null;
  const finished = route.remaining === null;
  const reason = finished ? "Tournée terminée." : blocked;
  const ambulance = vehicle.type === "AMBULANCE";

  if (!open) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/60 px-4 py-2.5">
        <p className="min-w-0 flex-1 text-xs text-slate-600">
          {reason ?? "Panne, chauffeur indisponible\u202f: clôt la tournée à une heure donnée, les courses restantes sont à replacer."}
        </p>
        <Button size="sm" variant="secondary" disabled={busy || reason !== null} onClick={() => setOpen(true)}>
          <CircleOff aria-hidden className="size-3.5" />
          Hors service…
        </Button>
      </div>
    );
  }

  const choose = (value: Who) => {
    setWho(value);
    setKind(KINDS[value][0]!.value);
    setRefusal(null);
  };

  return (
    <form
      className="space-y-2.5 border-t border-slate-100 bg-slate-50/60 px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        setRefusal(null);
        run(`Interruption de la tournée de ${vehicle.label}…`, () => interruptRoute({ routeId: route.id, who, from, kind, note }), {
          onResult: (result) => {
            if (!result.ok) {
              setRefusal(result.error);
              return;
            }
            setOpen(false);
            const toPlace = result.toPlace ?? [];
            if (toPlace.length > 0) router.push(`/planning?date=${date}&replacer=${toPlace.join(",")}`);
          },
        });
      }}
    >
      <p className="text-sm font-medium text-slate-900">Hors service ou indisponible à partir d&apos;une heure</p>
      <fieldset className="space-y-1.5">
        <legend className="sr-only">Qui devient indisponible</legend>
        {(
          [
            ["VEHICLE", `${vehicle.label} hors service`],
            ["DRIVER", "Chauffeur indisponible"],
            ...(ambulance ? ([["CREW_MATE", "Équipier indisponible"]] as const) : []),
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex items-center gap-2 text-sm text-slate-800">
            <input type="radio" name="who" value={value} checked={who === value} onChange={() => choose(value)} disabled={busy} />
            {label}
          </label>
        ))}
      </fieldset>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor={timeId} className="text-xs font-medium text-slate-700">
            À partir de
          </label>
          <Input
            id={timeId}
            type="time"
            step={300}
            required
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            disabled={busy}
            className="mt-1 tabular-nums"
          />
        </div>
        <div>
          <label htmlFor={kindId} className="text-xs font-medium text-slate-700">
            Motif
          </label>
          <Select id={kindId} value={kind} onChange={(e) => setKind(e.target.value)} disabled={busy} className="mt-1">
            {KINDS[who].map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div>
        <label htmlFor={noteId} className="text-xs font-medium text-slate-700">
          Précision (facultative, sans donnée médicale)
        </label>
        <Input id={noteId} type="text" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} className="mt-1" />
      </div>
      <p className="text-xs text-slate-500">
        La tournée s&apos;arrête à cette heure&nbsp;: les arrêts faits restent, les courses pas encore prises en charge repassent
        «&#x202F;À placer&#x202F;», un patient à bord est repris au lieu du dernier arrêt (course de reprise). L&apos;indisponibilité est
        enregistrée sur la fiche{who === "VEHICLE" ? " du véhicule" : " de la personne"}&nbsp;; la feuille de route du chauffeur change
        aussitôt.
      </p>
      {refusal ? (
        <p role="alert" className="text-xs font-medium text-red-700">
          {refusal}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setOpen(false);
            setRefusal(null);
          }}
        >
          Annuler
        </Button>
        <Button size="sm" type="submit" variant="danger" disabled={busy || from === ""}>
          Clore la tournée à {from || "…"}
        </Button>
      </div>
    </form>
  );
}
