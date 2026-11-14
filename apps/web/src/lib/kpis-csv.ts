/**
 * CSV export of the dashboard (KPI-08), for a French Excel: UTF-8 with a
 * byte order mark (Excel then reads the accents), « ; » between fields, a
 * decimal comma, dates as 03/11/2026, CRLF line ends. Aggregates only: counts,
 * km, rates and euros by day (or week, or month) and by depot or vehicle;
 * never a patient, an address or a note. A text that a spreadsheet would run
 * as a formula (a vehicle label starting with « = »…) is prefixed with « ' ».
 * Pure.
 */
import { tripsToCarry } from "./kpis-demand";
import type { Granularity } from "./kpis";
import { lineRates, sumLines, type LineTotals, type RouteLine } from "./kpis-breakdown";
import { tapTotal } from "./kpis-sharing";
import { bucketEnd, bucketStart, type TrendPoint } from "./kpis-trend";

export const CSV_SEPARATOR = ";";
const BOM = "﻿";
const FORMULA_START = /^[=+\-@\t\r]/;
/** A number written by csvNumber ("-12,50"): never made inert. */
const CSV_NUMBER = /^-?\d+(?:,\d+)?$/;

export type CsvValue = string | number | null | undefined;

/** "2026-11-03" -> "03/11/2026". */
export function csvDate(isoDate: string): string {
  return `${isoDate.slice(8, 10)}/${isoDate.slice(5, 7)}/${isoDate.slice(0, 4)}`;
}

/** A number with `digits` decimals and a decimal comma, no thousands separator ("" when unknown). */
export function csvNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  const fixed = value.toFixed(digits);
  return (/^-0(?:\.0+)?$/.test(fixed) ? fixed.slice(1) : fixed).replace(".", ",");
}

