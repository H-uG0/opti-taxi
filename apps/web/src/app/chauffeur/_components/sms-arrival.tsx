"use client";

/**
 * « Prévenir par SMS » on a pickup at the patient's home (FLD-04): a text pre-filled with « J'arrive vers HH:MM »,
 * written with the iPhone or the Android syntax (links.ts smsHref), the time the planned one, or on the next stop
 * the arrival estimated from the clock and the latest status (as « En retard sur le planning »). Only the time goes
 * in the text, never a name. Mobile numbers only.
 */
import { useSyncExternalStore } from "react";
import { MessageSquareText } from "lucide-react";
import type { VehicleType } from "@prisma/client";
import { formatMinute, minuteOfDay } from "@/lib/time";
import { arrivalText, smsHref } from "../_lib/links";
import { isApplePhone } from "../_lib/nav-apps";
import { nextStopTiming } from "../_lib/punctuality";
import { useMinuteClock } from "./driver-app";

const noSubscription = () => () => undefined;
const applePhone = () => isApplePhone(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);

export function SmsArrival({
  phone,
  vehicle,
  plannedMinute,
  timing,
}: {
  phone: string;
  vehicle: VehicleType;
  plannedMinute: number;
  /** The next stop: its planned arrival and the anchor of the live reading. */
  timing: { plannedArrivalMinute: number; anchorArrivalMinute: number | null } | null;
}) {
  const apple = useSyncExternalStore(noSubscription, applePhone, () => false);
  const now = useMinuteClock();
  const expected =
    timing && now !== null
      ? Math.max(
          plannedMinute,
          nextStopTiming({
            nowMinute: minuteOfDay(new Date(now)),
            plannedArrivalMinute: timing.plannedArrivalMinute,
            plannedMinute,
            anchorArrivalMinute: timing.anchorArrivalMinute,
            appointmentMinute: null,
          }).expectedMinute,
        )
      : plannedMinute;
  // Rounded up to 5 min: a time the patient can hold the crew to.
  const shown = formatMinute(Math.ceil(expected / 5) * 5);
  const href = smsHref(phone, arrivalText(vehicle, shown), apple);
  if (!href) return null;
  return (
    <a
      href={href}
      className="flex min-h-12 touch-manipulation items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-slate-800 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
    >
      <MessageSquareText aria-hidden className="size-5 shrink-0 text-brand-700" />
      <span className="min-w-0">
        <span className="block text-sm font-semibold">Prévenir par SMS</span>
        <span className="tabular block text-sm text-slate-600">«&#x202F;J&apos;arrive vers {shown}&#x202F;»</span>
      </span>
    </a>
  );
}
