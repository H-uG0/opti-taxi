/**
 * The odometer of a vehicle (FLD-03): the readings the crew types at the start and the end of its day, and the
 * fill-ups' (lib/fleet/consumption.ts), together the last known mileage — which the maintenance deadlines read,
 * an electric vehicle charged at the depot included —, the real km of a day against the km planned, and the pace
 * that says « révision dans environ N jours ». Pure module (unit-tested).
 */
import type { OdometerMoment } from "@prisma/client";
import { addDays, formatShortDate } from "@/lib/time";

/** Beyond this many km a day since the last reading, a reading is unusual: the crew confirms it. */
export const MAX_DAILY_KM = 1000;
/**
 * The days a jump is weighed over, at most: after a long gap without any mileage known, a typo (152 000 for 125 200
 * a month after a fill-up) still asks for a confirmation instead of passing as « 30 days at 900 km ».
 */
export const MAX_JUMP_DAYS = 3;
/** Days of readings the pace of a vehicle is measured over. */
export const PACE_WINDOW_DAYS = 30;

/** A mileage known on a date: a reading of the crew or a fill-up. */
export type KmPoint = { date: string; km: number };

const nf = new Intl.NumberFormat("fr-FR");
const kmText = (km: number) => `${nf.format(km)} km`;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The highest mileage known (readings and fill-ups), with its date; null without any. */
export function latestKm(points: readonly KmPoint[]): KmPoint | null {
  return points.reduce<KmPoint | null>((best, p) => (!best || p.km > best.km || (p.km === best.km && p.date > best.date) ? p : best), null);
}

export type ReadingCheck =
  | { ok: true }
  /** Never recorded: the odometer does not go backwards, the end of a day is never below its start. */
  | { ok: false; kind: "refused"; message: string }
  /** Recorded once the crew confirms (a typing error is likely). */
  | { ok: false; kind: "confirm"; message: string };

/**
 * Whether a reading of `km` on `date` at `moment` can be recorded, given the other mileages known for the vehicle
 * (`others`: readings of other days and moments, fill-ups) and the start of that day (`startKm`, for an end reading).
 * On the reading's own day the moment orders them: the start comes before the day's fill-ups and its end, the end
 * after the start and the fill-ups.
 */
export function checkReading(args: {
  km: number;
  date: string;
  moment: OdometerMoment;
  others: readonly (KmPoint & { moment?: OdometerMoment | "FILL" })[];
  startKm: number | null;
}): ReadingCheck {
  const { km, date, moment, others, startKm } = args;
  if (moment === "END" && startKm !== null && km < startKm) {
    return { ok: false, kind: "refused", message: `Inférieur au relevé de départ du jour (${kmText(startKm)}) : vérifiez le compteur.` };
  }
  // Mileages before this one (an earlier day; the same day's start and fill-ups for an end): never higher.
  const before = others.filter((p) => p.date < date || (p.date === date && moment === "END" && (p.moment === "START" || p.moment === "FILL")));
  // Mileages after it (a later day; the same day's fill-ups and end for a start): never lower.
  const after = others.filter((p) => p.date > date || (p.date === date && moment === "START" && (p.moment === "END" || p.moment === "FILL")));
  const previous = latestKm(before);
  if (previous && km < previous.km) {
    return { ok: false, kind: "refused", message: `Inférieur au dernier relevé connu (${kmText(previous.km)} le ${formatShortDate(previous.date)}) : vérifiez le compteur.` };
  }
  const next = after.reduce<(typeof after)[number] | null>((low, p) => (!low || p.km < low.km ? p : low), null);
  if (next && km > next.km) {
    const which = next.date === date ? (next.moment === "END" ? "au relevé de retour du jour" : "à un plein du jour") : "à un relevé plus récent";
    const when = next.date === date ? "" : ` le ${formatShortDate(next.date)}`;
    return { ok: false, kind: "refused", message: `Supérieur ${which} (${kmText(next.km)}${when})\u00a0: vérifiez le compteur.` };
  }
  const base = moment === "END" && startKm !== null ? { km: startKm, date } : previous;
  if (base) {
    const days = Math.min(MAX_JUMP_DAYS, Math.max(1, daysBetween(base.date, date)));
    if (km - base.km > MAX_DAILY_KM * days) {
      const since = base.date === date ? "depuis le départ" : `depuis le relevé du ${formatShortDate(base.date)}`;
      return { ok: false, kind: "confirm", message: `+${kmText(km - base.km)} ${since} : saut inhabituel. Vérifiez, puis confirmez.` };
    }
  }
  return { ok: true };
}

/** A day of a vehicle with both readings: the real km against the km planned on its route. */
export type ReadingDay = { date: string; startKm: number; endKm: number; plannedKm: number | null };

/** Real km (end − start) and planned km over the days with both readings and a planned route. */
export function realAgainstPlanned(days: readonly ReadingDay[]): { days: number; realKm: number; plannedKm: number } {
  let realKm = 0;
  let plannedKm = 0;
  let count = 0;
  for (const day of days) {
    if (day.plannedKm === null || day.endKm < day.startKm) continue;
    realKm += day.endKm - day.startKm;
    plannedKm += day.plannedKm;
    count += 1;
  }
  return { days: count, realKm, plannedKm };
}

/**
 * Km a day at the current pace: the mileage gained between the first and the last point of the last PACE_WINDOW_DAYS
 * before `today`, over the days between them (at least 7, so a single long day does not set the pace). Null without
 * two points in the window.
 */
export function dailyPace(points: readonly KmPoint[], today: string): number | null {
  const from = addDays(today, -PACE_WINDOW_DAYS);
  const window = points.filter((p) => p.date >= from && p.date <= today);
  if (window.length < 2) return null;
  const first = window.reduce((a, b) => (b.date < a.date || (b.date === a.date && b.km < a.km) ? b : a));
  const last = window.reduce((a, b) => (b.date > a.date || (b.date === a.date && b.km > a.km) ? b : a));
  const gained = last.km - first.km;
  if (gained <= 0) return null;
  return gained / Math.max(7, daysBetween(first.date, last.date));
}

/** « révision dans environ N jours »: the days left before `dueKm` at `pace` km a day; null when not computable. */
export function daysUntilKm(dueKm: number, odometerKm: number | null, pace: number | null): number | null {
  if (odometerKm === null || pace === null || pace <= 0) return null;
  if (odometerKm >= dueKm) return 0;
  return Math.ceil((dueKm - odometerKm) / pace);
}

/** « environ 12 jours au rythme actuel », « moins d'un jour au rythme actuel »; null when not computable. */
export function paceText(days: number | null): string | null {
  if (days === null) return null;
  if (days <= 1) return "moins d'un jour au rythme actuel";
  return `environ ${days} jours au rythme actuel`;
}
