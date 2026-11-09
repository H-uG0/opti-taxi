/**
 * Early, on time or late: the live reading of the next stop (updated each
 * minute on the phone) and the lateness of a recorded stop. An outbound
 * dropoff is judged against the patient's appointment, not the planned time
 * (dropped off at 07:40 for a 07:30 appointment planned at 07:15: 10 min late
 * for the appointment, not 25). Pure module (unit-tested).
 */
import { formatDuration } from "@/lib/time";

/** Within this many minutes of the planned time, a stop is on time. */
export const ON_TIME_MARGIN_MIN = 5;

export type NextStopTimingInput = {
  /** Now, minutes since midnight (Europe/Paris). */
  nowMinute: number;
  /** Planned arrival at the stop (before any planned wait). */
  plannedArrivalMinute: number;
  /** Planned time of the stop as the roadmap shows it (start of service). */
  plannedMinute: number;
  /**
   * Earliest arrival given the latest status recorded on the route: its real
   * time plus the planned time from its planned moment (plannedTapMinute) to
   * this stop's arrival. Null before the first one.
   */
  anchorArrivalMinute: number | null;
  /** Appointment of an outbound dropoff, null otherwise. */
  appointmentMinute: number | null;
};

export type NextStopTiming = {
  status: "early" | "on_time" | "late";
  /** How early or late, in minutes (0 on time). */
  minutes: number;
  reference: "planned" | "appointment";
  /** Estimated arrival, minutes since midnight. */
  expectedMinute: number;
};

/**
 * The arrival is estimated as the later of now and the anchor (or the planned
 * arrival before any recorded status): no position is read from the phone.
 * Late when that arrival is more than ON_TIME_MARGIN_MIN after the planned
 * time, or after the appointment of an outbound dropoff; early when it is more
 * than ON_TIME_MARGIN_MIN before the planned arrival.
 */
export function nextStopTiming(input: NextStopTimingInput): NextStopTiming {
  const expectedMinute = Math.max(input.nowMinute, input.anchorArrivalMinute ?? input.plannedArrivalMinute);
  const reference = input.appointmentMinute !== null ? "appointment" : "planned";
  const late =
    input.appointmentMinute !== null
      ? expectedMinute - input.appointmentMinute
      : expectedMinute - input.plannedMinute - ON_TIME_MARGIN_MIN;
  if (late > 0) {
    const minutes = input.appointmentMinute !== null ? late : expectedMinute - input.plannedMinute;
    return { status: "late", minutes, reference, expectedMinute };
  }
  const early = input.plannedArrivalMinute - expectedMinute;
  if (early > ON_TIME_MARGIN_MIN) return { status: "early", minutes: early, reference, expectedMinute };
  return { status: "on_time", minutes: 0, reference, expectedMinute };
}

/**
 * The reading in words. « sur le planning »: the route as planned (a stop
 * reached early only means a wait there), « sur le RDV »: the appointment.
 */
export function nextStopTimingText(timing: NextStopTiming): string {
  // Non-breaking spaces: "15 min" never splits across two lines.
  const duration = formatDuration(timing.minutes).replace(/ /g, "\u00a0");
  switch (timing.status) {
    case "late":
      return timing.reference === "appointment"
        ? `En retard sur le RDV : environ ${duration}`
        : `En retard sur le planning : environ ${duration}`;
    case "early":
      return `En avance sur le planning : environ ${duration}`;
    case "on_time":
      return timing.reference === "appointment" ? "À l'heure pour le RDV" : "À l'heure";
  }
}

/**
 * Planned minute of the status recorded at a stop. « Pris en charge » is
 * tapped once the patient is on board, at the planned departure from the
 * pickup (after its service time: 5 min, more for a lying patient or a
 * wheelchair); « Déposé » on arrival at the dropoff, and « Patient absent »
 * after waiting at the pickup, both against the planned start. Same reading
 * as the history simulation (prisma/history/field.ts plannedTapMinute) and
 * the traffic calibration (lib/domain/traffic-observed.ts).
 */
export function plannedTapMinute(stop: {
  kind: "PICKUP" | "DROPOFF";
  /** The recorded status is « Patient absent » (a pickup). */
  noShow: boolean;
  startMinute: number;
  departureMinute: number;
}): number {
  return stop.kind === "PICKUP" && !stop.noShow ? stop.departureMinute : stop.startMinute;
}

export type RecordedLateness = { minutes: number; reference: "planned" | "appointment" };

/**
 * Lateness of a recorded stop: against the appointment for an outbound
 * dropoff that has one, against the planned moment of the status otherwise
 * (plannedTapMinute: the planned departure for a pickup).
 */
export function recordedLateness(stop: {
  completedMinute: number;
  plannedTapMinute: number;
  appointmentMinute: number | null;
}): RecordedLateness {
  return stop.appointmentMinute !== null
    ? { minutes: stop.completedMinute - stop.appointmentMinute, reference: "appointment" }
    : { minutes: stop.completedMinute - stop.plannedTapMinute, reference: "planned" };
}

/** Whether a recorded lateness is worth showing: any delay after an appointment, 5 min or more otherwise. */
export function latenessShown(lateness: RecordedLateness | null): boolean {
  if (!lateness) return false;
  return lateness.reference === "appointment" ? lateness.minutes > 0 : Math.abs(lateness.minutes) >= ON_TIME_MARGIN_MIN;
}
