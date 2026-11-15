"use client";

/**
 * The next stop at the thumb's reach (FLD-04), for a phone in its cradle: a bar fixed at the bottom of the screen,
 * above the safe area (iPhone's home bar), with the big status button of the next stop, « Itinéraire » (the
 * navigation app used last) and « Appeler » (the patient, the reception, else the regulation). The next stop is the
 * first one still to do that has no status on the phone yet, so it moves on at the tap, offline too — but not at
 * once: after a tap on its big button the bar stays BAR_HOLD_MS on the stop just recorded (« Pris en charge à
 * 10:41 », nothing to tap where the button was), so a double tap never records the next stop's status too.
 *
 * On opening, the page goes to that stop's card (once, unless the driver already scrolled or followed a link), and
 * while the roadmap is on screen it keeps the phone awake (Screen Wake Lock, where the phone offers it).
 */
import { useEffect, useRef, useState } from "react";
import { Check, ChevronUp, Navigation, Phone } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { formatMinute, minuteOfDay } from "@/lib/time";
import { STOP_KIND_LABELS } from "@/lib/labels";
import { isArrivalAction } from "../_lib/transitions";
import { useDriverApp, useQueueSnapshot } from "./driver-app";
import { useFirstNavLink } from "./nav-links";

/** A stop still to do, as the bar shows it. No note, no address on screen (the card has them). */
export type BarStop = {
  id: string;
  kind: "PICKUP" | "DROPOFF";
  plannedMinute: number;
  patient: string;
  primary: "PICKUP" | "DROPOFF" | null;
  /** On a drop-off whose pickup is not recorded: the pickup's stop (a pickup tapped on the phone unlocks it). */
  pickupStopId: string | null;
  blocked: boolean;
  lat: number;
  lng: number;
  /** Whom « Appeler » calls, null when nobody can be. */
  call: { href: string; label: string } | null;
};

/** Keeps the screen on while the page is visible (released by the phone when it is hidden, asked again on return). */
function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !("wakeLock" in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;
    const request = () => {
      if (document.visibilityState !== "visible" || (sentinel && !sentinel.released)) return;
      navigator.wakeLock
        .request("screen")
        .then((lock) => {
          if (cancelled) void lock.release();
          else sentinel = lock;
        })
        .catch(() => undefined);
    };
    request();
    document.addEventListener("visibilitychange", request);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", request);
      void sentinel?.release().catch(() => undefined);
    };
  }, [active]);
}

/** After a tap on the bar's big button, it stays this long on the stop just recorded before moving on. */
export const BAR_HOLD_MS = 2000;

const barButton =
  "inline-flex touch-manipulation select-none flex-col items-center justify-center gap-0.5 rounded-xl px-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";

export function NextStopBar({
  stops,
  autoScroll,
}: {
  stops: readonly BarStop[];
  /** Go to the next stop's card on opening: once the route is under way (before, its start is the odometer's). */
  autoScroll: boolean;
}) {
  const { submit } = useDriverApp();
  const { byStop } = useQueueSnapshot();
  // The status just tapped on the bar: shown in place of the button for a moment (a second tap lands on nothing).
  const [held, setHeld] = useState<{ stopId: string; action: "PICKUP" | "DROPOFF"; minute: number } | null>(null);
  useEffect(() => {
    if (!held) return;
    const timer = window.setTimeout(() => setHeld(null), BAR_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [held]);
  const heldStop = held ? stops.find((s) => s.id === held.stopId) : undefined;
  // The first stop still to do on the phone: a status tapped here moves the bar on (after the hold).
  const stop =
    heldStop ??
    stops.find((s) => {
      const local = byStop[s.id];
      return !local || local.action === "UNDO" || isArrivalAction(local.action);
    });
  const nav = useFirstNavLink(stop?.lat ?? Number.NaN, stop?.lng ?? Number.NaN);
  useWakeLock(stop !== undefined);

  // Once, on opening: to the next stop's card, unless the driver came for something else.
  const scrolled = useRef(false);
  const firstId = stops[0]?.id;
  useEffect(() => {
    if (scrolled.current || !firstId || !autoScroll) return;
    scrolled.current = true;
    if (window.location.hash || window.scrollY > 40) return;
    document.getElementById(`stop-${firstId}`)?.scrollIntoView({ block: "start" });
  }, [firstId, autoScroll]);

  if (!stop) return null;
  const pickupLocal = stop.pickupStopId ? byStop[stop.pickupStopId] : undefined;
  const blocked = stop.blocked && pickupLocal?.action !== "PICKUP";
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-300 bg-white/95 shadow-[0_-4px_12px_rgb(0_0_0/0.08)] backdrop-blur supports-[backdrop-filter]:bg-white/85">
      <div className="mx-auto max-w-lg space-y-2 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <a
          href={`#stop-${stop.id}`}
          className="flex min-h-9 items-center gap-2 text-sm text-slate-800 focus-visible:outline-2 focus-visible:outline-brand-600"
        >
          <span className="tabular text-base font-bold text-slate-950">{formatMinute(stop.plannedMinute)}</span>
          <span className="font-semibold">{STOP_KIND_LABELS[stop.kind]}</span>
          <span className="min-w-0 flex-1 truncate">· {stop.patient}</span>
          <ChevronUp aria-hidden className="size-4 shrink-0 text-slate-500" />
          <span className="sr-only">Voir l&apos;arrêt</span>
        </a>
        <div className="grid grid-cols-[1fr_auto_auto] gap-2">
          {held && heldStop ? (
            <p
              role="status"
              className="inline-flex min-h-14 select-none items-center justify-center gap-2 rounded-xl border-2 border-emerald-600 bg-emerald-50 px-3 text-base font-semibold text-emerald-900"
            >
              <Check aria-hidden className="size-6 shrink-0" />
              <span>
                {held.action === "PICKUP" ? "Pris en charge" : "Déposé"} à <span className="tabular">{formatMinute(held.minute)}</span>
              </span>
            </p>
          ) : stop.primary ? (
            <button
              type="button"
              disabled={blocked}
              onClick={() => {
                if (!stop.primary || held) return;
                setHeld({ stopId: stop.id, action: stop.primary, minute: minuteOfDay(new Date()) });
                submit(stop.id, stop.primary);
              }}
              className={cn(
                "inline-flex min-h-14 touch-manipulation select-none items-center justify-center gap-2 rounded-xl px-3 text-lg font-semibold focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-brand-600",
                blocked ? "border-2 border-dashed border-slate-300 bg-slate-100 text-slate-500" : "bg-brand-700 text-white active:bg-brand-900",
              )}
            >
              <Check aria-hidden className="size-6" />
              {stop.primary === "PICKUP" ? "Pris en charge" : "Déposé"}
              <span className="sr-only"> : {stop.patient}</span>
            </button>
          ) : (
            <span />
          )}
          {nav ? (
            <a href={nav.href} target={nav.app === "geo" ? undefined : "_blank"} rel="noopener noreferrer" className={cn(barButton, "min-h-14 min-w-16 border border-slate-300 bg-white text-slate-800")}>
              <Navigation aria-hidden className="size-5 text-brand-700" />
              Itinéraire
            </a>
          ) : null}
          {stop.call ? (
            <a href={stop.call.href} className={cn(barButton, "min-h-14 min-w-16 border border-slate-300 bg-white text-slate-800")} aria-label={`Appeler ${stop.call.label}`}>
              <Phone aria-hidden className="size-5 text-brand-700" />
              Appeler
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}
