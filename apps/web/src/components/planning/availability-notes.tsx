import { CarFront } from "lucide-react";
import { VehicleTypeBadge } from "@/components/ui/badge";
import type { SkippedVehicle } from "@/lib/optimizer/build-request";
import { pluralize } from "@/lib/planning/format";

/** Vehicles left out of the day and non-blocking remarks of the request builder. */
export function AvailabilityNotes({ skipped, notes }: { skipped: SkippedVehicle[]; notes: string[] }) {
  if (skipped.length === 0 && notes.length === 0) return null;
  return (
    <details className="group rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm shadow-xs" open={skipped.length <= 3}>
      <summary className="flex cursor-pointer list-none items-center gap-2 text-slate-700 [&::-webkit-details-marker]:hidden">
        <CarFront aria-hidden className="size-4 shrink-0 text-slate-400" />
        <span className="font-medium">
          {skipped.length > 0
            ? `${pluralize(skipped.length, "véhicule indisponible", "véhicules indisponibles")} ce jour`
            : "Remarques sur les véhicules"}
        </span>
        {notes.length > 0 && skipped.length > 0 ? <span className="text-slate-500">· {pluralize(notes.length, "remarque")}</span> : null}
        <span aria-hidden className="ml-auto text-xs text-slate-400 group-open:hidden">
          Afficher
        </span>
        <span aria-hidden className="ml-auto hidden text-xs text-slate-400 group-open:inline">
          Masquer
        </span>
      </summary>
      <ul className="mt-2 grid gap-x-6 gap-y-1.5 md:grid-cols-2">
        {skipped.map((s) => (
          <li key={s.vehicleId} className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 self-center">
              <VehicleTypeBadge type={s.type} />
            </span>
            <span className="shrink-0 font-medium text-slate-900">{s.label}</span>
            {/* Wrapped, not cut: a title tooltip is out of reach on touch screens and from the keyboard. */}
            <span className="min-w-0 text-slate-600">{s.reason}</span>
          </li>
        ))}
        {notes.map((note, i) => (
          <li key={`note-${i}`} className="text-slate-600 md:col-span-2">
            {note}
          </li>
        ))}
      </ul>
    </details>
  );
}
