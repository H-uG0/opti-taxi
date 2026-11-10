/**
 * Upcoming routes (today and later) still using a vehicle or a person that is
 * being deactivated. Deactivation does not touch planned routes: the
 * regulator has to re-run the optimisation of those days.
 * Pure module (no server-only import): unit-tested with vitest.
 */
import type { RouteStatus } from "@prisma/client";
import { formatShortDate, toIsoDate } from "@/lib/time";

export type UpcomingRoute = { date: string; status: RouteStatus };

/** Prisma rows -> UpcomingRoute, sorted by date. */
export function toUpcomingRoutes(rows: readonly { serviceDate: Date; status: RouteStatus }[]): UpcomingRoute[] {
  return rows
    .map((row) => ({ date: toIsoDate(row.serviceDate), status: row.status }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Distinct service dates ("YYYY-MM-DD"), ascending. */
export function upcomingRouteDates(routes: readonly UpcomingRoute[]): string[] {
  return [...new Set(routes.map((route) => route.date))].sort();
}

const MAX_LISTED_DATES = 5;

/**
 * "2 tournées à venir (03/11/2026, 04/11/2026), dont 1 validée, utilisent ce
 * véhicule. La désactivation ne les modifie pas : relancez l'optimisation de
 * ces jours depuis le planning." Null without upcoming route.
 * Worded to read the same before (confirmation) and after (result) the action.
 */
export function upcomingRoutesNotice(routes: readonly UpcomingRoute[], subject: "vehicle" | "driver"): string | null {
  const count = routes.length;
  if (count === 0) return null;
  const many = count > 1;
  const validated = routes.filter((route) => route.status === "VALIDATED").length;

  const dates = upcomingRouteDates(routes);
  const listed = dates.slice(0, MAX_LISTED_DATES).map(formatShortDate).join(", ");
  const dateText = dates.length > MAX_LISTED_DATES ? `${listed}…` : listed;

  let head: string;
  if (validated === count) head = `${count} tournée${many ? "s validées" : " validée"} à venir (${dateText})`;
  else if (validated > 0) head = `${count} tournées à venir (${dateText}), dont ${validated} validée${validated > 1 ? "s" : ""},`;
  else head = `${count} tournée${many ? "s" : ""} à venir (${dateText})`;

  const verb =
    subject === "vehicle" ? `${many ? "utilisent" : "utilise"} ce véhicule` : `${many ? "lui sont attribuées" : "lui est attribuée"}`;
  const days = dates.length > 1 ? "ces jours" : "ce jour";
  return `${head} ${verb}. La désactivation ne ${many ? "les" : "la"} modifie pas\u00a0: relancez l'optimisation de ${days} depuis le planning.`;
}
