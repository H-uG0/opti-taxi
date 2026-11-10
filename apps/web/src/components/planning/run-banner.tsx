import type { ReactNode } from "react";
import { TriangleAlert, Clock, Info, LoaderCircle, CircleX } from "lucide-react";
import { formatEurosRounded, formatSeconds, pluralize } from "@/lib/planning/format";
import { MOVE_REFUSED_PREFIX } from "@/lib/planning/move";
import { NOT_KEPT_PREFIX } from "@/lib/planning/plan-compare";
import type { RunView } from "@/lib/planning/types";
import { MATRIX_SOURCE_LABELS } from "@/lib/labels";
import { formatDateTime } from "@/lib/time";


const PLAN_RUN_LABEL: Record<NonNullable<RunView["kind"]>, string> = {
  optimize: "Dernier calcul",
  move: "Dernier calcul (déplacement)",
  restore: "Planning précédent rétabli",
  place: "Dernier calcul (placement des non affectées)",
};

/** What a run not kept was (« Calcul du … non retenu »). */
const NOT_KEPT_LABEL: Record<NonNullable<RunView["kind"]>, string> = {
  optimize: "Calcul",
  move: "Déplacement",
  restore: "Retour au planning précédent",
  place: "Placement des non affectées",
};

/**
 * What happened to the last optimization when it did not give the plan in
 * place: interrupted, running, failed or not kept. The plan in place is
 * summed up on one line by PlanRunLine. A run waiting for confirmation is
 * shown by PendingPlanBanner. A move refused (planning unchanged) is not
 * repeated here: the action's own answer said it, with the patients' names.
 */
export function RunBanner({ lastRun, planRun }: { lastRun: RunView | null; planRun: RunView | null }) {
  if (!lastRun) return null;
  const refusedMove = lastRun?.status === "FAILED" && lastRun.error?.startsWith(MOVE_REFUSED_PREFIX);
  const failedRun = lastRun && lastRun.status === "FAILED" && !refusedMove ? lastRun : null;
  // A plan the regulator chose not to keep (or that could no longer be saved) is not a failure.
  const notKept = failedRun?.error?.startsWith(NOT_KEPT_PREFIX) ? failedRun : null;
  const failed = notKept ? null : failedRun;
  // A RUNNING run past its budget was interrupted (server restart): do not promise a result.
  const running = lastRun && lastRun.status === "RUNNING" && !lastRun.interrupted ? lastRun : null;
  const interrupted = lastRun && lastRun.status === "RUNNING" && lastRun.interrupted ? lastRun : null;
  if (!interrupted && !running && !failed && !notKept) return null;

  return (
    <div className="space-y-2">
      {interrupted ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            <span className="font-semibold">L&apos;optimisation du {formatDateTime(interrupted.startedAt)} ne s&apos;est pas terminée</span>
            {interrupted.requestedBy ? ` (lancée par ${interrupted.requestedBy})` : ""}&nbsp;: le serveur a sans doute redémarré
            pendant le calcul. Relancez l&apos;optimisation{planRun ? "\u202f; les tournées affichées sont celles du calcul précédent" : ""}.
          </span>
        </p>
      ) : null}

      {running ? (
        <p role="status" className="flex items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-4 py-2.5 text-sm text-sky-900">
          <LoaderCircle aria-hidden className="size-4 shrink-0 motion-safe:animate-spin" />
          Une optimisation de cette date a démarré le {formatDateTime(running.startedAt)}
          {running.requestedBy ? ` (${running.requestedBy})` : ""} pour {pluralize(running.tripsCount, "course")}&nbsp;: calcul
          d&apos;environ {running.timeLimitSec}&nbsp;s. Un bandeau proposera de recharger le planning à la fin du calcul.
        </p>
      ) : null}

      {failed ? (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-900">
          <CircleX aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p className="min-w-0 break-words">
            <span className="font-semibold">Échec de l&apos;optimisation du {formatDateTime(failed.startedAt)}</span>
            {planRun ? " (les tournées affichées sont celles du calcul précédent)" : ""}&nbsp;: {failed.error ?? "erreur inconnue"}
          </p>
        </div>
      ) : null}

      {notKept ? (
        <p role="status" className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-700">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-slate-400" />
          <span className="min-w-0 break-words">
            {NOT_KEPT_LABEL[notKept.kind ?? "optimize"]} du {formatDateTime(notKept.startedAt)}
            {notKept.requestedBy ? ` (${notKept.requestedBy})` : ""} non retenu
            {notKept.error ? `\u00a0: ${notKept.error.slice(NOT_KEPT_PREFIX.length).replace(/^\s*:\s*/, "")}` : "."}
          </span>
        </p>
      ) : null}

    </div>
  );
}

