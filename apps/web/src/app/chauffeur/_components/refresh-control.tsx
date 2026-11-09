"use client";

/**
 * "Actualiser" button and automatic refresh when the driver comes back to the
 * roadmap (after Waze or a phone call) or the network returns, so changes made
 * by the regulator show up without reloading.
 *
 * A failed router refresh makes Next.js fall back to a full page load, which
 * would replace the roadmap with the offline page. A tiny probe of a static
 * file is made first (serverReachable), and nothing is refreshed while it fails.
 */
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { serverReachable } from "../_lib/reachability";
import { useDriverApp } from "./driver-app";

/** Automatic refreshes are spaced by at least this much. */
const AUTO_REFRESH_INTERVAL_MS = 60_000;

export function RefreshControl({ renderedAt }: { renderedAt: string }) {
  const router = useRouter();
  const { sendNow } = useDriverApp();
  const [isPending, startTransition] = useTransition();
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const lastRefresh = useRef(0);

  const refresh = useCallback(
    async (manual: boolean) => {
      if (!manual && Date.now() - lastRefresh.current < AUTO_REFRESH_INTERVAL_MS) return;
      if (manual) setChecking(true);
      const reachable = await serverReachable();
      setChecking(false);
      if (!reachable) {
        if (manual) setMessage("Pas de réseau : la feuille affichée est celle du dernier chargement.");
        return;
      }
      lastRefresh.current = Date.now();
      setMessage(null);
      // « Actualiser » also sends the statuses waiting on the phone and renews the session if it is close to its end.
      if (manual) sendNow();
      startTransition(() => router.refresh());
    },
    [router, sendNow],
  );

  useEffect(() => {
    lastRefresh.current = Date.now();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh(false);
    };
    const onOnline = () => void refresh(false);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [refresh]);

  const busy = isPending || checking;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-600">
          Mis à jour à <span className="tabular font-semibold text-slate-800">{renderedAt}</span>
        </p>
        <button
          type="button"
          onClick={() => void refresh(true)}
          disabled={busy}
          className="inline-flex min-h-11 touch-manipulation items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-60"
        >
          <RotateCcw aria-hidden className={cn("size-4", busy && "animate-spin")} />
          {busy ? "Actualisation…" : "Actualiser"}
        </button>
      </div>
      {message ? (
        <p role="status" className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">
          {message}
        </p>
      ) : null}
    </div>
  );
}