/** One field: quoted when it holds « ; », a quote or a line break; a formula-like text made inert. */
export function csvField(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  const text =
    typeof value === "number"
      ? csvNumber(value, Number.isInteger(value) ? 0 : 2)
      : FORMULA_START.test(value) && !CSV_NUMBER.test(value)
        ? `'${value}`
        : value;
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The whole file: BOM, header, rows, CRLF. */
export function toCsv(header: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  const line = (cells: readonly CsvValue[]) => cells.map(csvField).join(CSV_SEPARATOR);
  return `${BOM}${[line(header), ...rows.map(line)].join("\r\n")}\r\n`;
}

/** A column: its header and its value, already formatted (csvNumber, csvDate) or a plain text. */
type Column<T> = { header: string; value: (row: T) => CsvValue };

const percent = (rate: number | null | undefined) => csvNumber(rate === null || rate === undefined ? null : rate * 100, 1);

/** The period of a step: "Date" for a day, "Du" and "Au" for a week or a month. */
function periodColumns(granularity: Granularity): Column<{ from: string; to: string; key: string }>[] {
  return granularity === "day"
    ? [{ header: "Date", value: (p) => csvDate(p.key) }]
    : [
        { header: "Du", value: (p) => csvDate(p.from) },
        { header: "Au", value: (p) => csvDate(p.to) },
      ];
}

/** Header of the lateness columns, with the tolerance chosen on the page. */
function lateHeader(toleranceMin: number): string {
  return toleranceMin > 0 ? `Retards (plus de ${toleranceMin} min après le RDV)` : "Retards (après l'heure du RDV)";
}

/** One line per day (or week, or month) of the whole company or of the depot and type chosen. */
export function trendCsv(points: readonly TrendPoint[], granularity: Granularity, toleranceMin: number): string {
  const columns: Column<TrendPoint>[] = [
    ...periodColumns(granularity),
    { header: "Jours simulés", value: (p) => csvNumber(p.days.filter((d) => d.simulated).length) },
    { header: "Courses demandées", value: (p) => csvNumber(p.summary.demand.requested) },
    { header: "Annulées", value: (p) => csvNumber(p.summary.demand.cancelledBefore + p.summary.demand.cancelledOnDay) },
    { header: "À transporter", value: (p) => csvNumber(tripsToCarry(p.summary.demand)) },
    { header: "Servies", value: (p) => csvNumber(p.summary.servedTrips) },
    { header: "Déposées (réalisées)", value: (p) => csvNumber(p.summary.realizedTrips) },
    { header: "Patients absents", value: (p) => csvNumber(p.summary.demand.noShows) },
    { header: "Non affectées", value: (p) => csvNumber(p.summary.demand.unassigned) },
    { header: "Confiées à un confrère", value: (p) => csvNumber(p.summary.demand.handedOver) },
    { header: "Taux de service (%)", value: (p) => percent(p.summary.serviceRate) },
    { header: "Véhicules utilisés", value: (p) => csvNumber(p.summary.vehicles) },
    { header: "Véhicules disponibles", value: (p) => csvNumber(p.summary.fleet?.available ?? null) },
    { header: "Utilisation de la flotte (%)", value: (p) => percent(p.summary.useRate) },
    { header: "Courses par véhicule (servi)", value: (p) => csvNumber(p.summary.tripsPerVehiclePlanned, 2) },
    { header: "Courses par véhicule (réalisé)", value: (p) => csvNumber(p.summary.tripsPerVehicleRealized, 2) },
    { header: "Km", value: (p) => csvNumber(p.summary.distanceKm, 1) },
    { header: "Km à vide", value: (p) => csvNumber(p.summary.emptyKm, 1) },
    { header: "Part des km à vide (%)", value: (p) => percent(p.summary.emptyKmShare) },
    { header: "Courses éligibles au partage", value: (p) => csvNumber(tapTotal(p.summary.sharing.eligible)) },
    { header: "Dont partagées", value: (p) => csvNumber(tapTotal(p.summary.sharing.eligibleShared)) },
    { header: "Partage servi (%)", value: (p) => percent(p.summary.eligibleSharedRate) },
    { header: "Partage mesuré (%)", value: (p) => percent(p.summary.measuredSharedRate) },
    { header: "Allers mesurés", value: (p) => csvNumber(p.summary.measuredOutbound) },
    { header: lateHeader(toleranceMin), value: (p) => csvNumber(p.summary.lateArrivals) },
    { header: "Taux de retard (%)", value: (p) => percent(p.summary.lateRate) },
    {
      header: granularity === "day" ? "Temps de planification actif (min)" : "Temps de planification actif, médiane (min)",
      value: (p) => csvNumber(p.planningMinutes, 0),
    },
    { header: "CA estimé servi (€)", value: (p) => csvNumber(p.summary.servedRevenue, 2) },
    { header: "Coût des tournées (€)", value: (p) => csvNumber(p.summary.cost, 2) },
    { header: "Marge (€)", value: (p) => csvNumber(p.summary.servedRevenue - p.summary.cost, 2) },
    { header: "Marge par course (€)", value: (p) => csvNumber(p.summary.marginPerTrip, 2) },
  ];
  return toCsv(
    columns.map((c) => c.header),
    points.map((p) => columns.map((c) => c.value(p))),
  );
}

/** A line of the breakdown: a step, a group (depot, or vehicle with its type and depot) and its sums. */
export type BreakdownCsvRow = {
  key: string;
  from: string;
  to: string;
  depot: string;
  vehicle?: { label: string; type: string };
  totals: LineTotals;
};

/** One line per day (or step) and per depot or per vehicle (KPI-02). */
export function breakdownCsv(rows: readonly BreakdownCsvRow[], granularity: Granularity, by: "depot" | "vehicle", toleranceMin: number): string {
  const columns: Column<BreakdownCsvRow>[] = [
    ...periodColumns(granularity),
    { header: "Dépôt", value: (r) => r.depot },
    ...(by === "vehicle"
      ? [
          { header: "Véhicule", value: (r: BreakdownCsvRow) => r.vehicle?.label ?? "" },
          { header: "Type", value: (r: BreakdownCsvRow) => r.vehicle?.type ?? "" },
        ]
      : [{ header: "Véhicules utilisés", value: (r: BreakdownCsvRow) => csvNumber(r.totals.vehicleDays) }]),
    { header: "Courses servies", value: (r) => csvNumber(r.totals.trips) },
    { header: "Courses par véhicule", value: (r) => csvNumber(lineRates(r.totals).tripsPerVehicleDay, 2) },
    { header: "Km", value: (r) => csvNumber(r.totals.distanceKm, 1) },
    { header: "Km à vide", value: (r) => csvNumber(r.totals.emptyKm, 1) },
    { header: "Part des km à vide (%)", value: (r) => percent(lineRates(r.totals).emptyKmShare) },
    { header: "Courses éligibles au partage", value: (r) => csvNumber(r.totals.eligible) },
    { header: "Dont partagées", value: (r) => csvNumber(r.totals.eligibleShared) },
    { header: "Partage (%)", value: (r) => percent(lineRates(r.totals).sharedRate) },
    { header: "Allers mesurés", value: (r) => csvNumber(r.totals.measuredOutbound) },
    { header: lateHeader(toleranceMin), value: (r) => csvNumber(r.totals.lateArrivals) },
    { header: "Heures planifiées", value: (r) => csvNumber(r.totals.activeMinutes / 60, 1) },
    { header: "Taux d'occupation (%)", value: (r) => percent(lineRates(r.totals).occupancy) },
    { header: "CA estimé (€)", value: (r) => csvNumber(r.totals.revenue, 2) },
    { header: "Coût (€)", value: (r) => csvNumber(r.totals.cost, 2) },
    { header: "Marge (€)", value: (r) => csvNumber(r.totals.revenue - r.totals.cost, 2) },
  ];
  return toCsv(
    columns.map((c) => c.header),
    rows.map((r) => columns.map((c) => c.value(r))),
  );
}

/**
 * The rows of the breakdown export: the route lines grouped by step (inside
 * the range) and by depot or vehicle, in date order then by name.
 */
export function breakdownCsvRows(
  lines: readonly RouteLine[],
  range: { from: string; to: string },
  granularity: Granularity,
  by: "depot" | "vehicle",
  names: { depot: (id: string | null) => string; vehicle: (id: string) => { label: string; type: string } },
): BreakdownCsvRow[] {
  const groups = new Map<string, { key: string; group: string; lines: RouteLine[] }>();
  for (const line of lines) {
    const key = bucketStart(line.date, granularity);
    const group = by === "depot" ? (line.depotId ?? "") : line.vehicleId;
    const id = `${key}|${group}`;
    const entry = groups.get(id) ?? { key, group, lines: [] };
    entry.lines.push(line);
    groups.set(id, entry);
  }
  return [...groups.values()]
    .map(({ key, group, lines: own }) => {
      const end = bucketEnd(key, granularity);
      const vehicle = by === "vehicle" ? names.vehicle(group) : undefined;
      const depotId = by === "depot" ? group || null : (own[0]?.depotId ?? null);
      return {
        key,
        from: key < range.from ? range.from : key,
        to: end > range.to ? range.to : end,
        depot: names.depot(depotId),
        ...(vehicle ? { vehicle } : {}),
        totals: sumLines(own),
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key) || a.depot.localeCompare(b.depot, "fr") || (a.vehicle?.label ?? "").localeCompare(b.vehicle?.label ?? "", "fr"));
}
