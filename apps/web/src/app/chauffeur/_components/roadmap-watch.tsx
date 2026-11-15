"use client";

/**
 * Changes of the roadmap made by the regulation (DAY-04). While the roadmap is on screen the phone asks the server
 * every 90 s (and when it opens or comes back to the screen) whether its routes changed (POST /api/chauffeur/roadmap):
 * - the page drawn is stale (another fingerprint): it is refreshed;
 * - something changed since the crew last acknowledged it: a banner « Modifié par la régulation à 10:42 : 1 course
 *   retirée, 1 décalée », the stops added or moved highlighted, « J'ai vu » (timestamped, seen by the regulator).
 * Nothing is stored on the phone: the server keeps the versions and what the crew acknowledged; the answer holds
 * counts, times and opaque stop keys only, kept in memory.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { BellRing, Check } from "lucide-react";
import { cn } from "@/components/ui/cn";
import type { RoadmapSyncResponse } from "@/app/api/chauffeur/roadmap/route";
import type { CrewRoadmapState } from "@/lib/planning/roadmap-sync";
import { removedText } from "@/lib/planning/roadmap-version";
import { serverReachable } from "../_lib/reachability";
import { useDriverApp } from "./driver-app";

/** The roadmap checks for changes this often while it is on screen. */
const CHECK_EVERY_MS = 90_000;
const SYNC_URL = "/api/chauffeur/roadmap";

type RoadmapWatch = {
  /** Routes with changes the crew has not acknowledged yet. */
  pending: CrewRoadmapState[];
  highlight: ReadonlySet<string>;
  acknowledge: (vehicleId: string, version: number) => void;
  acknowledging: boolean;
  /** Why the latest « J'ai vu » did not go through (no network, server unreachable), null otherwise. */
  ackFailure: { vehicleId: string; text: string } | null;
};

const ACK_OFFLINE = "Pas de réseau\u00a0: «\u202fJ'ai vu\u202f» n'est pas parti. Réessayez, ou appelez la régulation.";
const ACK_FAILED = "«\u202fJ'ai vu\u202f» n'a pas pu être enregistré. Réessayez, ou appelez la régulation.";

const RoadmapWatchContext = createContext<RoadmapWatch | null>(null);

function useRoadmapWatch(): RoadmapWatch | null {
  return useContext(RoadmapWatchContext);
}

/** « 10:42 » of an ISO instant, Europe/Paris. */
function clockOf(iso: string): string {
  return new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

export function RoadmapWatchProvider({
  date,
  routes,
  children,
}: {
  date: string;
  /** The routes as the page drew them: vehicle and fingerprint. */
  routes: { vehicleId: string; fingerprint: string }[];
  children: ReactNode;
}) {
  const router = useRouter();
  const { ownerId } = useDriverApp();
  const [states, setStates] = useState<CrewRoadmapState[]>([]);
  const [acknowledging, setAcknowledging] = useState(false);
  const [ackFailure, setAckFailure] = useState<RoadmapWatch["ackFailure"]>(null);
  const [, startTransition] = useTransition();
  const drawn = useRef(routes);
  const lastRefresh = useRef(0);
  useEffect(() => {
    drawn.current = routes;
  }, [routes]);

  /** Asks the server; says whether it answered (« J'ai vu » tells the crew when it did not). */
  const sync = useCallback(
    async (ack?: { vehicleId: string; version: number }): Promise<"ok" | "offline" | "failed"> => {
      if (navigator.onLine === false) return "offline";
      try {
        const response = await fetch(SYNC_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date, ownerId, ...(ack ? { ack } : {}) }),
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
        });
        const body = (await response.json().catch(() => null)) as RoadmapSyncResponse | null;
        if (!body?.ok) return "failed";
        setStates(body.routes);
        // The page drawn is not the roadmap as it is now: draw it again (at most every 10 s).
        const shown = new Map(drawn.current.map((route) => [route.vehicleId, route.fingerprint]));
        const stale = body.routes.length !== shown.size || body.routes.some((route) => shown.get(route.vehicleId) !== route.fingerprint);
        if (stale && Date.now() - lastRefresh.current > 10_000 && (await serverReachable())) {
          lastRefresh.current = Date.now();
          startTransition(() => router.refresh());
        }
        return "ok";
      } catch {
        // No network: the next check will tell.
        return "offline";
      }
    },
    [date, ownerId, router],
  );

  useEffect(() => {
    const first = window.setTimeout(() => void sync(), 0);
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void sync();
    }, CHECK_EVERY_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void sync();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [sync]);

  const acknowledge = useCallback(
    (vehicleId: string, version: number) => {
      setAcknowledging(true);
      setAckFailure(null);
      void sync({ vehicleId, version })
        .then((result) => {
          if (result !== "ok") setAckFailure({ vehicleId, text: result === "offline" ? ACK_OFFLINE : ACK_FAILED });
        })
        .finally(() => setAcknowledging(false));
    },
    [sync],
  );

  const value = useMemo<RoadmapWatch>(() => {
    const pending = states.filter((state) => state.pending !== null);
    return { pending, highlight: new Set(pending.flatMap((state) => state.pending?.highlight ?? [])), acknowledge, acknowledging, ackFailure };
  }, [states, acknowledge, acknowledging, ackFailure]);
  return <RoadmapWatchContext.Provider value={value}>{children}</RoadmapWatchContext.Provider>;
}

