/**
 * Work list « Prescriptions » : the prescriptions an active recurrence still
 * relies on and that end within EXPIRY_WARNING_DAYS (or have ended), while the
 * recurrence runs on after them. Three states, most urgent first:
 * - expired, no renewal: no trip any more;
 * - ending soon, no renewal: no trip after its end;
 * - renewed but the recurrences still point to it: trips go on with the
 *   renewal (the generation falls back on it, lib/domain/renewal.ts: the same
 *   rule), but the recurrences are to attach — and a renewal starting late
 *   leaves days without any trip (`uncovered`).
 * Pure module (dates "YYYY-MM-DD"): the page and the navigation counter share its rule.
 */
import type { PrescribedMode } from "@prisma/client";
import { addDays } from "@/lib/time";
import { daysBetween, EXPIRY_WARNING_DAYS, uncoveredDays } from "./status";

type Period = { startDate: string; endDate: string | null };
type Validity = { validFrom: string; validTo: string };

/** Last end of validity the list looks at: today + EXPIRY_WARNING_DAYS. */
export function workListLimit(todayIso: string): string {
  return addDays(todayIso, EXPIRY_WARNING_DAYS);
}

/**
 * An active recurrence of an active patient needs its prescription renewed (or
 * re-attached): the prescription ends by the limit, and the recurrence is not
 * over and runs after that end. Same rule as the navigation counter's query.
 */
export function needsPrescriptionWork(recurrence: Period, prescription: Pick<Validity, "validTo">, todayIso: string): boolean {
  if (prescription.validTo > workListLimit(todayIso)) return false;
  if (recurrence.endDate === null) return true;
  return recurrence.endDate > prescription.validTo && recurrence.endDate >= todayIso;
}

export type WorkState = "expired" | "expiring" | "renewed";

export type WorkItem = {
  patient: { id: string; name: string; city: string };
  prescription: { id: string; mode: PrescribedMode } & Validity;
  /** The renewal registered (same mode, takes over), to attach the recurrences to. */
  renewal: ({ id: string } & Validity) | null;
  state: WorkState;
  /** Days still to come between the end of the prescription and the start of its renewal: no trip. */
  uncovered: { from: string; to: string } | null;
  /** Days until the end of the prescription (negative once ended). */
  daysLeft: number;
  /** Summaries of the recurrences still attached ("Lun Mer Ven 07:30 — Dialyse"). */
  recurrences: string[];
};

export type WorkRecurrence = Period & {
  summary: string;
  patient: { id: string; name: string; city: string };
  prescription: { id: string; mode: PrescribedMode } & Validity;
  renewal: ({ id: string } & Validity) | null;
};

const STATE_ORDER: Record<WorkState, number> = { expired: 0, expiring: 1, renewed: 2 };

/** One item per prescription to handle, most urgent first (state, then end date, then patient). */
export function prescriptionWorkItems(recurrences: readonly WorkRecurrence[], todayIso: string): WorkItem[] {
  const items = new Map<string, WorkItem>();
  for (const rec of recurrences) {
    if (!needsPrescriptionWork(rec, rec.prescription, todayIso)) continue;
    const existing = items.get(rec.prescription.id);
    if (existing) {
      existing.recurrences.push(rec.summary);
      continue;
    }
    const daysLeft = daysBetween(todayIso, rec.prescription.validTo);
    items.set(rec.prescription.id, {
      patient: rec.patient,
      prescription: rec.prescription,
      renewal: rec.renewal,
      state: rec.renewal ? "renewed" : daysLeft < 0 ? "expired" : "expiring",
      uncovered: rec.renewal ? uncoveredDays(rec.prescription.validTo, rec.renewal.validFrom, todayIso) : null,
      daysLeft,
      recurrences: [rec.summary],
    });
  }
  return [...items.values()].sort(
    (a, b) =>
      STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
      a.prescription.validTo.localeCompare(b.prescription.validTo) ||
      a.patient.name.localeCompare(b.patient.name, "fr"),
  );
}

export function countByState(items: readonly WorkItem[]): Record<WorkState, number> {
  const counts: Record<WorkState, number> = { expired: 0, expiring: 0, renewed: 0 };
  for (const item of items) counts[item.state] += 1;
  return counts;
}