/**
 * The plan in place on one line (the planning's board needs the height): when
 * and by whom it was computed, how long, how many trips and locks, the
 * distance source (approximate without OSRM), traffic, the optimizer's
 * warnings, and « Revenir au planning précédent » when offered (`restore`).
 */
export function PlanRunLine({ planRun, restore }: { planRun: RunView | null; restore?: ReactNode }) {
  if (!planRun) return null;
  const dot = (
    <span aria-hidden className="text-slate-300">
      ·
    </span>
  );
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600">
      <Clock aria-hidden className="size-3.5 shrink-0 text-slate-400" />
      <span>
        {PLAN_RUN_LABEL[planRun.kind ?? "optimize"]} le <span className="tabular">{formatDateTime(planRun.startedAt)}</span>
        {planRun.requestedBy ? ` par ${planRun.requestedBy}` : ""}
      </span>
      {dot}
      <span className="tabular">
        {formatSeconds(planRun.durationMs)}
        {planRun.wallTimeMs !== null ? ` (solveur ${formatSeconds(planRun.wallTimeMs)})` : ""}
      </span>
      {dot}
      <span>
        {pluralize(planRun.tripsCount, "course")}
        {planRun.lockedCount > 0 ? ` dont ${pluralize(planRun.lockedCount, "figée", "figées")}` : ""}
      </span>
      {dot}
      {planRun.matrixSource === "haversine" ? (
        <span className="inline-flex items-center gap-1 text-amber-800" title="Distances et temps estimés à vol d'oiseau, faute de calcul routier&nbsp;: prévenez la personne qui gère l'application si cela dure">
          <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
          distances à vol d&apos;oiseau&nbsp;: km, horaires et CA approximatifs
        </span>
      ) : (
        <span>distances&nbsp;: {MATRIX_SOURCE_LABELS[planRun.matrixSource ?? ""] ?? planRun.matrixSource ?? "—"}</span>
      )}
      {planRun.trafficSource ? (
        <>
          {dot}
          <span>{planRun.trafficSource === "none" ? "trafic non pris en compte" : "trafic pris en compte"}</span>
        </>
      ) : null}
      {planRun.warnings && planRun.warnings.length > 0 ? (
        <>
          {dot}
          <details className="relative">
            <summary className="cursor-pointer text-amber-800 hover:underline">
              {pluralize(planRun.warnings.length, "avertissement", "avertissements")} de l&apos;optimiseur
            </summary>
            <ul className="absolute left-0 top-full z-40 mt-1 w-max max-w-[min(36rem,80vw)] list-disc space-y-0.5 rounded-md border border-slate-200 bg-white py-2 pl-6 pr-3 text-slate-700 shadow-lg">
              {planRun.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </details>
        </>
      ) : null}
      {restore && planRun.previous ? (
        <span className="inline-flex flex-wrap items-center gap-x-2">
          {dot}
          <span>
            Planning remplacé&nbsp;: {pluralize(planRun.previous.served, "course servie", "courses servies")}, marge{" "}
            {formatEurosRounded(planRun.previous.margin)}
          </span>
          {restore}
        </span>
      ) : null}
    </div>
  );
}
