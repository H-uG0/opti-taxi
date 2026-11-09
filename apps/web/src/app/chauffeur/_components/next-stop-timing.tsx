"use client";

import { Clock } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { formatMinute, minuteOfDay } from "@/lib/time";
import { nextStopTiming, nextStopTimingText } from "../_lib/punctuality";
import { useMinuteClock, useQueueSnapshot } from "./driver-app";

const TONES = {
  early: "bg-sky-50 text-sky-900 ring-sky-200",
  on_time: "bg-emerald-50 text-emerald-900 ring-emerald-200",
  late: "bg-amber-100 text-amber-950 ring-amber-300",
} as const;

/**
 * « En avance / À l'heure / En retard » on the next stop of today's route,
 * read on the phone's clock and updated each minute (nothing during the server
 * render). An outbound dropoff is judged against the appointment. Hidden once
 * a status of the stop is tapped on the phone (waiting in a white zone, or not
 * yet on the page): the crew is past it, and it would keep counting late.
 */
export function NextStopTiming({
  stopId,
  plannedArrivalMinute,
  plannedMinute,
  anchorArrivalMinute,
  appointmentMinute,
}: {
  stopId: string;
  plannedArrivalMinute: number;
  plannedMinute: number;
  anchorArrivalMinute: number | null;
  appointmentMinute: number | null;
}) {
  const now = useMinuteClock();
  const local = useQueueSnapshot().byStop[stopId];
  if (now === null || (local && local.action !== "UNDO")) return null;
  const timing = nextStopTiming({
    nowMinute: minuteOfDay(new Date(now)),
    plannedArrivalMinute,
    plannedMinute,
    anchorArrivalMinute,
    appointmentMinute,
  });
  return (
    <p className={cn("flex items-start gap-2 rounded-lg px-3 py-1.5 text-base ring-1 ring-inset", TONES[timing.status])}>
      <Clock aria-hidden className="mt-1 size-4 shrink-0" />
      <span>
        <span className="font-semibold">{nextStopTimingText(timing)}</span>
        {timing.status === "late" ? (
          <span className="tabular block text-sm">Arrivée estimée vers {formatMinute(timing.expectedMinute)}</span>
        ) : null}
      </span>
    </p>
  );
}
