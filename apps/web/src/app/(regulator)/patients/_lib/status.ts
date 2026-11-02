/**
 * Display rules of the patient referential: prescription validity, warnings
 * and recurrence summaries. Pure module (dates are "YYYY-MM-DD" strings).
 */
import type { Mobility, PrescribedMode } from "@prisma/client";
import { addDays, formatMinute, formatShortDate, fromIsoDate, toIsoDate, WEEKDAY_SHORT } from "@/lib/time";

/** A prescription ending within this many days is flagged. */
export const EXPIRY_WARNING_DAYS = 14;

const DAY_MS = 86_400_000;

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((fromIsoDate(toIso).getTime() - fromIsoDate(fromIso).getTime()) / DAY_MS);
}

export type ValidityState = "upcoming" | "valid" | "expiring" | "expired";

export type Validity = {
  state: ValidityState;
  /** Days until validTo (negative once expired). */
  daysLeft: number;
};

export function prescriptionValidity(p: { validFrom: string; validTo: string }, todayIso: string): Validity {
  const daysLeft = daysBetween(todayIso, p.validTo);
  if (daysLeft < 0) return { state: "expired", daysLeft };
  if (todayIso < p.validFrom) return { state: "upcoming", daysLeft };
  if (daysLeft <= EXPIRY_WARNING_DAYS) return { state: "expiring", daysLeft };
  return { state: "valid", daysLeft };
}

/** "Expire dans 3 j", "Expirée depuis le 01/10/2026"… */
export function validityLabel(p: { validFrom: string; validTo: string }, todayIso: string): string {
  const v = prescriptionValidity(p, todayIso);
  switch (v.state) {
    case "expired":
      return `Expirée le ${formatShortDate(p.validTo)}`;
    case "expiring":
      if (v.daysLeft === 0) return "Expire aujourd'hui";
      return v.daysLeft === 1 ? "Expire demain" : `Expire dans ${v.daysLeft} j`;
    case "upcoming":
      return `Valide à partir du ${formatShortDate(p.validFrom)}`;
    case "valid":
      return `Valide jusqu'au ${formatShortDate(p.validTo)}`;
  }
}

/** True when the validity needs the regulator's attention (red badge), unless `renewed`. */
export function needsRenewal(p: { validFrom: string; validTo: string }, todayIso: string, renewed = false): boolean {
  if (renewed) return false;
  const { state } = prescriptionValidity(p, todayIso);
  return state === "expired" || state === "expiring";
}

type DatedPrescription = { id: string; mode: PrescribedMode; validFrom: Date; validTo: Date };

/**
 * `next` renews `p`: same mode, it takes over at the latest the day after `p`
 * ends, and it lasts longer.
 */
export function isRenewalOf(p: DatedPrescription, next: DatedPrescription): boolean {
  if (next.id === p.id || next.mode !== p.mode) return false;
  const end = toIsoDate(p.validTo);
  return toIsoDate(next.validTo) > end && toIsoDate(next.validFrom) <= addDays(end, 1);
}

/** The prescription renewing `p` (the one lasting longest), or null. */
export function findRenewal<T extends DatedPrescription>(p: T, prescriptions: readonly T[]): T | null {
  let best: T | null = null;
  for (const next of prescriptions) {
    if (isRenewalOf(p, next) && (!best || next.validTo > best.validTo)) best = next;
  }
  return best;
}

/**
 * The prescription to show as "en cours": the one valid today that ends last;
 * otherwise the next upcoming one; otherwise the last expired one.
 */
export function pickCurrentPrescription<T extends { validFrom: Date; validTo: Date }>(
  prescriptions: T[],
  todayIso: string,
): T | null {
  let current: T | null = null;
  let upcoming: T | null = null;
  let expired: T | null = null;
  for (const p of prescriptions) {
    const from = toIsoDate(p.validFrom);
    const to = toIsoDate(p.validTo);
    if (from <= todayIso && todayIso <= to) {
      if (!current || to > toIsoDate(current.validTo)) current = p;
    } else if (from > todayIso) {
      if (!upcoming || from < toIsoDate(upcoming.validFrom)) upcoming = p;
    } else if (!expired || to > toIsoDate(expired.validTo)) {
      expired = p;
    }
  }
  return current ?? upcoming ?? expired;
}

