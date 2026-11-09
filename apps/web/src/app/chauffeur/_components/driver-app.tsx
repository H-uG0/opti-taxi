"use client";

/**
 * Field side of the driver app, shared by the header and the stop cards:
 * - the status queue (../_lib/status-queue.ts): every tap is saved on the
 *   phone with its time, then sent; sending starts again when the app opens,
 *   comes back to the screen, gets the network back, and every 30 s while
 *   statuses wait;
 * - the session: renewed close to its end whenever the app reaches the server
 *   (../_lib/status-send.ts renewSession), its end shown and warned about;
 * - after statuses reach the server, or after a refusal (the page is stale),
 *   one router refresh a moment later (several answers in a row give one
 *   refresh, never a refresh per tap);
 * - after a provisional password is changed (the layout renders again with
 *   mustChangePassword false), the statuses that waited for it are sent;
 * - the service worker (public/sw.js), which shows a minimal offline page
 *   (regulation number, time of the last sync) when the app is reopened with
 *   no network. It is told the regulation number and the time of each render.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { RegulatorContact } from "../_lib/links";
import { serverReachable } from "../_lib/reachability";
import { EMPTY_QUEUE_SNAPSHOT, StatusQueue, type QueueSnapshot } from "../_lib/status-queue";
import { openIndexedDbQueue } from "../_lib/status-queue-idb";
import { renewSession, sendQueuedStatus, type SessionState } from "../_lib/status-send";
import type { StopAction } from "../_lib/transitions";

/** While statuses wait, sending is tried again this often (the "online" event is unreliable on phones). */
const RETRY_EVERY_MS = 30_000;
/** The session is checked (and renewed close to its end) this often while the app is on screen. */
const SESSION_CHECK_EVERY_MS = 10 * 60_000;
/** Refresh of the roadmap after statuses reached the server (or were refused). */
const REFRESH_AFTER_MS = 1500;

type DriverApp = {
  queue: StatusQueue;
  submit: (stopId: string, action: StopAction) => void;
  cancelQueued: (stopId: string) => void;
  sendNow: () => void;
  /** End of the session on the phone's clock (epoch ms), null until known. */
  sessionExpiresAt: number | null;
  /** The session still prolongs itself when the app reaches the server (false 7 days after the sign-in). */
  sessionRenewable: boolean;
  /** The server answered that the session is over. */
  sessionLost: boolean;
  /** Server clock of the latest render of the roadmap on this phone (epoch ms), null until one. */
  lastRenderAt: number | null;
  /** A render of the page reached the phone (server clock at render time). */
  serverRendered: (serverTime: number) => void;
};

const DriverAppContext = createContext<DriverApp | null>(null);

export function useDriverApp(): DriverApp {
  const app = useContext(DriverAppContext);
  if (!app) throw new Error("useDriverApp outside DriverAppProvider");
  return app;
}

const serverSnapshot = () => EMPTY_QUEUE_SNAPSHOT;

export function useQueueSnapshot(): QueueSnapshot {
  const { queue } = useDriverApp();
  return useSyncExternalStore(queue.subscribe, queue.getSnapshot, serverSnapshot);
}

