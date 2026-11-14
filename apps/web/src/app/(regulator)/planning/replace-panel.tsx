"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { ListRestart, MapPinned, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmPanel } from "@/components/ui/confirm-action";
import { tripLineText } from "@/lib/planning/naming";
import type { TripView } from "@/lib/planning/types";
import { replaceTrips } from "./actions";
import { usePlanningActivity } from "./planning-activity";

/** The URL of the planning with `params` set (null: removed), the others kept. */
function planningHref(date: string, current: URLSearchParams, params: Record<string, string | null>): string {
  const next = new URLSearchParams(current);
  next.set("date", date);
  for (const [key, value] of Object.entries(params)) {
    if (value === null) next.delete(key);
    else next.set(key, value);
  }
  return `/planning?${next.toString()}`;
}

/**
 * The trips an interruption left to place again (DAY-03, ?replacer=): each one with « Où placer » (the
 * assistant, one at a time), and « Replacer les N courses », which gives each trip, the most urgent first,
 * its best place now. What is still listed afterwards found no place: the answer of « Replacer » says
 * why for each (it stays on screen, in amber).
 */
export function ReplacePanel({
  date,
  tripIds,
  trips,
  blocked,
}: {
  date: string;
  /** Trips the interruption left, in its order. */
  tripIds: readonly string[];
  trips: Record<string, TripView>;
  /** Why the trips cannot be placed now (a computation running, a past date), or null. */
  blocked: string | null;
}) {
  const { busy, run } = usePlanningActivity();
  const [asking, setAsking] = useState(false);
  const current = new URLSearchParams(useSearchParams()?.toString() ?? "");
  const left = tripIds.map((id) => trips[id]).filter((trip): trip is TripView => trip !== undefined && trip.vehicleId === null && trip.status !== "CANCELLED");
  const placed = tripIds.length - left.length;
  const close = planningHref(date, current, { replacer: null });

  return (
    <section aria-labelledby="replace-title" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 id="replace-title" className="font-semibold">
          {left.length === 0
            ? "Toutes les courses de la tournée interrompue sont replacées."
            : `${left.length > 1 ? `${left.length} courses` : "1 course"} à replacer après l'interruption${placed > 0 ? ` (${placed} déjà replacée${placed > 1 ? "s" : ""})` : ""}`}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {left.length > 0 ? (
            <Button size="sm" onClick={() => setAsking(true)} disabled={busy || blocked !== null || asking} title={blocked ?? undefined}>
              <ListRestart aria-hidden className="size-3.5" />
              Replacer {left.length > 1 ? `les ${left.length} courses` : "la course"}
            </Button>
          ) : null}
          <Link href={close} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100">
            <X aria-hidden className="size-3.5" />
            Fermer
          </Link>
        </div>
      </div>
      {asking ? (
        <ConfirmPanel
          question={`Chaque course va à la meilleure place trouvée maintenant, la plus urgente d'abord, et y est figée\u00a0: les feuilles de route des véhicules choisis changent dès l'enregistrement, prévenez les chauffeurs. Replacer ${left.length > 1 ? `les ${left.length} courses` : "la course"}\u202f?`}
          confirmLabel="Oui, replacer"
          keepLabel="Non, une par une"
          tone="primary"
          onKeep={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            run("Replacement des courses…", () => replaceTrips(date, left.map((trip) => trip.id)), { long: true });
          }}
          pending={busy}
          className="mt-2 border-amber-200 bg-white"
        />
      ) : null}
      {left.length > 0 ? (
        <ul className="mt-2 divide-y divide-amber-200/70">
          {left.map((trip) => (
            <li key={trip.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
              <span className="min-w-0 flex-1 font-medium">{tripLineText(trip)}</span>
              <Link
                href={planningHref(date, current, { trip: trip.id, placer: "1" })}
                className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-white px-2 py-1 text-xs font-medium text-amber-950 hover:bg-amber-100"
              >
                <MapPinned aria-hidden className="size-3.5" />
                Où placer
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
