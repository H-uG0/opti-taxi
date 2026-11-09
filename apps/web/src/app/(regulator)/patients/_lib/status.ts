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

// One renewal rule for the generation, the work list, the badges and « Rattacher » (lib/domain/renewal.ts).
export { findPredecessor, findRenewal, isRenewalOf } from "@/lib/domain/renewal";

/** Days with no prescription between a PMT ending on `endOfPrevious` and the next one, from today on. */
export function uncoveredDays(endOfPrevious: string, startOfNext: string, todayIso: string): { from: string; to: string } | null {
  const dayAfter = addDays(endOfPrevious, 1);
  const from = dayAfter > todayIso ? dayAfter : todayIso;
  const to = addDays(startOfNext, -1);
  return from <= to ? { from, to } : null;
}

/** "aucune PMT du 02/11/2026 au 04/11/2026 : pas de course ces jours-là". */
export function uncoveredText(days: { from: string; to: string }): string {
  return days.from === days.to
    ? `aucune PMT le ${formatShortDate(days.from)} : pas de course ce jour-là`
    : `aucune PMT du ${formatShortDate(days.from)} au ${formatShortDate(days.to)} : pas de course ces jours-là`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
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
 * Before the PMT starts, the sessions go on with the PMT it renews
 * (`predecessor`, a recurrence attached early): only days none covers are flagged.
 */
export function recurrenceCoverageNotice(
  recurrence: Period,
  prescription: ValidityRange,
  todayIso: string,
  renewal: ValidityRange | null = null,
  predecessor: ValidityRange | null = null,
): Notice | null {
  if (recurrence.endDate !== null && recurrence.endDate < todayIso) return null;
  const validity = prescriptionValidity(prescription, todayIso);
  const end = formatShortDate(prescription.validTo);
  const gap = renewal ? uncoveredDays(prescription.validTo, renewal.validFrom, todayIso) : null;
  const renewed = renewal
    ? `PMT renouvelée (${formatShortDate(renewal.validFrom)} → ${formatShortDate(renewal.validTo)}) : les courses continuent dessus ; rattachez-y la récurrence${gap ? `. ${capitalize(uncoveredText(gap))}` : ""}`
    : null;

  if (validity.state === "expired") {
    return renewed
      ? { tone: "warning", text: `PMT expirée le ${end}. ${renewed}.` }
      : { tone: "danger", text: `Prescription expirée le ${end} : plus aucune course générée.` };
  }
  if (validity.state === "expiring" && outlives(recurrence, prescription)) {
    return renewed
      ? { tone: gap ? "warning" : "info", text: `${renewed}.` }
      : {
          tone: "warning",
          text: `${validityLabel(prescription, todayIso)} (${end}) : sans renouvellement, plus de course après cette date.`,
        };
  }
  const first = firstDayToCome(recurrence, todayIso);
  if (first < prescription.validFrom) {
    if (predecessor && predecessor.validFrom <= first && first <= predecessor.validTo) {
      const before = uncoveredDays(predecessor.validTo, prescription.validFrom, todayIso);
      return before
        ? {
            tone: "warning",
            text: `Courses sur la PMT précédente jusqu'au ${formatShortDate(predecessor.validTo)}, puis ${uncoveredText(before)}.`,
          }
        : null;
    }
    return {
      tone: "warning",
      text: `La PMT ne commence que le ${formatShortDate(prescription.validFrom)} : pas de course avant cette date.`,
    };
  }
  return null;
}

/**
 * The prescription chosen in the recurrence form, with the PMT it renews
 * (`previous`) and its renewal (`next`) when registered (lib/domain/renewal.ts):
 * the sessions use them before it starts and after it ends.
 */
export type FormPrescription = ValidityRange & { previous?: ValidityRange | null; next?: ValidityRange | null };

/** Hints of the recurrence form about the chosen prescription's validity. */
export function recurrenceFormNotices(recurrence: Period, prescription: FormPrescription, todayIso: string): Notice[] {
  const notices: Notice[] = [];
  const first = firstDayToCome(recurrence, todayIso);
  if (first < prescription.validFrom) {
    const previous = prescription.previous;
    if (previous && previous.validFrom <= first && first <= previous.validTo) {
      const before = uncoveredDays(previous.validTo, prescription.validFrom, todayIso);
      notices.push({
        tone: before ? "warning" : "info",
        text: `Avant le ${formatShortDate(prescription.validFrom)}, les courses restent sur la prescription précédente (jusqu'au ${formatShortDate(previous.validTo)})${before ? ` ; ${uncoveredText(before)}` : ""}.`,
      });
    } else {
      notices.push({
        tone: "warning",
        text: `La prescription ne commence que le ${formatShortDate(prescription.validFrom)} : aucune course ne sera générée avant cette date.`,
      });
    }
  }
  if (outlives(recurrence, prescription)) {
    const end = formatShortDate(prescription.validTo);
    const next = prescription.next;
    if (next) {
      const gap = uncoveredDays(prescription.validTo, next.validFrom, todayIso);
      notices.push({
        tone: gap ? "warning" : "info",
        text: `${prescription.validTo < todayIso ? `Cette prescription a expiré le ${end} ; les courses continuent` : `Courses générées sur cette prescription jusqu'au ${end}, puis`} sur son renouvellement (${formatShortDate(next.validFrom)} → ${formatShortDate(next.validTo)})${gap ? ` ; ${uncoveredText(gap)}` : ""}.`,
      });
    } else {
      notices.push(
        prescription.validTo < todayIso
          ? { tone: "danger", text: `Cette prescription a expiré le ${end} : aucune course ne sera générée.` }
          : {
              tone: "info",
              text: `Courses générées jusqu'au ${end} (fin de la prescription) ; pour la suite, saisissez le renouvellement : les courses continueront dessus.`,
            },
      );
    }
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
