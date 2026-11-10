/**
 * Break owed by a working day (Code du travail, art. L. 3121-16): « dès que le
 * temps de travail quotidien atteint six heures, le salarié bénéficie d'un
 * temps de pause d'une durée minimale de vingt minutes consécutives ».
 *
 * A crew's shift longer than six hours is only worked with the driver's break
 * fitting inside it and lasting at least 20 minutes: otherwise the vehicle is
 * blocked on /equipages and left out of the optimization (it would be planned
 * all day long without a break). The optimizer enforces the same rule on each
 * route (services/optimizer/app/model.py, work_limit_min; validator, BREAK).
 * The daily amplitude and rest of V's agreement are a separate matter (TT-01).
 * Pure module, unit-tested.
 */
import { formatDuration } from "@/lib/time";

export const MAX_WORK_WITHOUT_BREAK_MIN = 6 * 60;
export const MIN_LEGAL_BREAK_MIN = 20;
/** As the other citations of the interface write it (Légifrance style). */
export const WORK_TIME_ARTICLE = "Code du travail, art. L. 3121-16";

/** A person's break settings (Driver). */
export type BreakSettings = {
  breakWindowStartMinute: number | null;
  breakWindowEndMinute: number | null;
  breakMinutes: number;
};

export type Shift = { start: number; end: number };

/** The break window clipped to the shift, when the break still fits in it; null without a break. */
export function breakInShift(person: BreakSettings, shift: Shift): { windowStart: number; windowEnd: number; duration: number } | null {
  const { breakWindowStartMinute: ws, breakWindowEndMinute: we, breakMinutes: duration } = person;
  if (ws === null || we === null || duration <= 0) return null;
  const windowStart = Math.max(ws, shift.start);
  const windowEnd = Math.min(we, shift.end);
  return windowEnd - windowStart >= duration ? { windowStart, windowEnd, duration } : null;
}

/** Length of `shift` and what is wrong with its break, or null when the shift can be worked. */
function breach(person: BreakSettings, shift: Shift): { length: number; why: string } | null {
  const length = shift.end - shift.start;
  if (length <= MAX_WORK_WITHOUT_BREAK_MIN) return null;
  const fitted = breakInShift(person, shift);
  if (fitted && fitted.duration >= MIN_LEGAL_BREAK_MIN) return null;
  const why =
    person.breakMinutes <= 0 || person.breakWindowStartMinute === null || person.breakWindowEndMinute === null
      ? "sans pause"
      : fitted
        ? `avec une pause de ${person.breakMinutes}\u00a0min`
        : `avec une fenêtre de pause qui ne laisse pas ${person.breakMinutes}\u00a0min dans l'horaire`;
  return { length, why };
}

/**
 * Why `shift` cannot be worked with this break (French, for the regulator), or
 * null when it can: a shift of at most six hours, or a break of at least 20 min
 * that fits in it. `name` is the person whose break settings apply.
 */
export function workTimeIssue(person: BreakSettings, shift: Shift, name: string): string | null {
  const found = breach(person, shift);
  if (!found) return null;
  return (
    `Horaire de ${formatDuration(found.length)} ${found.why}\u00a0: au-delà de 6\u00a0h de travail, une pause d'au moins ` +
    `${MIN_LEGAL_BREAK_MIN}\u00a0min est obligatoire (${WORK_TIME_ARTICLE}). Réglez la pause de ${name} ` +
    "(fiche du chauffeur) ou raccourcissez son horaire"
  );
}

/**
 * workTimeIssue in a few words, for lists with little room (vehicles left out
 * of the planning, drivers list): « Pause de 20 min requise : horaire de 12 h 30
 * sans pause (art. L. 3121-16) ». Null when the shift can be worked.
 */
export function workTimeSummary(person: BreakSettings, shift: Shift): string | null {
  const found = breach(person, shift);
  if (!found) return null;
  return `Pause de ${MIN_LEGAL_BREAK_MIN}\u00a0min requise\u00a0: horaire de ${formatDuration(found.length)} ${found.why} (art. L. 3121-16)`;
}
