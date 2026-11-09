/**
 * Renewal of a prescription (PMT): one rule for the generation of the
 * recurring trips (which prescription a session uses once the recurrence's
 * own has ended, or before it starts), the work list « Prescriptions », the
 * badges and « Rattacher au renouvellement ».
 *
 * `next` renews `p` when it has the same mode, starts after `p` started, ends
 * after `p` ends, and takes over at the latest RENEWAL_MAX_GAP_DAYS after `p`
 * ends (a PMT renewed a few days late leaves days without any trip). A
 * prescription that other active recurrences of the patient use, all at
 * another care facility, belongs to another series of care (radiotherapy
 * beside dialysis): whatever its dates, it never continues this one.
 *
 * Pure module (no server-only import): shared by the server, the pages, the
 * client forms and the seed.
 */
import type { PrescribedMode } from "@prisma/client";
import { addDays, fromIsoDate, toIsoDate } from "@/lib/time";

/** A renewal starting later than this after the old PMT's end is not taken for one. */
export const RENEWAL_MAX_GAP_DAYS = 31;

export type DatedPrescription = { id: string; mode: PrescribedMode; validFrom: Date; validTo: Date };

/** A prescription, with the care facilities of the active recurrences attached to it when they are loaded. */
export type SeriesPrescription = DatedPrescription & { recurrences?: readonly { facilityId: string }[] };

const DAY_MS = 86_400_000;

function dayDiff(fromIso: string, toIso: string): number {
  return Math.round((fromIsoDate(toIso).getTime() - fromIsoDate(fromIso).getTime()) / DAY_MS);
}

function covers(p: { validFrom: Date; validTo: Date }, isoDate: string): boolean {
  return toIsoDate(p.validFrom) <= isoDate && isoDate <= toIsoDate(p.validTo);
}

/** `next` renews `p` by its dates and mode (see the module comment; the series is checked apart). */
export function isRenewalOf(p: DatedPrescription, next: DatedPrescription): boolean {
  if (next.id === p.id || next.mode !== p.mode) return false;
  const end = toIsoDate(p.validTo);
  const start = toIsoDate(next.validFrom);
  return start > toIsoDate(p.validFrom) && toIsoDate(next.validTo) > end && start <= addDays(end, 1 + RENEWAL_MAX_GAP_DAYS);
}

/** How far `next` is from taking over the day after `p` ends (days of gap or of overlap). */
function takeoverDistance(p: DatedPrescription, next: DatedPrescription): number {
  return Math.abs(dayDiff(addDays(toIsoDate(p.validTo), 1), toIsoDate(next.validFrom)));
}

/** The care facilities of the active recurrences attached to `p` (empty when none, or not loaded). */
export function seriesFacilities(p: SeriesPrescription): Set<string> {
  return new Set((p.recurrences ?? []).map((r) => r.facilityId));
}

/**
 * `candidate` serves another series of care than the one at `facilityIds`:
 * active recurrences use it, none of them at one of these facilities. Without
 * any facility to compare with (a PMT no recurrence uses), nothing is excluded.
 */
export function belongsToAnotherSeries(candidate: SeriesPrescription, facilityIds: ReadonlySet<string>): boolean {
  if (facilityIds.size === 0) return false;
  const used = candidate.recurrences ?? [];
  return used.length > 0 && !used.some((r) => facilityIds.has(r.facilityId));
}

/** Of two candidates, the one taking over nearest to the end of `from` (then the one lasting longest). */
function nearer<T extends DatedPrescription>(best: T | null, candidate: T, distanceOf: (p: T) => number): T {
  if (!best) return candidate;
  const a = distanceOf(candidate);
  const b = distanceOf(best);
  return a < b || (a === b && candidate.validTo.getTime() > best.validTo.getTime()) ? candidate : best;
}

/**
 * The prescription renewing `p` — the one taking over nearest to its end —
 * leaving out another series' (by default, the series of `p`'s own recurrences).
 */
export function findRenewal<T extends SeriesPrescription>(
  p: T,
  prescriptions: readonly T[],
  facilityIds: ReadonlySet<string> = seriesFacilities(p),
): T | null {
  let best: T | null = null;
  for (const next of prescriptions) {
    if (!isRenewalOf(p, next) || belongsToAnotherSeries(next, facilityIds)) continue;
    best = nearer(best, next, (c) => takeoverDistance(p, c));
  }
  return best;
}

/** The prescription `p` renews (the nearest), leaving out another series' — a recurrence attached early to `p`. */
export function findPredecessor<T extends SeriesPrescription>(
  p: T,
  prescriptions: readonly T[],
  facilityIds: ReadonlySet<string> = seriesFacilities(p),
): T | null {
  let best: T | null = null;
  for (const previous of prescriptions) {
    if (!isRenewalOf(previous, p) || belongsToAnotherSeries(previous, facilityIds)) continue;
    best = nearer(best, previous, (c) => takeoverDistance(c, p));
  }
  return best;
}

/**
 * The prescription a session of the series at `facilityIds`, whose recurrence
 * is attached to `own`, uses on `isoDate`: `own` when it covers the date;
 * after its end, the first link of its renewal chain (its renewal, then that
 * one's…) covering the date; before its start, the first of its predecessors
 * covering it (a recurrence attached to a renewal before the old PMT ended).
 * Null in a gap between two links, or past the chain.
 */
export function prescriptionCovering<T extends SeriesPrescription>(
  own: T,
  prescriptions: readonly T[],
  facilityIds: ReadonlySet<string>,
  isoDate: string,
): T | null {
  if (covers(own, isoDate)) return own;
  const forward = isoDate > toIsoDate(own.validTo);
  const seen = new Set([own.id]);
  let link = own;
  for (;;) {
    const next = forward ? findRenewal(link, prescriptions, facilityIds) : findPredecessor(link, prescriptions, facilityIds);
    if (!next || seen.has(next.id)) return null;
    if (covers(next, isoDate)) return next;
    // The date falls between `link` and `next`: no prescription that day.
    if (forward ? toIsoDate(next.validFrom) > isoDate : toIsoDate(next.validTo) < isoDate) return null;
    seen.add(next.id);
    link = next;
  }
}
