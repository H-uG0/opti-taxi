import { TriangleAlert, Clock, LoaderCircle, CircleX } from "lucide-react";
import { formatInstant, formatSeconds, pluralize } from "@/lib/planning/format";
import type { RunView } from "@/lib/planning/types";

const MATRIX_LABELS: Record<string, string> = {
  osrm: "OSRM (réseau routier)",
  haversine: "estimation à vol d'oiseau",
};

/** Last optimization: when, how long, distance source, warnings, and the error of a failed attempt. */
export function RunBanner({ lastRun, planRun }: { lastRun: RunView | null; planRun: RunView | null }) {
  if (!lastRun && !planRun) return null;
  const failed = lastRun && lastRun.status === "FAILED" ? lastRun : null;
  // A RUNNING run past its budget was interrupted (server restart): do not promise a result.
  const running = lastRun && lastRun.status === "RUNNING" && !lastRun.interrupted ? lastRun : null;
  const interrupted = lastRun && lastRun.status === "RUNNING" && lastRun.interrupted ? lastRun : null;

  return (
    <div className="space-y-2">
      {interrupted ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            <span className="font-semibold">L&apos;optimisation du {formatInstant(interrupted.startedAt)} ne s&apos;est pas terminée</span>
            {interrupted.requestedBy ? ` (lancée par ${interrupted.requestedBy})` : ""} : le serveur a sans doute redémarré
            pendant le calcul. Relancez l&apos;optimisation{planRun ? " ; les tournées affichées sont celles du calcul précédent" : ""}.
          </span>
        </p>
      ) : null}

      {running ? (
        <p role="status" className="flex items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-4 py-2.5 text-sm text-sky-900">
          <LoaderCircle aria-hidden className="size-4 shrink-0 motion-safe:animate-spin" />
          Une optimisation de cette date a démarré le {formatInstant(running.startedAt)}
          {running.requestedBy ? ` (${running.requestedBy})` : ""} pour {pluralize(running.tripsCount, "course")} : calcul
          d&apos;environ {running.timeLimitSec} s, rechargez la page ensuite.
        </p>
      ) : null}

      {failed ? (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-900">
          <CircleX aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p className="min-w-0 break-words">
            <span className="font-semibold">Échec de l&apos;optimisation du {formatInstant(failed.startedAt)}</span>
            {planRun ? " (les tournées affichées sont celles du calcul précédent)" : ""} : {failed.error ?? "erreur inconnue"}
          </p>
        </div>
      ) : null}

      {planRun ? (
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-700 shadow-xs">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Clock aria-hidden className="size-4 shrink-0 text-slate-400" />
            <span>
              Dernier calcul le <span className="tabular">{formatInstant(planRun.startedAt)}</span>
              {planRun.requestedBy ? ` par ${planRun.requestedBy}` : ""}
            </span>
            <span aria-hidden className="text-slate-300">
              ·
            </span>
            <span className="tabular">
              durée {formatSeconds(planRun.durationMs)}
              {planRun.wallTimeMs !== null ? ` (solveur ${formatSeconds(planRun.wallTimeMs)})` : ""}
            </span>
            <span aria-hidden className="text-slate-300">
              ·
            </span>
            <span>
              {pluralize(planRun.tripsCount, "course")}
              {planRun.lockedCount > 0 ? ` dont ${pluralize(planRun.lockedCount, "figée", "figées")}` : ""}
            </span>
            <span aria-hidden className="text-slate-300">
              ·
            </span>
            <span>distances : {MATRIX_LABELS[planRun.matrixSource ?? ""] ?? planRun.matrixSource ?? "—"}</span>
          </p>
          {planRun.matrixSource === "haversine" ? (
            <p className="mt-1.5 flex items-start gap-2 text-amber-800">
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              Distances et temps estimés à vol d&apos;oiseau (OSRM non configuré) : km, horaires et CA sont approximatifs.
            </p>
          ) : null}
          {planRun.warnings && planRun.warnings.length > 0 ? (
            <details className="mt-1.5">
              <summary className="cursor-pointer text-amber-800 hover:underline">
                {pluralize(planRun.warnings.length, "avertissement", "avertissements")} de l&apos;optimiseur
              </summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-6 text-slate-700">
                {planRun.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
