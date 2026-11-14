/**
 * The dashboard's address: the tab shown, the period and its step, the
 * lateness tolerance, the depot and vehicle type it is narrowed to, the day
 * shown at the top, the axis and order of the breakdown. Pure: every link of
 * the page is built here, so a tab or a shortcut never loses a filter.
 */
import type { VehicleType } from "@prisma/client";
import { DEFAULT_KPI_OPTIONS, GRANULARITY_PARAMS, type Granularity } from "@/lib/kpis";

/** The tabs, in reading order: the summary first (the default, kept short), then one subject per tab. */
export const DASHBOARD_TABS = [
  { id: "synthese", label: "Synthèse", title: "Jours mis en avant, tendances et objectifs, détail par jour" },
  { id: "demande", label: "Demande", title: "Courses demandées, servies, perdues" },
  { id: "flotte", label: "Flotte", title: "Utilisation des véhicules, énergie, immobilisations et échéances" },
  { id: "partage", label: "Partage", title: "Transport partagé comme l'Assurance maladie le compte" },
  { id: "attentes", label: "Attentes", title: "Attentes au lieu de soins, temps à bord et ponctualité" },
  { id: "economie", label: "Économie", title: "CA, coût et marge par véhicule, par km, par heure et par type" },
  { id: "planification", label: "Planification", title: "Temps de planification réel et interventions manuelles" },
  { id: "ventilation", label: "Ventilation", title: "Par dépôt, type de véhicule, véhicule et personne" },
] as const;

export type DashboardTab = (typeof DASHBOARD_TABS)[number]["id"];

/** Axes of the « Ventilation » tab (?par=). */
export const BREAKDOWN_AXES = [
  { id: "depot", label: "Dépôts" },
  { id: "type", label: "Types de véhicule" },
  { id: "vehicule", label: "Véhicules" },
  { id: "chauffeur", label: "Personnel" },
] as const;

export type BreakdownAxis = (typeof BREAKDOWN_AXES)[number]["id"];

const VEHICLE_TYPES: readonly VehicleType[] = ["TAXI", "VSL", "AMBULANCE"];

export type DashboardQuery = {
  tab: DashboardTab;
  from: string | null;
  to: string | null;
  /** ?pas= as typed (jour, semaine, mois), null for the automatic step. */
  step: string | null;
  tolerance: number;
  depotId: string | null;
  vehicleType: VehicleType | null;
  day: string | null;
  axis: BreakdownAxis;
  /** Column the breakdown is sorted by (its own keys), null for the default order. */
  sort: string | null;
};

type Params = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The query of the address (unknown values fall back to the defaults; the tolerance is resolved by the caller). */
export function parseDashboardQuery(params: Params, tolerance: number): DashboardQuery {
  const tab = first(params.vue);
  const axis = first(params.par);
  const type = first(params.type);
  const depot = first(params.depot);
  const sort = first(params.tri);
  return {
    tab: DASHBOARD_TABS.some((t) => t.id === tab) ? (tab as DashboardTab) : "synthese",
    from: first(params.from),
    to: first(params.to),
    step: first(params.pas),
    tolerance,
    depotId: depot && ID.test(depot) ? depot : null,
    vehicleType: VEHICLE_TYPES.includes(type as VehicleType) ? (type as VehicleType) : null,
    day: first(params.day),
    axis: BREAKDOWN_AXES.some((a) => a.id === axis) ? (axis as BreakdownAxis) : "depot",
    sort: sort && /^-?[a-zA-Z]{1,32}$/.test(sort) ? sort : null,
  };
}

/** What a link keeps of the current address. */
export type HrefState = {
  tab?: DashboardTab;
  from: string;
  to: string;
  /** Step written in the address only when chosen (not the automatic one). */
  granularity?: Granularity | null;
  tolerance?: number | null;
  depotId?: string | null;
  vehicleType?: VehicleType | null;
  day?: string | null;
  axis?: BreakdownAxis | null;
  sort?: string | null;
};

/** Query string of the dashboard state (no leading « ? »); the defaults are left out. */
export function dashboardSearch(state: HrefState): string {
  const query = new URLSearchParams();
  if (state.tab && state.tab !== "synthese") query.set("vue", state.tab);
  query.set("from", state.from);
  query.set("to", state.to);
  if (state.granularity) query.set("pas", GRANULARITY_PARAMS[state.granularity]);
  if (state.tolerance !== undefined && state.tolerance !== null && state.tolerance !== DEFAULT_KPI_OPTIONS.lateToleranceMin) {
    query.set("retard", String(state.tolerance));
  }
  if (state.depotId) query.set("depot", state.depotId);
  if (state.vehicleType) query.set("type", state.vehicleType);
  if (state.day) query.set("day", state.day);
  if (state.axis && state.axis !== "depot") query.set("par", state.axis);
  if (state.sort) query.set("tri", state.sort);
  return query.toString();
}

export function dashboardHref(state: HrefState): string {
  return `/tableau-de-bord?${dashboardSearch(state)}`;
}

/** The CSV export of the same state (KPI-08): `lines` one per step, per depot or per vehicle. */
export function exportHref(state: HrefState, lines: "jour" | "depot" | "vehicule"): string {
  const { from, to, granularity, tolerance, depotId, vehicleType } = state;
  const query = new URLSearchParams(dashboardSearch({ from, to, granularity, tolerance, depotId, vehicleType }));
  if (lines !== "jour") query.set("lignes", lines);
  return `/tableau-de-bord/export?${query.toString()}`;
}
