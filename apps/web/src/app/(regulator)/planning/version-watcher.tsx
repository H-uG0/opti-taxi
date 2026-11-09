"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DayVersion } from "@/lib/planning/version";
import { usePlanningActivity, useStaleFeedback } from "./planning-activity";

/** Poll period while a computation of the date runs. */
const POLL_MS = 5_000;

/**
 * Tells the regulator when the planning shown is no longer the one in the
 * database (re-optimized in another tab or by a colleague, a computation
 * finished, a trip changed): « Planning modifié — Recharger ». Asks
 * GET /planning/version only while a computation of the date runs (every 5 s)
 * and when the tab or the window comes back, never while an action of this
 * page is in flight (its own result reloads the page). Re-mounted (key) with
 * every new render of the page.
 */
export function PlanningVersionWatcher({ date, shown }: { date: string; shown: DayVersion }) {
  const router = useRouter();
  const { busy, setRemoteRunning } = usePlanningActivity();
  const staleFeedback = useStaleFeedback();
  const [remote, setRemote] = useState<DayVersion | null>(null);
  const busyRef = useRef(busy);
  const lastCheck = useRef(0);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  const check = useCallback(async () => {
    if (busyRef.current || Date.now() - lastCheck.current < POLL_MS / 2) return;
    lastCheck.current = Date.now();
    try {
      const response = await fetch(`/planning/version?date=${date}`, { cache: "no-store", redirect: "manual" });
      // Session expired: the page itself sends to the sign-in page.
      if (response.type === "opaqueredirect") {
        router.refresh();
        return;
      }
      if (!response.ok) return;
      setRemote((await response.json()) as DayVersion);
    } catch {
      // Network hiccup: the next check will tell.
    }
  }, [date, router]);

  const running = remote ? remote.running : shown.running;
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => void check(), POLL_MS);
    return () => window.clearInterval(id);
  }, [running, check]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [check]);

  // « Optimiser » and « Valider » follow the last poll: off while a computation runs (toolbar).
  useEffect(() => {
    setRemoteRunning(remote ? remote.running : null);
    return () => setRemoteRunning(null);
  }, [remote, setRemoteRunning]);

  const changed = remote !== null && (remote.version !== shown.version || remote.run !== shown.run);
  if (!changed || busy || staleFeedback) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-sky-200 bg-sky-50 px-4 py-2.5 text-sm text-sky-900"
    >
      <p className="min-w-0">
        <span className="font-semibold">Planning modifié</span> depuis l&apos;affichage (autre poste, autre onglet ou
        calcul terminé){remote?.running ? " ; une optimisation de cette date est en cours" : ""}.
      </p>
      <Button size="sm" variant="secondary" onClick={() => router.refresh()}>
        <RefreshCw aria-hidden className="size-3.5" />
        Recharger
      </Button>
    </div>
  );
}
