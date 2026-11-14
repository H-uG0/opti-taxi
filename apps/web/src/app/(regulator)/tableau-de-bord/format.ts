/** Number and date formatting of the dashboard (French, "—" for unknown values). */
import type { DayKpis, Granularity } from "@/lib/kpis";
import type { IndicatorUnit } from "@/lib/kpis-targets";
import { formatPercent } from "@/lib/labels";
import { formatDateTime, formatDuration, fromIsoDate } from "@/lib/time";

const decimalFormats = new Map<number, Intl.NumberFormat>();
function decimalFormat(digits: number): Intl.NumberFormat {
  let format = decimalFormats.get(digits);
  if (!format) {
    format = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    decimalFormats.set(digits, format);
  }
  return format;
}

const eurosRounded = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const eurosDelta = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
  signDisplay: "exceptZero",
});
const dayShort = new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "2-digit" });
const dayMonth = new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC", day: "2-digit", month: "2-digit" });

export function formatDecimal(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return decimalFormat(digits).format(value);
}

export function formatEurosRounded(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return eurosRounded.format(value);
}

/** "2026-11-03" -> "mar. 03/11". */
export function formatDayShort(isoDate: string): string {
  return dayShort.format(fromIsoDate(isoDate));
}

/** Real instant -> "02/11 à 18:50" (Europe/Paris): the app's one date-time format (lib/time). */
export function formatInstant(instant: Date): string {
  return formatDateTime(instant);
}

/** "mardi 3 novembre 2026" -> "Mardi 3 novembre 2026". */
export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "2026-11-03" -> "03/11". */
export function formatDayMonth(isoDate: string): string {
  return dayMonth.format(fromIsoDate(isoDate));
}

/** Late arrivals of a day, or null when no realized outbound trip could be measured. */
export function measuredLateArrivals(day: Pick<DayKpis, "lateArrivals" | "measuredOutbound">): number | null {
  return day.measuredOutbound > 0 ? day.lateArrivals : null;
}

/** A rate with one decimal: "23,4 %" (or "—"). */
export function formatRate(value: number | null | undefined): string {
  return formatPercent(value, 1);
}

/** Minutes as a duration ("45 min", "1 h 05"), or "—". */
export function formatMinutes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return formatDuration(value);
}

/** "12 / 40" for a count over its total, "—" without a total. */
export function formatCountOf(count: number, total: number): string {
  return total > 0 ? `${count} / ${total}` : "—";
}

/** Patient initials for the lists of the dashboard: "M. D." (first name, last name), never the full name. */
export function patientInitials(person: { firstName: string; lastName: string }): string {
  const initial = (name: string) => {
    const letter = name.trim().charAt(0);
    return letter ? `${letter.toUpperCase()}.` : "";
  };
  return [initial(person.firstName), initial(person.lastName)].filter(Boolean).join(" ") || "—";
}

/** Margin of a day, or null when there is no route (nothing was planned, not a zero margin). */
export function plannedMargin(day: Pick<DayKpis, "margin" | "vehicles">): number | null {
  return day.vehicles > 0 ? day.margin : null;
}

type RealizedDay = Pick<
  DayKpis,
  "upcoming" | "inProgress" | "vehicles" | "realizedVehicles" | "realizedTrips" | "tripsPerVehicleRealized"
>;

/**
 * Realized trips per vehicle of a day: the value (when some crew recorded a
 * status) or the reason why there is none, and a note on how it was measured.
 */
export function describeRealizedRate(day: RealizedDay): { value: string | null; note: string } {
  if (day.upcoming) return { value: null, note: "jour à venir" };
  if (day.vehicles === 0) return { value: null, note: "aucune tournée" };
  if (day.realizedVehicles === 0 || day.tripsPerVehicleRealized === null) {
    return { value: null, note: "aucun statut saisi par les équipages" };
  }
  const parts = [
    `${plural(day.realizedTrips, "course déposée", "courses déposées")} ÷ ${plural(day.realizedVehicles, "véhicule suivi", "véhicules suivis")}`,
  ];
  if (day.realizedVehicles < day.vehicles) parts.push(`${day.vehicles - day.realizedVehicles} sans statut saisi`);
  if (day.inProgress) parts.push("journée en cours");
  return { value: formatDecimal(day.tripsPerVehicleRealized), note: parts.join(" · ") };
}

