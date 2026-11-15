"use client";

/**
 * « Suivi du jour » (DAY-01): the planning page of today kept live. Every 30 s while the page is on screen (and at
 * once when it comes back), GET /planning/suivi brings what the crews recorded since (statuses, ends of session,
 * roadmaps seen, requests); the rows and trips the page was rendered with are updated in place (live-merge.ts) and
 * projected (live-day.ts): where each route stands, how late it runs, which appointments it puts at risk. The clock
 * is the server's (the poll's answer), not the computer's. Anything else that changed the plan (a re-optimization, a
 * trip added…) makes its key move: the page then offers « Recharger » (version-watcher.tsx), never reloads by itself.
 *
 * « Plein écran »: the browser's full screen with the menu hidden (wall display); without the Fullscreen API, only
 * the menu is hidden.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Maximize2, Minimize2, Radio, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { minuteOn } from "@/lib/planning/day-progress";
import { projectDay, SHOWN_DELAY_MIN, type DayProjection } from "@/lib/planning/live-day";
import type { LiveSnapshot } from "@/lib/planning/live-load";
import { liveTrips, liveVehicles, projectionRoutes, projectionTrips } from "@/lib/planning/live-merge";
import { pluralize } from "@/lib/planning/format";
import type { TripView, VehicleRowView } from "@/lib/planning/types";
import { formatMinute } from "@/lib/time";

/** Poll period while the page is on screen. */
const POLL_MS = 30_000;
/** Without an answer for this long, the bar says the follow-up is interrupted. */
const STALE_AFTER_MS = 2 * 60_000;
/** The « maintenant » line moves this often. */
const TICK_MS = 15_000;

export type LiveDay = {
  date: string;
  snapshot: LiveSnapshot;
  /** Minute of the day now (server clock). */
  nowMinute: number;
  /** Server time of the latest answer (epoch ms). */
  updatedAt: number;
  /** No answer for STALE_AFTER_MS. */
  stale: boolean;
  /** The plan changed otherwise than by the field since the page was drawn: « Recharger ». */
  planChanged: boolean;
  vehicles: VehicleRowView[];
  trips: TripView[];
  projection: DayProjection;
  wall: boolean;
  toggleWall: () => void;
};

const LiveDayContext = createContext<LiveDay | null>(null);

/** The live day of the planning page of today, null on another date. */
export function useLiveDay(): LiveDay | null {
  return useContext(LiveDayContext);
}

function subscribeTick(onChange: () => void): () => void {
  const id = window.setInterval(onChange, TICK_MS);
  document.addEventListener("visibilitychange", onChange);
  return () => {
    window.clearInterval(id);
    document.removeEventListener("visibilitychange", onChange);
  };
}
const tickNow = () => Math.floor(Date.now() / TICK_MS) * TICK_MS;
const noTick = () => null;