/** The banner of each route changed by the regulation, until « J'ai vu ». */
export function RoadmapChangeBanner({ labels }: { labels: Record<string, string> }) {
  const watch = useRoadmapWatch();
  if (!watch || watch.pending.length === 0) return null;
  return (
    <div className="space-y-2">
      {watch.pending.map((state) => {
        const pending = state.pending;
        if (!pending) return null;
        return (
          <section
            key={state.vehicleId}
            role="alert"
            className="space-y-2 rounded-2xl border-2 border-amber-400 bg-amber-50 p-4 text-amber-950 shadow-sm"
          >
            <p className="flex items-start gap-2 text-base">
              <BellRing aria-hidden className="mt-0.5 size-5 shrink-0 text-amber-700" />
              <span>
                <span className="font-bold">Modifié par la régulation à {clockOf(pending.changedAt)}&nbsp;:</span> {pending.text}
                {watch.pending.length > 1 ? <span className="block text-sm">{labels[state.vehicleId] ?? "Tournée"}</span> : null}
              </span>
            </p>
            {pending.removed.length > 0 ? (
              <ul className="space-y-0.5 pl-7 text-sm">
                {pending.removed.map((removed) => (
                  <li key={removed.tripId}>Retirée&nbsp;: {removedText(removed)}</li>
                ))}
              </ul>
            ) : null}
            {pending.highlight.length > 0 ? <p className="pl-7 text-sm">Les arrêts ajoutés ou décalés sont signalés «&#x202F;Modifié&#x202F;» ci-dessous.</p> : null}
            <button
              type="button"
              disabled={watch.acknowledging}
              onClick={() => watch.acknowledge(state.vehicleId, state.version)}
              className="flex min-h-12 w-full touch-manipulation items-center justify-center gap-2 rounded-xl bg-amber-700 px-4 text-base font-semibold text-white hover:bg-amber-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 disabled:opacity-60"
            >
              <Check aria-hidden className="size-5" />
              {watch.acknowledging ? "Envoi…" : "J'ai vu"}
            </button>
            {watch.ackFailure?.vehicleId === state.vehicleId ? (
              <p role="status" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-900">
                {watch.ackFailure.text}
              </p>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

/** On a stop added or moved by the regulation (not acknowledged yet): a ring around the card. */
export function ChangedRing({ changeKey }: { changeKey: string }) {
  const watch = useRoadmapWatch();
  if (!watch?.highlight.has(changeKey)) return null;
  return <span aria-hidden className="pointer-events-none absolute inset-0 z-10 rounded-2xl ring-4 ring-amber-400 ring-inset" />;
}

/** « Modifié » next to the stop's time, on a stop added or moved by the regulation (not acknowledged yet). */
export function ChangedPill({ changeKey, className }: { changeKey: string; className?: string }) {
  const watch = useRoadmapWatch();
  if (!watch?.highlight.has(changeKey)) return null;
  return (
    <span className={cn("inline-flex shrink-0 items-center rounded-full bg-amber-400 px-2.5 py-0.5 text-sm font-bold text-amber-950", className)}>
      Modifié
    </span>
  );
}
