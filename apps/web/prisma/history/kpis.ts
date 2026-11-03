/**
 * Dashboard indicators of the simulated period, computed by @/lib/kpis from
 * the rows of @/lib/kpis-load, the same loader as /tableau-de-bord: French
 * summary lines for the console (pure).
 */
import type { PeriodKpis } from "@/lib/kpis";
import { formatShortDate } from "@/lib/time";

const decimal = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat("fr-FR", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
const euros = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const whole = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });

function orDash(value: number | null, format: (value: number) => string): string {
  return value === null ? "—" : format(value);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

/** French summary of the period, one indicator per line (the five indicators of the dashboard, then money). */
export function periodSummaryLines(period: PeriodKpis): string[] {
  const rows: [string, string][] = [
    [
      "Période",
      `du ${formatShortDate(period.from)} au ${formatShortDate(period.to)} ` +
        `(${plural(period.plannedDays, "jour planifié", "jours planifiés")}, ${plural(period.validatedDays, "validé")})`,
    ],
    ["Courses par véhicule et par jour (plan)", orDash(period.tripsPerVehiclePlanned, (v) => decimal.format(v))],
    ["Courses réalisées par véhicule et par jour", orDash(period.tripsPerVehicleRealized, (v) => decimal.format(v))],
    ["Part des km à vide", `${orDash(period.emptyKmShare, (v) => percent.format(v))} (${whole.format(period.emptyKm)} km sur ${whole.format(period.distanceKm)})`],
    ["Taux de transport partagé", `${orDash(period.sharedRate, (v) => percent.format(v))} (${period.sharedTrips} courses sur ${period.servedTrips})`],
    [
      "Arrivées en retard au rendez-vous",
      `${orDash(period.lateRate, (v) => percent.format(v))} (${period.lateArrivals} sur ${period.measuredOutbound} allers mesurés` +
        `${period.maxDelayMinutes === null ? "" : `, retard maximal ${whole.format(period.maxDelayMinutes)} min`})`,
    ],
    ["Retards dans le plan (devrait être 0)", `${period.plannedLateArrivals} sur ${period.plannedOutbound} allers`],
    [
      "Temps de planification moyen",
      `${orDash(period.averagePlanningMinutes, (v) => `${whole.format(v)} min`)} (${plural(period.optimizationRuns, "optimisation")})`,
    ],
    ["CA estimé / coût / marge", `${euros.format(period.revenue)} / ${euros.format(period.cost)} / ${euros.format(period.margin)}`],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`);
}