/** The prescribed mode must match the patient's mobility (lying -> ambulance, seated -> TAP). */
export function mobilityModeWarning(mobility: Mobility, mode: PrescribedMode): string | null {
  if (mobility === "LYING" && mode === "TAP") {
    return "Patient allongé avec une prescription en transport assis : vérifiez la mobilité ou la prescription.";
  }
  if (mobility === "SEATED" && mode === "AMBULANCE") {
    return "Patient assis avec une prescription en ambulance : vérifiez la mobilité ou la prescription.";
  }
  return null;
}

export type Notice = { tone: "info" | "warning" | "danger"; text: string };

type Period = { startDate: string; endDate: string | null };
type ValidityRange = { validFrom: string; validTo: string };

/** The recurrence still runs after the prescription ends (the usual case: the PMT gets renewed). */
function outlives(recurrence: Period, prescription: ValidityRange): boolean {
  return recurrence.endDate === null || recurrence.endDate > prescription.validTo;
}

/** First day of the recurrence still to come. */
function firstDayToCome(recurrence: Period, todayIso: string): string {
  return recurrence.startDate > todayIso ? recurrence.startDate : todayIso;
}

/**
 * What the regulator must know about the prescription behind an active
 * recurrence, on the patient page. An open-ended recurrence outliving its
 * PMT is normal (renewals): it is only flagged once the end is near
 * (EXPIRY_WARNING_DAYS), and calmly when the renewal is already registered.
 */
export function recurrenceCoverageNotice(
  recurrence: Period,
  prescription: ValidityRange,
  todayIso: string,
  renewal: ValidityRange | null = null,
): Notice | null {
  if (recurrence.endDate !== null && recurrence.endDate < todayIso) return null;
  const validity = prescriptionValidity(prescription, todayIso);
  const end = formatShortDate(prescription.validTo);
  const renewed = renewal
    ? `PMT renouvelée (${formatShortDate(renewal.validFrom)} → ${formatShortDate(renewal.validTo)}) : rattachez-y la récurrence`
    : null;

  if (validity.state === "expired") {
    return renewed
      ? { tone: "warning", text: `PMT expirée le ${end}. ${renewed} pour que les courses reprennent.` }
      : { tone: "danger", text: `Prescription expirée le ${end} : plus aucune course générée.` };
  }
  if (validity.state === "expiring" && outlives(recurrence, prescription)) {
    return renewed
      ? { tone: "info", text: `${renewed} avant le ${end}.` }
      : {
          tone: "warning",
          text: `${validityLabel(prescription, todayIso)} (${end}) : sans renouvellement, plus de course après cette date.`,
        };
  }
  if (firstDayToCome(recurrence, todayIso) < prescription.validFrom) {
    return {
      tone: "warning",
      text: `La PMT ne commence que le ${formatShortDate(prescription.validFrom)} : pas de course avant cette date.`,
    };
  }
  return null;
}

/** Hints of the recurrence form about the chosen prescription's validity. */
export function recurrenceFormNotices(recurrence: Period, prescription: ValidityRange, todayIso: string): Notice[] {
  const notices: Notice[] = [];
  if (firstDayToCome(recurrence, todayIso) < prescription.validFrom) {
    notices.push({
      tone: "warning",
      text: `La prescription ne commence que le ${formatShortDate(prescription.validFrom)} : aucune course ne sera générée avant cette date.`,
    });
  }
  if (outlives(recurrence, prescription)) {
    const end = formatShortDate(prescription.validTo);
    notices.push(
      prescription.validTo < todayIso
        ? { tone: "danger", text: `Cette prescription a expiré le ${end} : aucune course ne sera générée.` }
        : {
            tone: "info",
            text: `Courses générées jusqu'au ${end} (fin de la prescription) ; pour la suite, saisissez le renouvellement et rattachez-y la récurrence.`,
          },
    );
  }
  return notices;
}

/** [5, 1, 3] -> "Lun Mer Ven". */
export function formatWeekdays(weekdays: number[]): string {
  return [...new Set(weekdays)]
    .filter((d) => d >= 1 && d <= 7)
    .sort((a, b) => a - b)
    .map((d) => WEEKDAY_SHORT[d])
    .join(" ");
}

/** "Lun Mer Ven 07:30 — Dialyse" (the facility name stands in for a missing label). */
export function formatRecurrenceSummary(r: {
  weekdays: number[];
  appointmentMinute: number;
  label: string | null;
  facilityName?: string | null;
}): string {
  const days = formatWeekdays(r.weekdays);
  const what = r.label?.trim() || r.facilityName?.trim() || "";
  const head = `${days} ${formatMinute(r.appointmentMinute)}`.trim();
  return what ? `${head} — ${what}` : head;
}