/** Tells the service worker what its offline page shows: the regulation number and the last sync. */
function postToServiceWorker(regulator: RegulatorContact | null): void {
  if (!("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.ready
    .then((registration) =>
      registration.active?.postMessage({
        type: "roadmap-synced",
        at: Date.now(),
        regulator: regulator ? { number: regulator.number, href: regulator.href } : null,
      }),
    )
    .catch(() => undefined);
}

export function DriverAppProvider({
  ownerId,
  mustChangePassword,
  sessionExpiresAt: initialExpiresAt,
  regulator,
  children,
}: {
  /**
   * The signed-in account: its queue is its own (one IndexedDB database per
   * account), and each request says so (the server keeps the statuses waiting
   * if the cookie is now another account's).
   */
  ownerId: string;
  /** The password is still the provisional one (statuses wait for the change). */
  mustChangePassword: boolean;
  /** Session end read from the cookie at render (ISO), before any renewal. */
  sessionExpiresAt: string | null;
  regulator: RegulatorContact | null;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [expiresAt, setExpiresAt] = useState<number | null>(() => (initialExpiresAt ? Date.parse(initialExpiresAt) : null));
  const [sessionLost, setSessionLost] = useState(false);
  const [sessionRenewable, setSessionRenewable] = useState(true);
  const [lastRenderAt, setLastRenderAt] = useState<number | null>(null);
  const refreshTimer = useRef<number | null>(null);
  const regulatorRef = useRef(regulator);

  useEffect(() => {
    regulatorRef.current = regulator;
  }, [regulator]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void serverReachable().then((reachable) => {
        if (reachable) startTransition(() => router.refresh());
      });
    }, REFRESH_AFTER_MS);
  }, [router]);

  const [queue] = useState(
    () =>
      new StatusQueue({
        openStorage: () => openIndexedDbQueue(ownerId),
        send: (status) => sendQueuedStatus(status, ownerId),
        now: () => Date.now(),
      }),
  );

  // After each status received: the session end it reports (on the phone's clock), and a refresh soon.
  useEffect(
    () =>
      queue.onDelivered((outcome) => {
        if (outcome.sessionExpiresAt) setExpiresAt(Date.parse(outcome.sessionExpiresAt) - (outcome.serverTime - Date.now()));
        scheduleRefresh();
      }),
    [queue, scheduleRefresh],
  );
  // After a refusal the page is stale (trip cancelled or moved, status changed by the crew mate): a
  // refresh too, so the stop stops offering a button the server refuses.
  useEffect(() => queue.onRefused(() => scheduleRefresh()), [queue, scheduleRefresh]);

  const applySession = useCallback(
    (result: SessionState | "lost" | null) => {
      if (result === "lost") {
        setSessionLost(true);
      } else if (result !== null) {
        setSessionLost(false);
        setExpiresAt(result.expiresAt);
        setSessionRenewable(result.renewable);
        if (queue.getSnapshot().sessionLost) void queue.resume();
      }
    },
    [queue],
  );
  const checkSession = useCallback(() => renewSession(ownerId).then(applySession), [ownerId, applySession]);

  // The provisional password was just changed (the action renders the layout again): send what waited for it.
  useEffect(() => {
    if (mustChangePassword || queue.getSnapshot().sessionLost !== "password") return;
    void queue.resume();
    void checkSession();
  }, [mustChangePassword, queue, checkSession]);

  useEffect(() => {
    void queue.start().then(() => queue.flush());
    void checkSession();
    if ("serviceWorker" in navigator) {
      // Scope /chauffeur: only the driver app's pages; see public/sw.js for what it keeps.
      navigator.serviceWorker.register("/sw.js", { scope: "/chauffeur" }).catch(() => undefined);
    }

    const wakeUp = () => {
      if (document.visibilityState !== "visible") return;
      void queue.flush();
      void checkSession();
    };
    const retry = window.setInterval(() => {
      const snapshot = queue.getSnapshot();
      if (snapshot.pending > 0 && snapshot.sessionLost === null) void queue.flush();
    }, RETRY_EVERY_MS);
    const sessionCheck = window.setInterval(() => {
      if (document.visibilityState === "visible") void checkSession();
    }, SESSION_CHECK_EVERY_MS);
    document.addEventListener("visibilitychange", wakeUp);
    window.addEventListener("online", wakeUp);
    return () => {
      window.clearInterval(retry);
      window.clearInterval(sessionCheck);
      document.removeEventListener("visibilitychange", wakeUp);
      window.removeEventListener("online", wakeUp);
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    };
  }, [queue, checkSession]);

  const serverRendered = useCallback(
    (serverTime: number) => {
      queue.serverRendered(serverTime);
      setLastRenderAt(serverTime);
      postToServiceWorker(regulatorRef.current);
    },
    [queue],
  );

  const value = useMemo<DriverApp>(
    () => ({
      queue,
      submit: (stopId, action) => {
        if (typeof navigator.vibrate === "function") navigator.vibrate(25);
        void queue.submit(stopId, action);
      },
      cancelQueued: (stopId) => void queue.cancelQueued(stopId),
      sendNow: () => {
        void queue.resume();
        void checkSession();
      },
      sessionExpiresAt: expiresAt,
      sessionRenewable,
      sessionLost,
      lastRenderAt,
      serverRendered,
    }),
    [queue, checkSession, expiresAt, sessionRenewable, sessionLost, lastRenderAt, serverRendered],
  );

  return <DriverAppContext.Provider value={value}>{children}</DriverAppContext.Provider>;
}

/** Placed in each render of the roadmap: statuses saved before `at` (server clock) are now on screen. */
export function ServerRenderMark({ at }: { at: number }) {
  const { serverRendered } = useDriverApp();
  useEffect(() => serverRendered(at), [serverRendered, at]);
  return null;
}

function subscribeMinute(onChange: () => void): () => void {
  let timer = 0;
  const tick = () => {
    onChange();
    timer = window.setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
  };
  timer = window.setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
  document.addEventListener("visibilitychange", onChange);
  return () => {
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", onChange);
  };
}

const minuteNow = () => Math.floor(Date.now() / 60_000) * 60_000;
const noClock = () => null;

/** The phone's clock, updated at each minute (null during the server render). */
export function useMinuteClock(): number | null {
  return useSyncExternalStore(subscribeMinute, minuteNow, noClock);
}