/** Planning time cell: duration, or the reason why there is none. */
export function formatPlanningTime(day: Pick<DayKpis, "planningStatus" | "planningMinutes">): string {
  if (day.planningMinutes !== null) return formatDuration(day.planningMinutes);
  if (day.planningStatus === "VALIDATED") return "Validé";
  if (day.planningStatus === "NOT_VALIDATED") return "Non validé";
  return "—";
}

function withSign(delta: number, text: string): string {
  return delta > 0 ? `+${text}` : text;
}

/** Signed difference of two ratios: "+0,4". */
export function formatDeltaDecimal(delta: number, digits = 1): string {
  return withSign(delta, decimalFormat(digits).format(delta));
}

/** Difference of two rates in percentage points: "+2,1 pts". */
export function formatDeltaPoints(delta: number): string {
  const points = delta * 100;
  const unit = Math.abs(points) >= 2 ? "pts" : "pt";
  return `${withSign(points, decimalFormat(1).format(points))} ${unit}`;
}

export function formatDeltaCount(delta: number): string {
  return withSign(delta, String(Math.round(delta)));
}

export function formatDeltaMinutes(delta: number): string {
  return withSign(delta, formatDuration(delta));
}

export function formatDeltaEuros(delta: number): string {
  return eurosDelta.format(delta);
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

/** When a drop-off is late, in a sentence: « après l'heure du RDV » without tolerance, « plus de 5 min après le RDV » with one. */
export function lateThreshold(toleranceMin: number): string {
  return toleranceMin > 0 ? `plus de ${formatDuration(toleranceMin)} après le RDV` : "après l'heure du RDV";
}

/** Label of the lateness indicator: « Retards (après l'heure du RDV) », « Retards (> 5 min) ». */
export function lateLabel(toleranceMin: number): string {
  return toleranceMin > 0 ? `Retards (> ${formatDuration(toleranceMin)})` : "Retards (après l'heure du RDV)";
}

const monthLong = new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC", month: "long", year: "numeric" });
const monthShort = new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC", month: "short", year: "2-digit" });

/** A step of a trend in words: « mar. 03/11 », « sem. du 02/11 », « Novembre 2026 ». */
export function formatStep(key: string, granularity: Granularity): string {
  if (granularity === "week") return `sem. du ${formatDayMonth(key)}`;
  if (granularity === "month") return capitalize(monthLong.format(fromIsoDate(key)));
  return formatDayShort(key);
}

/** A step under the first and last bars: « 03/11 », « nov. 26 ». */
export function formatStepEdge(key: string, granularity: Granularity): string {
  return granularity === "month" ? monthShort.format(fromIsoDate(key)) : formatDayMonth(key);
}

/** Bars of a single-series chart: « Par jour », « Par semaine », « Par mois ». */
export const STEP_LABELS: Record<Granularity, string> = { day: "Par jour", week: "Par semaine", month: "Par mois" };

/** A value of an indicator in its unit: « 23,4 % », « 4,2 », « 35 min », « 12 € ». */
export function formatIndicator(unit: IndicatorUnit, value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  switch (unit) {
    case "rate":
      return formatRate(value);
    case "decimal":
      return formatDecimal(value);
    case "minutes":
      return formatDuration(value);
    case "euros":
      return formatEurosRounded(value);
  }
}

/** Rounds half away from zero to `step`, as Intl and formatDuration do. */
function roundTo(value: number, step: number): number {
  return Math.sign(value) * Math.round(Math.abs(value) / step) * step;
}

/**
 * How a gap to an objective reads, from the gap as formatIndicatorGap shows
 * it (a tenth of a point, a tenth, the minute, the euro): a gap shown as
 * « 0 € » is « even », never coloured as missed.
 */
export function gapVerdict(unit: IndicatorUnit, higherIsBetter: boolean, gap: number): "better" | "worse" | "even" {
  const shown = unit === "rate" ? roundTo(gap, 0.001) : unit === "decimal" ? roundTo(gap, 0.1) : roundTo(gap, 1);
  if (shown === 0) return "even";
  return shown > 0 === higherIsBetter ? "better" : "worse";
}

/** A gap in the unit of its indicator, signed: « +2,1 pts », « −0,3 », « +5 min », « −3 € ». */
export function formatIndicatorGap(unit: IndicatorUnit, gap: number): string {
  switch (unit) {
    case "rate":
      return formatDeltaPoints(gap);
    case "decimal":
      return formatDeltaDecimal(gap);
    case "minutes":
      return formatDeltaMinutes(gap);
    case "euros":
      return formatDeltaEuros(gap);
  }
}
