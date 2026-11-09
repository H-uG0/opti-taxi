/**
 * Calendar of the simulated history (pure, unit-tested): which past days are
 * simulated, and the real instants of the eve-of-day planning and of the
 * crews' statuses. Planned times are minutes since local midnight
 * (Europe/Paris); instants are UTC Dates, as stored in the database.
 */
import type { Rng } from "../seed/random";
import { addDays, fromIsoDate, isoDateOf, isoWeekday, minuteOfDay, startOfIsoWeek } from "@/lib/time";

const MINUTE_MS = 60_000;

// ---------------------------------------------------------------------------
// Local time -> instant

/** Offset of Europe/Paris from UTC at `instant`, in minutes: 60 in winter, 120 in summer. */
export function parisOffsetMinutes(instant: Date): number {
  const wallMs = fromIsoDate(isoDateOf(instant)).getTime() + minuteOfDay(instant) * MINUTE_MS;
  const utcMinuteMs = Math.floor(instant.getTime() / MINUTE_MS) * MINUTE_MS;
  return Math.round((wallMs - utcMinuteMs) / MINUTE_MS);
}

/**
 * Real instant of minute `minute` (since local midnight) of `isoDate` in
 * Europe/Paris, plus `second` seconds. The offset is read at the target
 * instant, so days on either side of a daylight saving change are right.
 */
export function parisInstant(isoDate: string, minute: number, second = 0): Date {
  const wallMs = fromIsoDate(isoDate).getTime() + minute * MINUTE_MS + second * 1000;
  // First guess with the offset of the wall time read as UTC, then corrected with the offset at the guess.
  const guess = wallMs - parisOffsetMinutes(new Date(wallMs)) * MINUTE_MS;
  return new Date(wallMs - parisOffsetMinutes(new Date(guess)) * MINUTE_MS);
}

// ---------------------------------------------------------------------------
// Simulated days

export type SimulationDates = {
  /** The dates to simulate, oldest first. */
  dates: string[];
  /** Working days passed over because they hold rows the simulation did not create, oldest first. */
  leftAlone: string[];
};

/**
 * The `count` working days before `today` (Monday to Saturday, with at least
 * one trip), oldest first. A date of `foreignDates` (rows the simulation did
 * not create: the seed's days, a day planned in the app) is passed over and
 * the search goes one working day further back, so the period still has
 * `count` simulated days. `today` and later dates are never included; the
 * search stops `maxLookbackDays` back.
 */
export function pickSimulationDates(
  today: string,
  count: number,
  options: { hasTrips: (isoDate: string) => boolean; foreignDates?: ReadonlySet<string>; maxLookbackDays?: number },
): SimulationDates {
  const { hasTrips, foreignDates = new Set<string>(), maxLookbackDays = 120 } = options;
  const dates: string[] = [];
  const leftAlone: string[] = [];
  for (let back = 1; back <= maxLookbackDays && dates.length < count; back++) {
    const date = addDays(today, -back);
    if (isoWeekday(date) === 7) continue;
    if (foreignDates.has(date)) {
      leftAlone.push(date);
      continue;
    }
    if (!hasTrips(date)) continue;
    dates.push(date);
  }
  return { dates: dates.reverse(), leftAlone: leftAlone.reverse() };
}

// ---------------------------------------------------------------------------
// Eve-of-day planning: « Optimiser demain » the day before, then phone calls and validation.

/** The planning of `isoDate` is built the day before (« Optimiser demain »). */
export function eveOf(isoDate: string): string {
  return addDays(isoDate, -1);
}

function plusSeconds(instant: Date, seconds: number): Date {
  return new Date(instant.getTime() + seconds * 1000);
}

/** First optimization: between 16:30 and 17:00 the day before. */
export function firstRunStart(isoDate: string, rng: Rng): Date {
  return parisInstant(eveOf(isoDate), rng.int(16 * 60 + 30, 17 * 60), rng.int(0, 59));
}

/** End of a run: the solver's wall time plus building the request and saving the plan. */
export function runFinish(startedAt: Date, wallTimeMs: number, rng: Rng): Date {
  return new Date(startedAt.getTime() + wallTimeMs + rng.int(600, 2_500));
}

/**
 * The absences and vehicles off the road that start on the day are recorded
 * from 40 to 90 min before the first run, 30 to 90 s apart.
 */
export function staffRecordInstants(firstRunAt: Date, count: number, rng: Rng): Date[] {
  let at = plusSeconds(firstRunAt, -rng.int(40 * 60, 90 * 60));
  const instants: Date[] = [];
  for (let i = 0; i < count; i++) {
    instants.push(at);
    at = plusSeconds(at, rng.int(30, 90));
  }
  return instants;
}

/** Refusals already known (patients who never share) are recorded 5 to 25 min before the first run, 30 to 90 s apart. */
export function knownRefusalInstants(firstRunAt: Date, count: number, rng: Rng): Date[] {
  let at = plusSeconds(firstRunAt, -rng.int(300, 1_500));
  const instants: Date[] = [];
  for (let i = 0; i < count; i++) {
    instants.push(at);
    at = plusSeconds(at, rng.int(30, 90));
  }
  return instants;
}

/**
 * The regulator calls the patients whose trip is proposed for sharing, one
 * after the other: the first answer 1 to 3 min after the run, then one every
 * 20 to 60 s.
 */
export function answerInstants(after: Date, count: number, rng: Rng): Date[] {
  let at = plusSeconds(after, rng.int(60, 180));
  const instants: Date[] = [];
  for (let i = 0; i < count; i++) {
    instants.push(at);
    at = plusSeconds(at, rng.int(20, 60));
  }
  return instants;
}

/**
 * Trips the plan could not place are handed over to a partner company, one
 * phone call after the other: the first 2 to 5 min after `after`, then one
 * every 2 to 5 min (the call, then the note and « Annuler » in « Courses »).
 */
export function handOverInstants(after: Date, count: number, rng: Rng): Date[] {
  let at = after;
  const instants: Date[] = [];
  for (let i = 0; i < count; i++) {
    at = plusSeconds(at, rng.int(120, 300));
    instants.push(at);
  }
  return instants;
}

/** A re-optimization (after a refusal) starts 1 to 4 min after the last answer. */
export function rerunStart(lastEventAt: Date, rng: Rng): Date {
  return plusSeconds(lastEventAt, rng.int(60, 240));
}

/**
 * « Valider le planning »: 15 to 60 min after the first run, and in any case
 * 2 to 6 min after the last run or answer.
 */
export function validationInstant(firstRunAt: Date, lastEventAt: Date, rng: Rng): Date {
  const planned = plusSeconds(firstRunAt, rng.int(15 * 60, 60 * 60));
  const earliest = plusSeconds(lastEventAt, rng.int(120, 360));
  return planned > earliest ? planned : earliest;
}

/** The week's trips are generated from the recurrences on the Friday before, between 10:00 and 11:30. */
export function tripGenerationInstant(isoDate: string, rng: Rng): Date {
  return parisInstant(addDays(startOfIsoWeek(isoDate), -3), rng.int(10 * 60, 11 * 60 + 30), rng.int(0, 59));
}

/** Last change of the day's trips: 19:30, once every crew is back. */
export function dayClosingInstant(isoDate: string): Date {
  return parisInstant(isoDate, 19 * 60 + 30);
}
