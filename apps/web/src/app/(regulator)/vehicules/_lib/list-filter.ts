/**
 * Filters of the Véhicules list, kept in the URL (FilterBar): search on the
 * label, the registration and the crew's names; depot, type, energy, alerts,
 * tomorrow's situation and status. Pure module.
 */
import type { EnergyType, VehicleType } from "@prisma/client";
import { idParam, matchesWords, pickParam, readParam, type SearchParams } from "@/lib/list-filters";
import type { VehicleDay } from "@/lib/staff/day-status";

export const VEHICLE_TYPES = ["TAXI", "VSL", "AMBULANCE"] as const satisfies readonly VehicleType[];
export const ENERGIES = ["DIESEL", "PETROL", "HYBRID", "ELECTRIC", "OTHER"] as const satisfies readonly EnergyType[];

/** Status: active vehicles by default. */
export const STATUS_FILTERS = { actifs: "Actifs", inactifs: "Désactivés", tous: "Tous" } as const;
export type StatusFilter = keyof typeof STATUS_FILTERS;

export const ALERT_FILTERS = {
  toutes: "Toutes les alertes",
  "echeance-depassee": "Échéance dépassée",
  echeance: "Échéance dépassée ou sous 30 jours",
  equipage: "Équipage par défaut à compléter",
} as const;
export type AlertFilter = keyof typeof ALERT_FILTERS;

export const TOMORROW_FILTERS = {
  indisponible: "Indisponibles",
  "sans-equipage": "Non planifiés (équipage)",
  "en-service": "En service",
} as const;
export type TomorrowFilter = keyof typeof TOMORROW_FILTERS;

export type VehicleListFilter = {
  q: string;
  depot: string | null;
  type: VehicleType | null;
  /** An energy, or "none": not filled in. */
  energy: EnergyType | "none" | null;
  alert: AlertFilter | null;
  tomorrow: TomorrowFilter | null;
  status: StatusFilter;
};

export function parseVehicleFilter(params: SearchParams): VehicleListFilter {
  const status = pickParam(params, "statut", ["inactifs", "tous"] as const);
  return {
    q: readParam(params, "q"),
    depot: idParam(params, "depot"),
    type: pickParam(params, "type", VEHICLE_TYPES),
    energy: pickParam(params, "energie", [...ENERGIES, "none"] as const),
    alert: pickParam(params, "alerte", Object.keys(ALERT_FILTERS) as AlertFilter[]),
    tomorrow: pickParam(params, "demain", Object.keys(TOMORROW_FILTERS) as TomorrowFilter[]),
    // « Afficher les désactivés » of the old list (?inactifs=1) showed every vehicle.
    status: status ?? (readParam(params, "inactifs") === "1" ? "tous" : "actifs"),
  };
}

/** Anything but the default view (active vehicles, no other filter). */
export function isFiltered(filter: VehicleListFilter): boolean {
  return (
    filter.q !== "" ||
    filter.depot !== null ||
    filter.type !== null ||
    filter.energy !== null ||
    filter.alert !== null ||
    filter.tomorrow !== null ||
    filter.status !== "actifs"
  );
}

/** What a row of the list is filtered on. */
export type FilterableVehicle = {
  label: string;
  registration: string;
  type: VehicleType;
  energy: EnergyType | null;
  depotId: string;
  active: boolean;
  /** Names of the default crew. */
  crewNames: readonly string[];
  overdueDeadlines: number;
  soonDeadlines: number;
  /** Default crew to complete: nobody, a missing crew mate, a missing qualification, a person shared with another vehicle. */
  crewProblem: boolean;
  tomorrow: VehicleDay | null;
};

export function matchesVehicleFilter(vehicle: FilterableVehicle, filter: VehicleListFilter): boolean {
  if (filter.status === "actifs" && !vehicle.active) return false;
  if (filter.status === "inactifs" && vehicle.active) return false;
  if (filter.depot !== null && vehicle.depotId !== filter.depot) return false;
  if (filter.type !== null && vehicle.type !== filter.type) return false;
  if (filter.energy === "none" ? vehicle.energy !== null : filter.energy !== null && vehicle.energy !== filter.energy) return false;
  if (filter.alert !== null && !hasAlert(vehicle, filter.alert)) return false;
  if (filter.tomorrow !== null && !isTomorrow(vehicle.tomorrow, filter.tomorrow)) return false;
  // « AB-123-CD » is found by « ab123 » too.
  return matchesWords(filter.q, [vehicle.label, vehicle.registration, vehicle.registration.replace(/[\s-]/g, ""), ...vehicle.crewNames]);
}

function hasAlert(vehicle: FilterableVehicle, alert: AlertFilter): boolean {
  const deadline = vehicle.overdueDeadlines > 0;
  const soon = deadline || vehicle.soonDeadlines > 0;
  switch (alert) {
    case "echeance-depassee":
      return deadline;
    case "echeance":
      return soon;
    case "equipage":
      return vehicle.crewProblem;
    case "toutes":
      return soon || vehicle.crewProblem || vehicle.tomorrow?.kind === "off" || vehicle.tomorrow?.kind === "missing";
  }
}

function isTomorrow(day: VehicleDay | null, wanted: TomorrowFilter): boolean {
  if (!day) return false;
  if (wanted === "indisponible") return day.kind === "off";
  if (wanted === "sans-equipage") return day.kind === "missing";
  return day.kind === "crew";
}
