/**
 * Dashboard indicators of the simulated period, computed by @/lib/kpis from
 * the rows of @/lib/kpis-load, the same loader as /tableau-de-bord: French
 * summary lines for the console (pure).
 */
import type { PeriodKpis } from "@/lib/kpis";
import { lostTrips, placedTrips, tripsToCarry } from "@/lib/kpis-demand";
import { lostVehicleDays } from "@/lib/kpis-fleet";
import { quantile } from "@/lib/kpis-rows";
import { measuredSharedRate, tapTotal } from "@/lib/kpis-sharing";
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

const pct = (v: number) => percent.format(v);
const minutes = (v: number) => `${whole.format(v)} min`;

/** French summary of the period, one indicator per line (the dashboard's indicators, then money). */
export function periodSummaryLines(period: PeriodKpis): string[] {
  const { demand, fleet, sharing, waits } = period;
  const rows: [string, string][] = [
    [
      "Période",
      `du ${formatShortDate(period.from)} au ${formatShortDate(period.to)} ` +
        `(${plural(period.plannedDays, "jour planifié", "jours planifiés")}, ${plural(period.validatedDays, "validé")})`,
    ],
    [
      "Taux de service",
      `${orDash(period.serviceRate, pct)} (${placedTrips(demand)} placées sur ${tripsToCarry(demand)} à transporter, ` +
        `${lostTrips(demand)} non servies, CA perdu estimé ${euros.format(demand.lostRevenue)})`,
    ],
    ["Courses par véhicule et par jour (plan)", orDash(period.tripsPerVehiclePlanned, (v) => decimal.format(v))],
    ["Courses réalisées par véhicule et par jour", orDash(period.tripsPerVehicleRealized, (v) => decimal.format(v))],
    [
      "Utilisation de la flotte",
      fleet
        ? `${orDash(period.useRate, pct)} (${fleet.used} journées-véhicules utilisées sur ${fleet.available} disponibles, ` +
          `${lostVehicleDays(fleet)} perdues ; ${orDash(period.tripsPerAvailableVehicle, (v) => decimal.format(v))} courses par véhicule disponible)`
        : "—",
    ],
    ["Part des km à vide", `${orDash(period.emptyKmShare, pct)} (${whole.format(period.emptyKm)} km sur ${whole.format(period.distanceKm)})`],
    [
      "Transport partagé (périmètre CPAM)",
      `${orDash(period.eligibleSharedRate, pct)} prévu sur ${tapTotal(sharing.eligible)} courses éligibles, ` +
        `${orDash(measuredSharedRate(sharing), pct)} mesuré ; ${sharing.funnel.refused} refus (${plural(sharing.refusingPatientIds.length, "patient")})`,
    ],
    [
      "Arrivées en retard au rendez-vous",
      `${orDash(period.lateRate, pct)} (${period.lateArrivals} sur ${period.measuredOutbound} allers mesurés, ` +
        `${period.lateOver15} au-delà de 15 min${period.maxDelayMinutes === null ? "" : `, retard maximal ${whole.format(period.maxDelayMinutes)} min`})`,
    ],
    ["Allers serrés dans le plan", `${period.tightOutbound} sur ${period.plannedOutbound} allers (${orDash(period.tightRate, pct)})`],
    [
      "Attente au lieu de soins",
      `${waits.sharedOverMax} séances partagées au-delà de la limite sur ${waits.sharedSessions} ; ` +
        `attente au retour médiane ${orDash(quantile(waits.afterWaits, 0.5), minutes)}, p90 ${orDash(quantile(waits.afterWaits, 0.9), minutes)}`,
    ],
    [
      "Temps de planification moyen",
      `${orDash(period.averagePlanningMinutes, (v) => `${whole.format(v)} min`)} (${plural(period.optimizationRuns, "optimisation")})`,
    ],
    [
      "CA estimé / coût / marge",
      `${euros.format(period.servedRevenue)} / ${euros.format(period.cost)} / ${euros.format(period.servedRevenue - period.cost)} ` +
        `(courses servies, absents exclus ; déposées : ${euros.format(period.realizedRevenue)})`,
    ],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`);
}