export function LiveDayProvider({
  initial,
  vehicles,
  trips,
  maxTotalWaitMin,
  children,
}: {
  /** The state read with the page (loadLiveSnapshot), the plan's key included. */
  initial: LiveSnapshot;
  vehicles: VehicleRowView[];
  trips: TripView[];
  maxTotalWaitMin: number;
  children: ReactNode;
}) {
  const router = useRouter();
  const [polled, setPolled] = useState<{ snapshot: LiveSnapshot; offset: number } | null>(null);
  const [failingSince, setFailingSince] = useState<number | null>(null);
  const clock = useSyncExternalStore(subscribeTick, tickNow, noTick);
  const lastPoll = useRef(0);
  // The newest of the page's own read and the latest poll (the page is drawn again after each action). The server's
  // clock is known from the first poll (made at once); until then the computer's is taken as it.
  const offset = polled?.offset ?? 0;
  const snapshot = polled && polled.snapshot.serverTime >= initial.serverTime ? polled.snapshot : initial;

  const poll = useCallback(async () => {
    lastPoll.current = Date.now();
    try {
      const response = await fetch(`/planning/suivi?date=${initial.date}`, { cache: "no-store", redirect: "manual" });
      if (response.type === "opaqueredirect") {
        // Session over: the page itself sends to the sign-in page.
        router.refresh();
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = (await response.json()) as LiveSnapshot;
      setPolled({ snapshot: next, offset: next.serverTime - Date.now() });
      setFailingSince(null);
    } catch {
      setFailingSince((since) => since ?? Date.now());
    }
  }, [initial.date, router]);

  useEffect(() => {
    // A first poll at once: the server's clock, and what came in since the page was read.
    const first = window.setTimeout(() => void poll(), 0);
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void poll();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastPoll.current > POLL_MS / 2) void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [poll]);

  // Full screen (wall display): the menu hidden by globals.css while html carries data-wall.
  const [wall, setWall] = useState(false);
  useEffect(() => {
    const onChange = () => setWall(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  useEffect(() => {
    if (wall) document.documentElement.dataset.wall = "";
    else delete document.documentElement.dataset.wall;
    return () => {
      delete document.documentElement.dataset.wall;
    };
  }, [wall]);
  const toggleWall = useCallback(() => {
    const root = document.documentElement;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    if (typeof root.requestFullscreen === "function") {
      root.requestFullscreen().then(
        () => setWall(true),
        () => setWall((on) => !on),
      );
    } else setWall((on) => !on);
  }, []);

  // During the server render and the hydration, the time of the read.
  const nowMinute = minuteOn(new Date(clock === null ? snapshot.serverTime : clock + offset), initial.date);
  const field = useMemo(() => ({ done: snapshot.done, trips: snapshot.trips, returnsToCheck: snapshot.returnsToCheck }), [snapshot]);
  const mergedVehicles = useMemo(() => liveVehicles(vehicles, field), [vehicles, field]);
  const mergedTrips = useMemo(() => liveTrips(trips, field), [trips, field]);
  const projection = useMemo(
    () =>
      projectDay({
        routes: projectionRoutes(mergedVehicles),
        trips: projectionTrips(mergedTrips),
        nowMinute,
        maxTotalWaitMin,
        lateness: snapshot.lateness ?? {},
      }),
    [mergedVehicles, mergedTrips, nowMinute, maxTotalWaitMin, snapshot.lateness],
  );
  const value = useMemo<LiveDay>(
    () => ({
      date: initial.date,
      snapshot,
      nowMinute,
      updatedAt: snapshot.serverTime,
      stale: failingSince !== null && clock !== null && clock + offset - snapshot.serverTime > STALE_AFTER_MS,
      planChanged: snapshot.planKey !== initial.planKey || snapshot.run !== initial.run,
      vehicles: mergedVehicles,
      trips: mergedTrips,
      projection,
      wall,
      toggleWall,
    }),
    [initial, snapshot, nowMinute, failingSince, clock, offset, mergedVehicles, mergedTrips, projection, wall, toggleWall],
  );
  return <LiveDayContext.Provider value={value}>{children}</LiveDayContext.Provider>;
}

/** « 10:42:30 » of a server instant, Europe/Paris. */
function timeOfDay(epoch: number): string {
  return new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(epoch);
}

/** The line above the board: now, the last update, where the day stands, « Plein écran ». */
export function LiveDayBar() {
  const live = useLiveDay();
  if (!live) return null;
  const routes = [...live.projection.routes.values()];
  const started = routes.filter((r) => r.started || r.closed > 0).length;
  const stops = routes.reduce((sum, r) => sum + r.total, 0);
  const closed = routes.reduce((sum, r) => sum + r.closed, 0);
  const late = routes.filter((r) => (r.delayMinutes ?? 0) >= SHOWN_DELAY_MIN).length;
  const { threatened, silent, overdue, longWaits } = live.projection;
  return (
    <div
      role="status"
      aria-live="off"
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border px-3 py-2 text-sm",
        live.stale ? "border-amber-300 bg-amber-50 text-amber-950" : "border-slate-200 bg-white text-slate-700",
      )}
    >
      <p className="flex items-center gap-2 font-semibold text-slate-900">
        <Radio aria-hidden className={cn("size-4", live.stale ? "text-amber-700" : "text-red-600 motion-safe:animate-pulse")} />
        Suivi du jour
        <span className="tabular rounded bg-red-600 px-1.5 py-0.5 text-xs font-bold text-white" title="Heure du serveur">
          {formatMinute(live.nowMinute)}
        </span>
      </p>
      {live.stale ? (
        <p className="flex items-center gap-1.5 font-medium">
          <TriangleAlert aria-hidden className="size-4 text-amber-700" />
          Suivi interrompu (pas de réponse du serveur)&nbsp;: données de {timeOfDay(live.updatedAt)}
        </p>
      ) : (
        <p className="tabular text-slate-500">Actualisé à {timeOfDay(live.updatedAt)}, toutes les 30&nbsp;s</p>
      )}
      <p className="tabular">
        {started}/{routes.length} {routes.length > 1 ? "tournées commencées" : "tournée commencée"} · {closed}/{stops} arrêts faits
        {late > 0 ? <> · <span className="font-medium text-amber-800">{pluralize(late, "tournée en retard", "tournées en retard")}</span></> : null}
      </p>
      {threatened.length + silent.length + overdue.length + longWaits.length > 0 ? (
        <p className="font-medium text-red-800">
          {[
            threatened.length > 0 ? pluralize(threatened.length, "RDV menacé", "RDV menacés") : null,
            silent.length > 0 ? pluralize(silent.length, "tournée silencieuse", "tournées silencieuses") : null,
            overdue.length > 0 ? pluralize(overdue.length, "arrêt sans statut", "arrêts sans statut") : null,
            longWaits.length > 0 ? pluralize(longWaits.length, "attente trop longue", "attentes trop longues") : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}
      <Button size="sm" variant="secondary" className="ml-auto" onClick={live.toggleWall} aria-pressed={live.wall}>
        {live.wall ? <Minimize2 aria-hidden className="size-3.5" /> : <Maximize2 aria-hidden className="size-3.5" />}
        {live.wall ? "Quitter le plein écran" : "Plein écran"}
      </Button>
    </div>
  );
}
