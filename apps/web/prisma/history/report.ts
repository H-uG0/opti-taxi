/** Console report of the simulated days (pure, unit-tested). */
import { formatShortDate, isoWeekday, WEEKDAY_SHORT } from "@/lib/time";

export type DayReport = {
  date: string;
  /** Why the day was not simulated (left untouched or stopped), null when it was. */
  skipped: string | null;
  /** Trips generated from the recurrences. */
  trips: number;
  /** Dropped off by the crews. */
  realized: number;
  /** Still open on no route at the end of the day (PLANNED or ASSIGNED): should stay 0. */
  unassigned: number;
  /** Left out by the last optimization, handed over to a partner company the day before (CANCELLED with a note). */
  handedOver: number;
  /** Cancelled by the patient or the facility (the hand-overs are not counted here). */
  cancelled: number;
  noShows: number;
  /** Realized trips that were shared. */
  shared: number;
  /** Sharing answers recorded on the day's trips. */
  refused: number;
  accepted: number;
  runs: number;
  /** First optimization -> validation of the planning, in minutes. */
  planningMinutes: number | null;
  /** Outbound patients dropped off after their appointment. */
  late: number;
  /** Routes recomputed (POST /evaluate) after a cancellation on the day. */
  refreshed: number;
  /** Routes a cancellation left with their stored times and totals (optimizer unavailable or in error). */
  notRefreshed: number;
};

export function emptyDayReport(date: string, skipped: string | null): DayReport {
  return {
    date,
    skipped,
    trips: 0,
    realized: 0,
    unassigned: 0,
    handedOver: 0,
    cancelled: 0,
    noShows: 0,
    shared: 0,
    refused: 0,
    accepted: 0,
    runs: 0,
    planningMinutes: null,
    late: 0,
    refreshed: 0,
    notRefreshed: 0,
  };
}

const COLUMNS: { label: string; value: (r: DayReport) => string }[] = [
  { label: "courses", value: (r) => String(r.trips) },
  { label: "réalisées", value: (r) => String(r.realized) },
  { label: "confiées", value: (r) => String(r.handedOver) },
  { label: "annulées", value: (r) => String(r.cancelled) },
  { label: "absents", value: (r) => String(r.noShows) },
  { label: "partagées", value: (r) => String(r.shared) },
  { label: "refus", value: (r) => String(r.refused) },
  { label: "optim.", value: (r) => String(r.runs) },
  { label: "planif.", value: (r) => (r.planningMinutes === null ? "—" : `${Math.round(r.planningMinutes)} min`) },
  { label: "retards", value: (r) => String(r.late) },
];

/** "Lun 12/10/2026". */
export function dayLabel(date: string): string {
  return `${WEEKDAY_SHORT[isoWeekday(date)] ?? ""} ${formatShortDate(date)}`;
}

const DAY_WIDTH = dayLabel("2026-10-12").length;

export function dayTableHeader(): string {
  return `${"jour".padEnd(DAY_WIDTH)} ${COLUMNS.map((c) => c.label.padStart(Math.max(c.label.length, 6))).join(" ")}`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

/** What a date holds that the simulation did not create (counts per kind). */
export type ForeignRowCounts = { trips: number; routes: number; runs: number; events: number };

/** Why a date is left untouched: the kinds of foreign rows it holds, zeros left out. */
export function foreignRowsReason(rows: ForeignRowCounts): string {
  const parts = [
    rows.trips > 0 ? plural(rows.trips, "course") : null,
    rows.routes > 0 ? plural(rows.routes, "tournée") : null,
    rows.runs > 0 ? plural(rows.runs, "optimisation") : null,
    rows.events > 0 ? `${plural(rows.events, "modification enregistrée", "modifications enregistrées")} dans l'application` : null,
  ].filter((part) => part !== null);
  return `données existantes non créées par la simulation (${parts.join(", ")})`;
}

/** What went wrong on a simulated day, appended to its line ("" when nothing did). */
function dayWarnings(report: DayReport): string {
  const warnings: string[] = [];
  if (report.unassigned > 0) warnings.push(plural(report.unassigned, "course restée sans tournée", "courses restées sans tournée"));
  if (report.notRefreshed > 0) {
    warnings.push(`${plural(report.notRefreshed, "tournée non recalculée", "tournées non recalculées")} après annulation`);
  }
  return warnings.length > 0 ? `  (${warnings.join(", ")})` : "";
}

export function formatDayLine(report: DayReport): string {
  const day = dayLabel(report.date).padEnd(DAY_WIDTH);
  if (report.skipped) return `${day} ignoré : ${report.skipped}`;
  return `${day} ${COLUMNS.map((c) => c.value(report).padStart(Math.max(c.label.length, 6))).join(" ")}${dayWarnings(report)}`;
}

/**
 * Why the script stopped on `date`, and in what state it leaves the period:
 * the days before are simulated, the failing day is removed (when that
 * worked), the days after keep what a previous run left there.
 */
export function interruptedMessage(date: string, cause: string, simulatedDays: number, dayRemoved: boolean): string {
  const removed = dayRemoved
    ? "ce jour a été retiré de la base"
    : "ce jour n'a pas pu être retiré : il peut rester incomplet en base";
  const before =
    simulatedDays === 0
      ? "Aucun jour n'a été simulé"
      : simulatedDays === 1
        ? "Le jour précédent est simulé"
        : `Les ${simulatedDays} jours précédents sont simulés`;
  return [
    cause,
    `Simulation interrompue le ${formatShortDate(date)} : ${removed}. ${before} ; ` +
      "les jours suivants gardent la simulation précédente, s'il y en avait une. " +
      "Relancez pnpm db:history pour compléter la période.",
  ].join("\n");
}

/** Sum of the simulated days (skipped days count for nothing). */
export function totalReport(reports: readonly DayReport[]): Omit<DayReport, "date" | "skipped" | "planningMinutes"> {
  const total = {
    trips: 0,
    realized: 0,
    unassigned: 0,
    handedOver: 0,
    cancelled: 0,
    noShows: 0,
    shared: 0,
    refused: 0,
    accepted: 0,
    runs: 0,
    late: 0,
    refreshed: 0,
    notRefreshed: 0,
  };
  for (const r of reports) {
    if (r.skipped) continue;
    for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += r[key];
  }
  return total;
}
