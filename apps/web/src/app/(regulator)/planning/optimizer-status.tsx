import { WifiOff } from "lucide-react";
import { health } from "@/lib/optimizer/client";
import { OptimizerOfflineSignal } from "./optimizer-offline-signal";

/** Probes the optimizer service (streamed under Suspense so the page never waits on it). */
export async function OptimizerStatus() {
  const result = await health();
  if (result.ok) {
    return (
      <p role="status" className="flex items-center gap-2 text-xs text-slate-500">
        <span aria-hidden className="size-2 rounded-full bg-emerald-500" />
        Service d&apos;optimisation en ligne · distances{" "}
        {result.data.matrixSource === "osrm" ? "routières (OSRM)" : "estimées à vol d'oiseau (OSRM non configuré)"}
      </p>
    );
  }
  return (
    <div role="alert" className="flex basis-full items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-900">
      <OptimizerOfflineSignal reason="Optimiseur hors ligne : le calcul des tournées est indisponible pour le moment." />
      <WifiOff aria-hidden className="mt-0.5 size-4 shrink-0" />
      <p className="min-w-0 break-words">
        <span className="font-semibold">Optimiseur hors ligne.</span> {result.error} Le planning enregistré reste consultable
        et modifiable (verrous, validation) ; « Optimiser », « Déplacer » et « Revenir au planning précédent » attendent son
        retour.
      </p>
    </div>
  );
}

export function OptimizerStatusPending() {
  return (
    <p className="flex items-center gap-2 text-xs text-slate-400">
      <span aria-hidden className="size-2 rounded-full bg-slate-300" />
      Vérification du service d&apos;optimisation…
    </p>
  );
}
