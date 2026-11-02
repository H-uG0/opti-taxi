/** Number and date formatting of the dashboard (French, "—" for unknown values). */
import type { DayKpis } from "@/lib/kpis";
import { formatDuration, fromIsoDate, TIME_ZONE } from "@/lib/time";

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
const instantFormat = new Intl.DateTimeFormat("fr-FR", {
  timeZone: TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
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

/** Real instant -> "02/11 18:50" (Europe/Paris). */
export function formatInstant(instant: Date): string {
  return instantFormat.format(instant).replace(",", "");
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
