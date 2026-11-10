"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Lock, TriangleAlert, ZoomIn } from "lucide-react";
import { cn } from "@/components/ui/cn";
import type { TripView } from "@/lib/planning/types";
import { DIRECTION_LABELS } from "@/lib/labels";
import { formatMinute } from "@/lib/time";

export type ClusterEntry = { tripId: string; from: number; to: number };

/** « 07:10 – 07:35 » or the trip's window when it has no vehicle. */
function entryTime(entry: ClusterEntry): string {
  return `${formatMinute(entry.from)} – ${formatMinute(entry.to)}`;
}

function tripLine(trip: TripView | undefined): string {
  if (!trip) return "Course inconnue";
  return trip.direction === "OUTBOUND"
    ? `${DIRECTION_LABELS.OUTBOUND} · RDV ${formatMinute(trip.appointmentMinute)}`
    : `${DIRECTION_LABELS.RETURN} · fin de séance ${formatMinute(trip.readyMinute)}`;
}

const WIDTH = 288;

/**
 * The trips of a « +3 » target of the timeline, in a small dialog under it:
 * each one selects its trip; « Zoomer sur ce créneau » widens the timeline
 * there. Rendered in the page's body (the timeline's cells clip their
 * content). Escape, a click outside or a scroll closes it; the focus goes back
 * to the target.
 */
export function ClusterPopover({
  anchor,
  title,
  entries,
  trips,
  violatingTripIds,
  selectedTripId,
  canZoom,
  onSelect,
  onZoom,
  onClose,
}: {
  anchor: HTMLElement;
  title: string;
  entries: ClusterEntry[];
  trips: Readonly<Record<string, TripView>>;
  violatingTripIds: ReadonlySet<string>;
  selectedTripId: string | null;
  canZoom: boolean;
  onSelect: (tripId: string) => void;
  onZoom: () => void;
  /** `restoreFocus`: put the focus back on the target (Escape, a choice). */
  onClose: (restoreFocus: boolean) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const height = box.current?.offsetHeight ?? 0;
    const below = rect.bottom + 4;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 4) : below;
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - WIDTH - 8);
    setPosition({ top, left });
  }, [anchor, entries.length]);

  // A list whose target is gone (filter, refresh of the plan) closes.
  useEffect(() => {
    if (!anchor.isConnected) onClose(false);
  });

  // The first trip gets the focus once, when the list opens.
  useEffect(() => {
    box.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose(false);
    };
    const onScroll = (e: Event) => {
      if (!box.current?.contains(e.target as Node)) onClose(false);
    };
    const onResize = () => onClose(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={box}
      role="dialog"
      aria-label={title}
      className="fixed z-[60] rounded-md border border-slate-200 bg-white p-1 text-sm shadow-lg"
      style={{ width: WIDTH, top: position?.top ?? -9999, left: position?.left ?? -9999 }}
      onKeyDown={(e) => {
        const buttons = Array.from(box.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
        const index = buttons.indexOf(e.target as HTMLButtonElement);
        let next: HTMLButtonElement | undefined;
        if (e.key === "Escape") {
          e.stopPropagation();
          e.preventDefault();
          onClose(true);
          return;
        }
        if (e.key === "ArrowDown") next = buttons[(index + 1) % buttons.length];
        else if (e.key === "ArrowUp") next = buttons[(index - 1 + buttons.length) % buttons.length];
        else if (e.key === "Home") next = buttons[0];
        else if (e.key === "End") next = buttons.at(-1);
        else if (e.key === "Tab") {
          // The dialog keeps the focus until a choice or Escape (it is a small list over the timeline).
          next = buttons[(index + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length];
        }
        if (next) {
          e.preventDefault();
          next.focus();
        }
      }}
    >
      <p className="px-2 pt-1 pb-1.5 text-xs font-medium text-slate-500">{title}</p>
      <ul className="max-h-72 overflow-y-auto">
        {entries.map((entry) => {
          const trip = trips[entry.tripId];
          const violating = violatingTripIds.has(entry.tripId);
          return (
            <li key={entry.tripId}>
              <button
                type="button"
                aria-pressed={entry.tripId === selectedTripId}
                onClick={() => {
                  onSelect(entry.tripId);
                  onClose(true);
                }}
                className={cn(
                  "flex min-h-8 w-full items-start gap-2 rounded px-2 py-1 text-left hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-brand-600",
                  entry.tripId === selectedTripId && "bg-brand-50",
                )}
              >
                <span className="tabular shrink-0 pt-px text-xs text-slate-500">{entryTime(entry)}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1 font-medium text-slate-900">
                    <span className="truncate">{trip?.patientName ?? "Course inconnue"}</span>
                    {trip?.lockedVehicleId ? <Lock aria-label="figée" className="size-3 shrink-0 text-slate-600" /> : null}
                    {violating ? <TriangleAlert aria-label="violation" className="size-3.5 shrink-0 text-slate-900" /> : null}
                  </span>
                  <span className="block text-xs text-slate-600">{tripLine(trip)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {canZoom ? (
        <button
          type="button"
          onClick={() => {
            onZoom();
            onClose(false);
          }}
          className="mt-1 flex min-h-8 w-full items-center gap-1.5 rounded border-t border-slate-100 px-2 py-1 text-left text-xs font-medium text-brand-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-brand-600"
        >
          <ZoomIn aria-hidden className="size-3.5" />
          Zoomer sur ce créneau
        </button>
      ) : null}
    </div>,
    document.body,
  );
}
