/**
 * What the planning page says of a route under way (DAY-01), from its projection (live-day.ts): the chip of its row
 * on the timeline (« 5/12 · +12 min »), the lines of the vehicle panel and the time of each stop there (« fait à
 * 10:31 », « vers 10:54, +12 min »), the trip panel's line. Pure, unit-tested.
 */
import { formatDuration, formatMinute } from "@/lib/time";
import { SHOWN_DELAY_MIN, type RouteProjection, type StopProjection } from "./live-day";
import { pluralize } from "./format";

/** From this delay on, a route is shown in red. */
export const ALERT_DELAY_MIN = 15;

export type LiveRowView = { label: string; tone: "ok" | "late" | "alert"; title: string };

const minutes = formatDuration;

function overdueOf(route: RouteProjection): StopProjection | undefined {
  return route.stops.find((stop) => stop.state === "pending" && stop.overdueMinutes !== null);
}

/** The row's chip: progress, delay of the next stop, silence or a stop overdue. */
export function liveRowView(route: RouteProjection): LiveRowView {
  const progress = `${route.closed}/${route.total}`;
  const done = `${pluralize(route.closed, "arrêt fait", "arrêts faits")} sur ${route.total}`;
  if (route.finished) return { label: "Terminée", tone: "ok", title: `Tournée terminée\u00a0: ${done}` };
  if (route.silentSinceMinute !== null) {
    return { label: "Aucun statut", tone: "alert", title: `Tournée silencieuse\u00a0: aucun statut depuis ${formatMinute(route.silentSinceMinute)}` };
  }
  const overdue = overdueOf(route);
  const delay = route.delayMinutes ?? 0;
  const delayText = delay >= SHOWN_DELAY_MIN ? ` · +${minutes(delay)}` : "";
  if (overdue) {
    return { label: `${progress}${delayText}`, tone: "alert", title: `${done}\u00a0; arrêt sans statut depuis ${minutes(overdue.overdueMinutes ?? 0)}` };
  }
  const tone = delay >= ALERT_DELAY_MIN ? "alert" : delay >= SHOWN_DELAY_MIN ? "late" : "ok";
  return { label: `${progress}${delayText}`, tone, title: delay >= SHOWN_DELAY_MIN ? `${done}\u00a0; retard estimé ${minutes(delay)}` : `${done}\u00a0; à l'heure` };
}

export type VehicleLiveView = {
  /** « 5 arrêts faits sur 12 · dernier statut à 10:31 · retard estimé 12 min ». */
  summary: string;
  /** Silence or a stop overdue, null otherwise. */
  alert: string | null;
  /** Per stop id: what happened there, or when it should now happen. */
  stops: Record<string, { text: string; tone: "done" | "late" | "ok" | "alert" }>;
};

export function vehicleLiveView(route: RouteProjection): VehicleLiveView {
  const parts = [`${pluralize(route.closed, "arrêt fait", "arrêts faits")} sur ${route.total}`];
  if (route.lastStatusMinute !== null) parts.push(`dernier statut à ${formatMinute(route.lastStatusMinute)}`);
  const delay = route.delayMinutes ?? 0;
  if (!route.finished) parts.push(delay >= SHOWN_DELAY_MIN ? `retard estimé ${minutes(delay)}` : "à l'heure");
  const overdue = overdueOf(route);
  const alert =
    route.silentSinceMinute !== null
      ? `Aucun statut depuis ${formatMinute(route.silentSinceMinute)}\u00a0: appelez l'équipage.`
      : overdue
        ? `Arrêt sans statut depuis ${minutes(overdue.overdueMinutes ?? 0)}\u00a0: appelez l'équipage.`
        : null;
  const stops: VehicleLiveView["stops"] = {};
  for (const stop of route.stops) {
    const text = stopLiveText(stop, "fait");
    if (text) stops[stop.stopId] = text;
  }
  return { summary: parts.join(" · "), alert, stops };
}

/** What happened at a stop, or when it should now happen; `done` agrees with what is named (« arrêt fait », « dépose faite »). */
function stopLiveText(stop: StopProjection, done: "fait" | "faite"): VehicleLiveView["stops"][string] | null {
  if (stop.state === "done") return { text: `${done} à ${formatMinute(stop.kind === "PICKUP" ? stop.departureMinute : stop.startMinute)}`, tone: "done" };
  if (stop.state === "missing") return { text: "sans statut", tone: "alert" };
  if (stop.state !== "pending") return null;
  return stop.delayMinutes >= SHOWN_DELAY_MIN
    ? { text: `vers ${formatMinute(stop.startMinute)}, +${minutes(stop.delayMinutes)}`, tone: stop.overdueMinutes !== null || stop.delayMinutes >= ALERT_DELAY_MIN ? "alert" : "late" }
    : { text: "à l'heure", tone: "ok" };
}

/** The trip panel's line: « prise en charge faite à 08:12 · dépose vers 09:05, +12 min »; null when nothing to say. */
export function tripLiveText(route: RouteProjection, tripId: string): string | null {
  const parts = (["PICKUP", "DROPOFF"] as const).flatMap((kind) => {
    const stop = route.stops.find((s) => s.tripId === tripId && s.kind === kind);
    const text = stop ? stopLiveText(stop, "faite") : null;
    return text ? [`${kind === "PICKUP" ? "prise en charge" : "dépose"} ${text.text}`] : [];
  });
  return parts.length > 0 ? parts.join(" · ") : null;
}
