/**
 * Fictitious reference data for the development seed. Town centres are real
 * (so travel times are realistic); every facility, person, address and phone
 * number is invented.
 */
import type {
  EnergyType,
  FacilityType,
  Mobility,
  Qualification,
  RecurrenceLegs,
  SharingScope,
  VehicleType,
} from "@prisma/client";
import { offset, type LatLng } from "./geo";

// ---------------------------------------------------------------------------
// Geography: real town centres on the Marseille – Grenoble axis.

type Town = LatLng & { name: string };

export const TOWNS = {
  marseille: { name: "Marseille", lat: 43.2965, lng: 5.3698 },
  aix: { name: "Aix-en-Provence", lat: 43.5297, lng: 5.4474 },
  gardanne: { name: "Gardanne", lat: 43.4549, lng: 5.4697 },
  pertuis: { name: "Pertuis", lat: 43.6942, lng: 5.5019 },
  manosque: { name: "Manosque", lat: 43.8335, lng: 5.7837 },
  forcalquier: { name: "Forcalquier", lat: 43.9597, lng: 5.7803 },
  sisteron: { name: "Sisteron", lat: 44.1955, lng: 5.9436 },
  laragne: { name: "Laragne-Montéglin", lat: 44.3164, lng: 5.8167 },
  gap: { name: "Gap", lat: 44.5594, lng: 6.0786 },
  veynes: { name: "Veynes", lat: 44.5336, lng: 5.8231 },
  grenoble: { name: "Grenoble", lat: 45.1885, lng: 5.7245 },
  // Suburbs and villages where occasional patients live (seed/one-off.ts): their care is in the nearest town.
  allauch: { name: "Allauch", lat: 43.3364, lng: 5.4822 },
  aubagne: { name: "Aubagne", lat: 43.2927, lng: 5.5708 },
  pennes: { name: "Les Pennes-Mirabeau", lat: 43.41, lng: 5.31 },
  venelles: { name: "Venelles", lat: 43.598, lng: 5.481 },
  bouc: { name: "Bouc-Bel-Air", lat: 43.452, lng: 5.414 },
  oraison: { name: "Oraison", lat: 43.917, lng: 5.918 },
  vinon: { name: "Vinon-sur-Verdon", lat: 43.724, lng: 5.811 },
  chateauArnoux: { name: "Château-Arnoux-Saint-Auban", lat: 44.092, lng: 6.009 },
  tallard: { name: "Tallard", lat: 44.463, lng: 6.055 },
  chorges: { name: "Chorges", lat: 44.547, lng: 6.277 },
  meylan: { name: "Meylan", lat: 45.2096, lng: 5.7787 },
  echirolles: { name: "Échirolles", lat: 45.1436, lng: 5.7183 },
  vizille: { name: "Vizille", lat: 45.0786, lng: 5.7708 },
} as const satisfies Record<string, Town>;

export type TownKey = keyof typeof TOWNS;

/**
 * Residential areas. The centre of an area is a fixed offset (bearing, km)
 * from the town centre, chosen to stay on land in Marseille; homes are then
 * scattered up to `spreadKm` around it, so patients of one area are neighbours.
 */
type AreaDef = { town: TownKey; postalCode: string; bearing: number; distanceKm: number; spreadKm: number };

const AREA_DEFS = {
  marseille4: { town: "marseille", postalCode: "13004", bearing: 65, distanceKm: 2.6, spreadKm: 0.8 },
  marseille5: { town: "marseille", postalCode: "13005", bearing: 100, distanceKm: 1.8, spreadKm: 0.7 },
  marseille6: { town: "marseille", postalCode: "13006", bearing: 185, distanceKm: 1.4, spreadKm: 0.6 },
  marseille10: { town: "marseille", postalCode: "13010", bearing: 140, distanceKm: 3.2, spreadKm: 0.8 },
  marseille12: { town: "marseille", postalCode: "13012", bearing: 80, distanceKm: 4.0, spreadKm: 0.9 },
  marseille13: { town: "marseille", postalCode: "13013", bearing: 25, distanceKm: 4.0, spreadKm: 0.9 },
  aixNord: { town: "aix", postalCode: "13100", bearing: 20, distanceKm: 1.6, spreadKm: 0.9 },
  aixSud: { town: "aix", postalCode: "13090", bearing: 230, distanceKm: 2.2, spreadKm: 0.9 },
  gardanne: { town: "gardanne", postalCode: "13120", bearing: 90, distanceKm: 1.0, spreadKm: 0.7 },
  pertuis: { town: "pertuis", postalCode: "84120", bearing: 0, distanceKm: 1.0, spreadKm: 0.7 },
  manosque: { town: "manosque", postalCode: "04100", bearing: 300, distanceKm: 1.2, spreadKm: 0.8 },
  manosqueNord: { town: "manosque", postalCode: "04100", bearing: 20, distanceKm: 1.8, spreadKm: 0.8 },
  forcalquier: { town: "forcalquier", postalCode: "04300", bearing: 150, distanceKm: 1.0, spreadKm: 0.5 },
  sisteron: { town: "sisteron", postalCode: "04200", bearing: 200, distanceKm: 1.0, spreadKm: 0.5 },
  laragne: { town: "laragne", postalCode: "05300", bearing: 180, distanceKm: 1.0, spreadKm: 0.5 },
  gap: { town: "gap", postalCode: "05000", bearing: 45, distanceKm: 1.5, spreadKm: 0.8 },
  gapSud: { town: "gap", postalCode: "05000", bearing: 210, distanceKm: 1.8, spreadKm: 0.7 },
  veynes: { town: "veynes", postalCode: "05400", bearing: 90, distanceKm: 1.0, spreadKm: 0.5 },
  // Used by the occasional patients and the large fleet only (pnpm db:seed --fleet).
  grenoble: { town: "grenoble", postalCode: "38000", bearing: 330, distanceKm: 1.2, spreadKm: 1.0 },
  grenobleSud: { town: "grenoble", postalCode: "38100", bearing: 190, distanceKm: 2.6, spreadKm: 1.0 },
  allauch: { town: "allauch", postalCode: "13190", bearing: 0, distanceKm: 0.5, spreadKm: 1.2 },
  aubagne: { town: "aubagne", postalCode: "13400", bearing: 0, distanceKm: 0.5, spreadKm: 1.5 },
  pennes: { town: "pennes", postalCode: "13170", bearing: 0, distanceKm: 0.5, spreadKm: 1.5 },
  venelles: { town: "venelles", postalCode: "13770", bearing: 0, distanceKm: 0.3, spreadKm: 1.0 },
  bouc: { town: "bouc", postalCode: "13320", bearing: 0, distanceKm: 0.3, spreadKm: 1.0 },
  oraison: { town: "oraison", postalCode: "04700", bearing: 0, distanceKm: 0.3, spreadKm: 0.8 },
  vinon: { town: "vinon", postalCode: "83560", bearing: 0, distanceKm: 0.3, spreadKm: 0.8 },
  chateauArnoux: { town: "chateauArnoux", postalCode: "04160", bearing: 0, distanceKm: 0.3, spreadKm: 1.0 },
  tallard: { town: "tallard", postalCode: "05130", bearing: 0, distanceKm: 0.3, spreadKm: 0.8 },
  chorges: { town: "chorges", postalCode: "05230", bearing: 0, distanceKm: 0.3, spreadKm: 0.8 },
  meylan: { town: "meylan", postalCode: "38240", bearing: 0, distanceKm: 0.3, spreadKm: 1.0 },
  echirolles: { town: "echirolles", postalCode: "38130", bearing: 0, distanceKm: 0.3, spreadKm: 1.0 },
  vizille: { town: "vizille", postalCode: "38220", bearing: 0, distanceKm: 0.3, spreadKm: 0.8 },
} as const satisfies Record<string, AreaDef>;

export type AreaKey = keyof typeof AREA_DEFS;

export type Area = { key: AreaKey; town: TownKey; city: string; postalCode: string; centre: LatLng; spreadKm: number };

export function area(key: AreaKey): Area {
  const def: AreaDef = AREA_DEFS[key];
  const town = TOWNS[def.town];
  return {
    key,
    town: def.town,
    city: town.name,
    postalCode: def.postalCode,
    centre: offset(town, def.bearing, def.distanceKm),
    spreadKm: def.spreadKm,
  };
}

// ---------------------------------------------------------------------------
// Facilities (all invented, located around real town centres).

export type FacilityDef = {
  name: string;
  type: FacilityType;
  town: TownKey;
  bearing: number;
  distanceKm: number;
  address: string;
  postalCode: string;
  notes: string | null;
  /** Minutes added to the stop at the facility (Facility.extraServiceMin); absent: 0. */
  extraServiceMin?: number;
};

export const FACILITIES = {
  dialysisMarseille: {
    name: "Centre de dialyse des Oliviers (fictif)",
    type: "DIALYSIS",
    town: "marseille",
    bearing: 88,
    distanceKm: 3.3,
    address: "112 boulevard des Oliviers",
    postalCode: "13012",
    notes: "Entrée des transports par le parking arrière (portail B). Séances 7 h 30 et 13 h.",
  },
  hospitalMarseille: {
    name: "Hôpital universitaire des Calanques (fictif)",
    type: "HOSPITAL",
    town: "marseille",
    bearing: 115,
    distanceKm: 2.7,
    address: "264 rue des Calanques",
    postalCode: "13005",
    notes: "Dépose des patients devant le hall 2. Hôpital de jour d'oncologie au 3e étage.",
    // Escorting the patient to the 3rd floor.
    extraServiceMin: 5,
  },
  radiotherapyMarseille: {
    name: "Institut de radiothérapie Méditerranée (fictif)",
    type: "RADIOTHERAPY",
    town: "marseille",
    bearing: 150,
    distanceKm: 3.6,
    address: "18 avenue des Tamaris",
    postalCode: "13010",
    notes: "Accueil ouvert de 7 h 30 à 18 h 30. Arrêt minute devant l'entrée principale.",
  },
  dialysisAix: {
    name: "Centre de dialyse du Pays d'Aix (fictif)",
    type: "DIALYSIS",
    town: "aix",
    bearing: 200,
    distanceKm: 1.6,
    address: "7 avenue des Platanes",
    postalCode: "13090",
    notes: null,
  },
  chemotherapyAix: {
    name: "Hôpital de jour d'oncologie Sainte-Victoire (fictif)",
    type: "CHEMOTHERAPY",
    town: "aix",
    bearing: 55,
    distanceKm: 1.9,
    address: "41 chemin des Vignes",
    postalCode: "13100",
    notes: "Prévenir l'accueil à l'arrivée d'un transport partagé.",
  },
  dialysisManosque: {
    name: "Centre de dialyse de la Durance (fictif)",
    type: "DIALYSIS",
    town: "manosque",
    bearing: 165,
    distanceKm: 1.4,
    address: "15 avenue des Lavandes",
    postalCode: "04100",
    notes: null,
  },
  dialysisGap: {
    name: "Centre de dialyse du Champsaur (fictif)",
    type: "DIALYSIS",
    town: "gap",
    bearing: 225,
    distanceKm: 1.3,
    address: "9 rue des Marmottes",
    postalCode: "05000",
    notes: "Rampe d'accès côté parking pour les brancards.",
  },
  hospitalGap: {
    name: "Centre hospitalier des Alpages (fictif)",
    type: "HOSPITAL",
    town: "gap",
    bearing: 20,
    distanceKm: 1.7,
    address: "1 place des Mélèzes",
    postalCode: "05000",
    notes: "Chimiothérapie ambulatoire : entrée C, 1er étage.",
  },
  hospitalGrenoble: {
    name: "Centre hospitalier universitaire des Trois Massifs (fictif)",
    type: "HOSPITAL",
    town: "grenoble",
    bearing: 160,
    distanceKm: 2.8,
    address: "50 avenue des Glaciers",
    postalCode: "38100",
    notes: null,
  },
  radiotherapyGrenoble: {
    name: "Centre de radiothérapie du Vercors (fictif)",
    type: "RADIOTHERAPY",
    town: "grenoble",
    bearing: 205,
    distanceKm: 2.2,
    address: "23 rue du Moucherotte",
    postalCode: "38100",
    notes: "Patients venant des Hautes-Alpes : prévenir en cas de retard (col de la Croix-Haute).",
  },
  dialysisGrenoble: {
    name: "Centre de dialyse Belledonne (fictif)",
    type: "DIALYSIS",
    town: "grenoble",
    bearing: 95,
    distanceKm: 1.8,
    address: "6 allée des Edelweiss",
    postalCode: "38000",
    notes: "Centre de repli et de dialyse vacances.",
  },
} as const satisfies Record<string, FacilityDef>;

/**
 * Destinations of the one-off trips (consultations, imaging, admissions and
 * discharges, seed/one-off.ts), created after FACILITIES with their
 * own generator so the patients drawn afterwards stay those of earlier seeds.
 */
export const ONE_OFF_FACILITIES = {
  imagingMarseille: {
    name: "Centre d'imagerie médicale des Pins (fictif)",
    type: "OTHER",
    town: "marseille",
    bearing: 200,
    distanceKm: 2.6,
    address: "47 avenue des Pins Parasols",
    postalCode: "13008",
    notes: "Scanner et IRM au sous-sol : ascenseur à gauche de l'accueil.",
  },
  clinicAix: {
    name: "Clinique du Pays d'Aix (fictif)",
    type: "CLINIC",
    town: "aix",
    bearing: 300,
    distanceKm: 1.8,
    address: "12 avenue des Cèdres",
    postalCode: "13090",
    notes: "Consultations au rez-de-chaussée ; entrées et sorties d'hospitalisation à l'accueil principal.",
  },
  hospitalManosque: {
    name: "Centre hospitalier de Haute-Provence (fictif)",
    type: "HOSPITAL",
    town: "manosque",
    bearing: 30,
    distanceKm: 1.5,
    address: "3 avenue des Romarins",
    postalCode: "04100",
    notes: "Sorties d'hospitalisation : hall B, prévenir le service à l'arrivée.",
  },
  imagingSisteron: {
    name: "Centre d'imagerie de la Citadelle (fictif)",
    type: "OTHER",
    town: "sisteron",
    bearing: 160,
    distanceKm: 0.8,
    address: "6 rue des Remparts",
    postalCode: "04200",
    notes: null,
  },
  imagingGap: {
    name: "Centre d'imagerie du Gapençais (fictif)",
    type: "OTHER",
    town: "gap",
    bearing: 120,
    distanceKm: 1.0,
    address: "22 avenue des Écrins",
    postalCode: "05000",
    notes: null,
  },
  imagingGrenoble: {
    name: "Centre d'imagerie du Drac (fictif)",
    type: "OTHER",
    town: "grenoble",
    bearing: 250,
    distanceKm: 2.0,
    address: "14 quai des Alpages",
    postalCode: "38000",
    notes: null,
  },
} as const satisfies Record<string, FacilityDef>;

export type OneOffFacilityKey = keyof typeof ONE_OFF_FACILITIES;
export type FacilityKey = keyof typeof FACILITIES;
/** Any facility of the seed: those of the series and those of the one-off trips. */
export type AnyFacilityKey = FacilityKey | OneOffFacilityKey;

export function facilityLocation(def: FacilityDef): LatLng {
  return offset(TOWNS[def.town], def.bearing, def.distanceKm);
}

// ---------------------------------------------------------------------------
// Depots, drivers and vehicles.

export type DepotDef = {
  label: string;
  town: TownKey;
  bearing: number;
  distanceKm: number;
  address: string;
  postalCode: string;
  department: string;
  /** Access to the depot, shown to the crews at the departure and the return (fictitious). */
  notes: string | null;
};

export const DEPOTS = {
  marseille: {
    label: "Marseille",
    town: "marseille",
    bearing: 75,
    distanceKm: 3.0,
    address: "27 rue des Cigales",
    postalCode: "13012",
    department: "13",
    notes: "Portail coulissant : badge ou code 2580. Clés des véhicules dans le boîtier à côté du bureau.",
  },
  manosque: {
    label: "Manosque",
    town: "manosque",
    bearing: 240,
    distanceKm: 1.0,
    address: "8 avenue de la Durance",
    postalCode: "04100",
    department: "04",
    notes: "Stationnement des VSL sous l'auvent, côté atelier. Bureau ouvert de 6 h 30 à 19 h.",
  },
  sisteron: {
    label: "Sisteron",
    town: "sisteron",
    bearing: 20,
    distanceKm: 0.9,
    address: "14 route de Gap",
    postalCode: "04200",
    department: "04",
    notes: null,
  },
  gap: {
    label: "Gap",
    town: "gap",
    bearing: 260,
    distanceKm: 1.2,
    address: "5 rue des Alpes",
    postalCode: "05000",
    department: "05",
    notes: "Entrée par la rue arrière en hiver (pente verglacée côté rue des Alpes).",
  },
} as const satisfies Record<string, DepotDef>;

export type DepotKey = keyof typeof DEPOTS;

/** The two more depots of the large fleet (pnpm db:seed --fleet). */
export const FLEET_DEPOTS = {
  aix: {
    label: "Aix-en-Provence",
    town: "aix",
    bearing: 250,
    distanceKm: 2.4,
    address: "19 chemin des Micocouliers",
    postalCode: "13090",
    department: "13",
    notes: "Parking des véhicules au sous-sol, badge à l'entrée. Bureau de régulation au 1er étage.",
  },
  grenoble: {
    label: "Grenoble",
    town: "grenoble",
    bearing: 170,
    distanceKm: 3.5,
    address: "4 rue des Sapins",
    postalCode: "38100",
    department: "38",
    notes: "Portail automatique : code 1938. Chaînes à neige dans le local à droite (novembre à mars).",
  },
} as const satisfies Record<string, DepotDef>;

export type FleetDepotKey = DepotKey | keyof typeof FLEET_DEPOTS;

export function depotLocation(def: DepotDef): LatLng {
  return offset(TOWNS[def.town], def.bearing, def.distanceKm);
}

export type DriverDef = {
  firstName: string;
  lastName: string;
  qualifications: readonly Qualification[];
  workDays: readonly number[];
  shift: readonly [start: string, end: string];
  breakMinutes: number;
  /** Years of seniority: the hourly cost is the loaded cost of the person's role (costs.ts) plus seniority. */
  seniorityYears: number;
};

const MON_FRI = [1, 2, 3, 4, 5];
const MON_SAT = [1, 2, 3, 4, 5, 6];
const TUE_SAT = [2, 3, 4, 5, 6];

/** Every driver takes a break in the 11:30 – 14:00 window. */
export const BREAK_WINDOW = ["11:30", "14:00"] as const;

export const DRIVERS = {
  julien: { firstName: "Julien", lastName: "Marchetti", qualifications: ["TAXI_CARD"], workDays: MON_SAT, shift: ["06:00", "18:30"], breakMinutes: 45, seniorityYears: 3 },
  elodie: { firstName: "Élodie", lastName: "Fabre", qualifications: ["AUXILIARY"], workDays: MON_SAT, shift: ["06:30", "19:00"], breakMinutes: 30, seniorityYears: 4 },
  laurent: { firstName: "Laurent", lastName: "Giraud", qualifications: ["DEA", "AUXILIARY"], workDays: MON_SAT, shift: ["06:00", "19:00"], breakMinutes: 45, seniorityYears: 5 },
  ines: { firstName: "Inès", lastName: "Moulin", qualifications: ["AUXILIARY"], workDays: MON_SAT, shift: ["06:00", "19:00"], breakMinutes: 45, seniorityYears: 1 },
  sophie: { firstName: "Sophie", lastName: "Rinaldi", qualifications: ["TAXI_CARD"], workDays: MON_FRI, shift: ["06:00", "18:30"], breakMinutes: 30, seniorityYears: 2 },
  mathieu: { firstName: "Mathieu", lastName: "Roux", qualifications: ["AUXILIARY", "TAXI_CARD"], workDays: MON_SAT, shift: ["06:00", "19:00"], breakMinutes: 45, seniorityYears: 3 },
  thomas: { firstName: "Thomas", lastName: "Garnier", qualifications: ["TAXI_CARD"], workDays: MON_FRI, shift: ["06:00", "19:00"], breakMinutes: 30, seniorityYears: 1 },
  celine: { firstName: "Céline", lastName: "Arnaud", qualifications: ["AUXILIARY"], workDays: MON_SAT, shift: ["06:00", "18:30"], breakMinutes: 30, seniorityYears: 2 },
  nadia: { firstName: "Nadia", lastName: "Belkacem", qualifications: ["TAXI_CARD"], workDays: MON_FRI, shift: ["06:30", "19:00"], breakMinutes: 45, seniorityYears: 0 },
  // Works Saturdays so the Gap fleet is staffed for the Tue/Thu/Sat dialysis patients (with Céline in Sisteron).
  romain: { firstName: "Romain", lastName: "Chabert", qualifications: ["DEA"], workDays: MON_SAT, shift: ["06:00", "19:00"], breakMinutes: 30, seniorityYears: 3 },
  franck: { firstName: "Franck", lastName: "Bonnet", qualifications: ["DEA"], workDays: MON_FRI, shift: ["06:00", "19:00"], breakMinutes: 45, seniorityYears: 4 },
  amandine: { firstName: "Amandine", lastName: "Reynaud", qualifications: ["DEA", "AUXILIARY"], workDays: MON_FRI, shift: ["06:00", "19:00"], breakMinutes: 45, seniorityYears: 2 },
  // Replacement drivers: default driver of no vehicle; the crews of the day propose them when someone
  // of their depot, or of a depot close enough (Paramètres, « Équipages »), is absent.
  kevin: { firstName: "Kévin", lastName: "Lambert", qualifications: ["TAXI_CARD", "AUXILIARY"], workDays: TUE_SAT, shift: ["07:00", "19:00"], breakMinutes: 30, seniorityYears: 0 },
  sabrina: { firstName: "Sabrina", lastName: "Morel", qualifications: ["DEA", "AUXILIARY"], workDays: MON_FRI, shift: ["06:00", "17:00"], breakMinutes: 30, seniorityYears: 2 },
} as const satisfies Record<string, DriverDef>;

export type DriverKey = keyof typeof DRIVERS;

/** Depot of the replacement drivers (the others belong to the depot of the vehicle they crew). */
export const REPLACEMENT_DRIVER_DEPOTS: Partial<Record<DriverKey, DepotKey>> = { kevin: "manosque", sabrina: "gap" };

type VehicleDef = {
  label: string;
  registration: string;
  type: VehicleType;
  depot: DepotKey;
  /** Added to the cost per km of its type and energy (costs.ts): older vehicles cost a little more. */
  ageSurcharge: number;
  driver: DriverKey;
  crewMate: DriverKey | null;
  /** Diesel unless stated. */
  energy?: EnergyType;
  /** Fitted for a patient in their wheelchair (TPMR supplement); a demonstration assumption, V's fleet is unknown. */
  tpmrEquipped?: boolean;
};

export const VEHICLES: readonly VehicleDef[] = [
  { label: "Taxi 1 (Marseille)", registration: "GH-218-PZ", type: "TAXI", depot: "marseille", ageSurcharge: 0.02, driver: "julien", crewMate: null },
  { label: "VSL 1 (Marseille)", tpmrEquipped: true, registration: "FK-547-TR", type: "VSL", depot: "marseille", ageSurcharge: 0.01, driver: "elodie", crewMate: null },
  // The usual crew of V: the auxiliary drives, the DEA rides beside the patient (R. 6312-10 allows either way).
  { label: "Ambulance 1 (Marseille)", registration: "GA-903-MB", type: "AMBULANCE", depot: "marseille", ageSurcharge: 0, driver: "ines", crewMate: "laurent" },
  { label: "Taxi 2 (Manosque)", registration: "FV-162-LD", type: "TAXI", depot: "manosque", ageSurcharge: 0, driver: "sophie", crewMate: null, energy: "ELECTRIC" },
  { label: "VSL 2 (Manosque)", registration: "GC-775-HN", type: "VSL", depot: "manosque", ageSurcharge: 0.01, driver: "mathieu", crewMate: null },
  { label: "Taxi 3 (Sisteron)", registration: "FS-384-KE", type: "TAXI", depot: "sisteron", ageSurcharge: 0, driver: "thomas", crewMate: null },
  { label: "VSL 3 (Sisteron)", registration: "GE-629-JW", type: "VSL", depot: "sisteron", ageSurcharge: 0.02, driver: "celine", crewMate: null },
  { label: "Taxi 4 (Gap)", registration: "FP-451-RC", type: "TAXI", depot: "gap", ageSurcharge: 0.01, driver: "nadia", crewMate: null },
  { label: "VSL 4 (Gap)", registration: "GD-806-XA", type: "VSL", depot: "gap", ageSurcharge: 0.02, driver: "romain", crewMate: null },
  { label: "Ambulance 2 (Gap)", registration: "FZ-270-BV", type: "AMBULANCE", depot: "gap", ageSurcharge: 0.01, driver: "franck", crewMate: "amandine" },
];

// ---------------------------------------------------------------------------
// Tariff grids: the official values verified on 9 November 2026 (memo of the
// tariff batch, section 4). They live in the database so the regulator can
// correct them without touching code; each says its source and how it was
// verified. Values the memo leaves unverified are not entered (taxi « courte
// distance » supplement, local SX1 supplement, Grenoble's ambulance « forfait
// spécial », the rules of 1 July 2027).

type Verification = "OFFICIAL" | "SECONDARY" | "UNVERIFIED";

export type TariffDef = {
  vehicleType: VehicleType;
  department: string;
  certified: boolean | null;
  zone?: string;
  label: string;
  baseFare: number;
  aggloFare?: number;
  bigCityFare?: number;
  includedKm: number;
  pricePerKm: number;
  shortTripBands?: { upToKm: number; amount: number }[];
  nightRate: number;
  weekendRate: number;
  emptyLegRateShort?: number;
  emptyLegRateLong?: number;
  emptyLegThresholdKm?: number;
  sharedDiscounts: { patients: number; rate: number }[];
  maxSharedPatients: number;
  aloneDiscount?: number;
  aloneThresholdKm?: number;
  billableDetourKm?: number[];
  tpmrFare?: number;
  verification: Verification;
  sourceUrl: string;
  validFrom: string;
  validTo: string | null;
  notes: string;
};

export const TARIFF_SOURCES = {
  taxiConvention: "https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000052060568",
  vslAmeli: "https://www.ameli.fr/transporteur-sanitaire/exercice-professionnel/facturation/tarifs/vsl-tarifs-conventionnels",
  ambulanceAmeli: "https://www.ameli.fr/transporteur-sanitaire/exercice-professionnel/facturation/tarifs/ambulances-tarifs-conventionnels",
  protocol2025: "https://www.ameli.fr/sites/default/files/Documents/protocole-accord-depenses-maitrises-transporteur-sanitaire.pdf",
  amendment11: "https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000047524277",
  aggloCommunes: "https://www.ameli.fr/sites/default/files/Documents/5248/document/liste-communes-forfait-agglomeration_assurance-maladie.pdf",
  aggloCommunesRtf: "https://www.ameli.fr/sites/default/files/Documents/5247/document/liste-communes-forfait-agglomeration_assurance-maladie.rtf",
} as const;

const TAXI_KM_RATES: [department: string, name: string, rate: number][] = [
  ["13", "Bouches-du-Rhône", 1.1],
  ["84", "Vaucluse", 1.2],
  ["04", "Alpes-de-Haute-Provence", 1.14],
  ["05", "Hautes-Alpes", 1.18],
  ["26", "Drôme", 1.16],
  ["38", "Isère", 1.22],
];

const TAXI_GRIDS: TariffDef[] = TAXI_KM_RATES.map(([department, name, rate]) => ({
  vehicleType: "TAXI",
  department,
  certified: null,
  label: `Taxi conventionné — ${name}`,
  baseFare: 13,
  bigCityFare: 15,
  includedKm: 4,
  pricePerKm: rate,
  nightRate: 0.5,
  weekendRate: 0.5,
  emptyLegRateShort: 0.25,
  emptyLegRateLong: 0.5,
  emptyLegThresholdKm: 50,
  sharedDiscounts: [
    { patients: 2, rate: 0.23 },
    { patients: 3, rate: 0.35 },
    { patients: 4, rate: 0.37 },
  ],
  maxSharedPatients: 8,
  aloneDiscount: 0.05,
  aloneThresholdKm: 30,
  tpmrFare: 30,
  verification: "OFFICIAL",
  sourceUrl: TARIFF_SOURCES.taxiConvention,
  validFrom: "2025-11-01",
  validTo: null,
  notes:
    "Convention-cadre nationale des taxis conventionnés (arrêté du 29/07/2025), tarifs du 1er novembre 2025. " +
    "Seuil de l'abattement « patient seul » non vérifié : 30 km, minimum national, en attendant la valeur de la CPAM.",
}));

const VSL_SHORT_TRIP: TariffDef["shortTripBands"] = [
  [7, 8.54],
  [8, 7.68],
  [9, 7.03],
  [10, 6.35],
  [11, 5.22],
  [12, 4.62],
  [13, 4.01],
  [14, 3.41],
  [15, 2.8],
  [16, 2.07],
  [17, 1.5],
  [18, 0.91],
].map(([upToKm, amount]) => ({ upToKm: upToKm!, amount: amount! }));

const DEPARTMENT_NAMES: Record<string, string> = {
  "13": "Bouches-du-Rhône",
  "04": "Alpes-de-Haute-Provence",
  "05": "Hautes-Alpes",
  "38": "Isère",
  "84": "Vaucluse",
  "26": "Drôme",
};

function vsl(
  certified: boolean,
  department: string,
  baseFare: number,
  pricePerKm: number,
  period: { validFrom: string; validTo: string | null },
  source: { url: string; notes: string },
): TariffDef {
  const zone = ["84", "26"].includes(department) ? "C" : department === "*" ? undefined : "B";
  const place = department === "*" ? "" : ` zone ${zone} — ${DEPARTMENT_NAMES[department]}`;
  const history = period.validTo ? ` (jusqu'au ${period.validTo.split("-").reverse().join("/")})` : "";
  return {
    vehicleType: "VSL",
    department,
    certified,
    ...(zone ? { zone } : {}),
    label: `VSL ${certified ? "majoré" : "socle"}${place}${history}`,
    baseFare,
    includedKm: 3,
    pricePerKm,
    shortTripBands: VSL_SHORT_TRIP,
    nightRate: 0.5,
    weekendRate: 0.25,
    sharedDiscounts: certified
      ? [
          { patients: 2, rate: 0.15 },
          { patients: 3, rate: 0.33 },
        ]
      : [
          { patients: 2, rate: 0.23 },
          { patients: 3, rate: 0.35 },
        ],
    maxSharedPatients: 3,
    billableDetourKm: [10, 10],
    tpmrFare: 30,
    verification: "OFFICIAL",
    sourceUrl: source.url,
    ...period,
    notes: source.notes,
  };
}

const VSL_MAJORED = { url: TARIFF_SOURCES.vslAmeli, notes: "Avenant 11 et ameli (tarifs VSL) : forfait 15,75 €, 3 km inclus, 1,10 €/km. TVA de 10 % comprise (CA suivi TTC)." };
const VSL_BASE = { url: TARIFF_SOURCES.protocol2025, notes: "Protocole du 24/09/2025 : tarifs de base baissés de 13 % pour les entreprises non certifiées. TVA de 10 % comprise." };
const VSL_HISTORY = { url: TARIFF_SOURCES.amendment11, notes: "Avenant 11 (arrêté d'approbation, JO du 06/05/2023), grille remplacée." };

const VSL_GRIDS: TariffDef[] = [
  vsl(true, "*", 15.75, 1.1, { validFrom: "2025-01-01", validTo: null }, VSL_MAJORED),
  ...["13", "04", "05", "38"].map((d) => vsl(false, d, 12.11, 0.93, { validFrom: "2025-10-01", validTo: null }, VSL_BASE)),
  ...["84", "26"].map((d) => vsl(false, d, 11.34, 0.93, { validFrom: "2025-10-01", validTo: null }, VSL_BASE)),
  vsl(true, "*", 15, 1.07, { validFrom: "2023-11-01", validTo: "2024-12-31" }, VSL_HISTORY),
  ...["13", "04", "05", "38"].map((d) => vsl(false, d, 13.92, 1.07, { validFrom: "2023-11-01", validTo: "2025-09-30" }, VSL_HISTORY)),
  ...["84", "26"].map((d) => vsl(false, d, 13.04, 1.07, { validFrom: "2023-11-01", validTo: "2025-09-30" }, VSL_HISTORY)),
];

function ambulance(
  certified: boolean,
  baseFare: number,
  aggloFare: number,
  bands: [number, number, number, number],
  period: { validFrom: string; validTo: string | null },
  source: { url: string; notes: string },
): TariffDef {
  return {
    vehicleType: "AMBULANCE",
    department: "*",
    certified,
    label: `Ambulance ${certified ? "majorée" : "socle"}${period.validTo ? ` (jusqu'au ${period.validTo.split("-").reverse().join("/")})` : ""}`,
    baseFare,
    aggloFare,
    includedKm: 3,
    pricePerKm: 2.44,
    shortTripBands: [5, 10, 15, 19].map((upToKm, i) => ({ upToKm, amount: bands[i]! })),
    nightRate: 0.75,
    weekendRate: 0.5,
    sharedDiscounts: [],
    maxSharedPatients: 1,
    verification: "OFFICIAL",
    sourceUrl: source.url,
    ...period,
    notes: source.notes,
  };
}

const AMBULANCE_GRIDS: TariffDef[] = [
  ambulance(true, 57.39, 64.08, [9.75, 7.53, 5.47, 3.42], { validFrom: "2025-01-01", validTo: null }, {
    url: TARIFF_SOURCES.ambulanceAmeli,
    notes: "Ameli (tarifs ambulances) et avenant 11. Exonérée de TVA. Majoration du trajet court la nuit et le dimanche : question ouverte.",
  }),
  ambulance(false, 45.6, 50.92, [7.57, 5.95, 4.32, 2.71], { validFrom: "2025-10-01", validTo: null }, {
    url: TARIFF_SOURCES.protocol2025,
    notes: "Protocole du 24/09/2025 : entreprise non certifiée. Exonérée de TVA.",
  }),
  ambulance(true, 54.65, 61.03, [8.7, 6.84, 4.97, 3.11], { validFrom: "2023-11-07", validTo: "2024-12-31" }, {
    url: TARIFF_SOURCES.ambulanceAmeli,
    notes: "Avenant 11, grille remplacée.",
  }),
  ambulance(false, 52.41, 58.53, [8.7, 6.84, 4.97, 3.11], { validFrom: "2023-11-07", validTo: "2025-09-30" }, {
    url: TARIFF_SOURCES.protocol2025,
    notes: "Avenant 11, grille socle remplacée le 01/10/2025.",
  }),
];

export const TARIFFS: readonly TariffDef[] = [...TAXI_GRIDS, ...VSL_GRIDS, ...AMBULANCE_GRIDS];

/** Company billing settings of the demonstration (hypotheses: V's real status is a PO question). */
export const COMPANY_BILLING = {
  /** Certified (certified geolocation on every vehicle and SEFi billing) since this date. */
  certifiedSince: "2025-01-01",
  hqDepartment: "13",
  hqCity: "Marseille",
} as const;

export type TariffAreaDef = {
  kind: "BIG_CITY" | "AGGLOMERATION";
  name: string;
  department: string;
  communes: string[];
  rule: "ANY_END" | "BOTH_INSIDE" | "TO_HUB";
  hubCommune?: string;
  validFrom: string | null;
  verification: Verification;
  sourceUrl: string;
  notes: string;
};

export const TARIFF_AREAS: readonly TariffAreaDef[] = [
  {
    kind: "BIG_CITY",
    name: "Marseille",
    department: "13",
    communes: ["Marseille"],
    rule: "ANY_END",
    validFrom: "2025-11-01",
    verification: "OFFICIAL",
    sourceUrl: TARIFF_SOURCES.taxiConvention,
    notes: "Forfait « Grande ville » de 15 € (convention taxis 2025).",
  },
  {
    kind: "BIG_CITY",
    name: "Grenoble",
    department: "38",
    communes: ["Grenoble"],
    rule: "ANY_END",
    validFrom: "2025-11-01",
    verification: "OFFICIAL",
    sourceUrl: TARIFF_SOURCES.taxiConvention,
    notes:
      "Les établissements limitrophes au forfait par extension (CHU à La Tronche et à Échirolles, AGDUC) se repèrent " +
      "par leur FINESS, que les établissements de l'application n'ont pas encore.",
  },
  {
    kind: "AGGLOMERATION",
    name: "Agglomération de Marseille",
    department: "13",
    communes: ["Marseille", "Allauch", "La Penne-sur-Huveaune", "Plan-de-Cuques", "Septèmes-les-Vallons"],
    rule: "BOTH_INSIDE",
    validFrom: null,
    verification: "OFFICIAL",
    sourceUrl: TARIFF_SOURCES.aggloCommunes,
    notes: "Forfait agglomération des ambulances : transport entièrement dans ces communes, entreprise dont le siège y est.",
  },
  {
    kind: "AGGLOMERATION",
    name: "Agglomération d'Avignon",
    department: "84",
    communes: [
      "Sorgues",
      "Le Pontet",
      "Saint-Saturnin-lès-Avignon",
      "Châteauneuf-de-Gadagne",
      "Jonquerettes",
      "Vedène",
      "Morières-lès-Avignon",
      "Caumont-sur-Durance",
      "Châteaurenard (13)",
      "Barbentane (13)",
      "Rognonas (13)",
      "Villeneuve-lès-Avignon (30)",
      "Les Angles (30)",
    ],
    rule: "TO_HUB",
    hubCommune: "Avignon",
    validFrom: null,
    verification: "OFFICIAL",
    sourceUrl: TARIFF_SOURCES.aggloCommunesRtf,
    notes: "Courses entre ces communes et Avignon, dans les deux sens (liste de 2003). Le cas de Montfavet n'est pas modélisé.",
  },
];

// ---------------------------------------------------------------------------
// Patients: one regular treatment each. Cohorts are tuned so a weekday yields
// about 55-65 trips of series, and several pairs share a facility, an
// appointment time, a neighbourhood and a prescription that allows sharing.
// The one-off trips (seed/one-off.ts, about 13 more on a weekday) fill
// the hours between the sessions, as in a real company.

export type Treatment = "DIALYSIS" | "RADIOTHERAPY" | "CHEMOTHERAPY";

export const TREATMENTS: Record<Treatment, { label: string; sessionMinutes: number; prescriber: string; notes: string }> = {
  DIALYSIS: {
    label: "Dialyse",
    sessionMinutes: 240,
    prescriber: "Dr Claire Vasseur — néphrologie",
    notes: "PMT série : hémodialyse 3 fois par semaine.",
  },
  RADIOTHERAPY: {
    label: "Radiothérapie",
    sessionMinutes: 25,
    prescriber: "Dr Anne Chevalier — radiothérapie",
    notes: "PMT série : radiothérapie du lundi au vendredi.",
  },
  CHEMOTHERAPY: {
    label: "Chimiothérapie",
    sessionMinutes: 180,
    prescriber: "Dr Paul Lemaire — oncologie",
    notes: "PMT série : chimiothérapie hebdomadaire en hôpital de jour.",
  },
};

export type PatientSpec = {
  area: AreaKey;
  mobility: Mobility;
  /** Ignored when the patient lies (ambulance prescriptions never share). */
  sharing: SharingScope;
  treatment: Treatment;
  facility: FacilityKey;
  weekdays: number[];
  appointment: string;
  sessionMinutes?: number;
  legs?: RecurrenceLegs;
  active?: boolean;
  /** The series ends on this ISO weekday of next week. */
  endsNextWeekOn?: number;
  accessNotes?: string;
  prescriptionNote?: string;
};

const MWF = [1, 3, 5];
const TTS = [2, 4, 6];
const WEEK = [1, 2, 3, 4, 5];

export const PATIENTS: readonly PatientSpec[] = [
  // Dialysis — Marseille
  { area: "marseille12", mobility: "SEATED", sharing: "BOTH", treatment: "DIALYSIS", facility: "dialysisMarseille", weekdays: MWF, appointment: "07:30" },
  { area: "marseille12", mobility: "SEATED", sharing: "BOTH", treatment: "DIALYSIS", facility: "dialysisMarseille", weekdays: MWF, appointment: "07:30" },
  { area: "marseille12", mobility: "WHEELCHAIR", sharing: "RETURN", treatment: "DIALYSIS", facility: "dialysisMarseille", weekdays: MWF, appointment: "07:30", accessNotes: "Fauteuil roulant pliable, transfert avec aide." },
  { area: "marseille5", mobility: "LYING", sharing: "NONE", treatment: "DIALYSIS", facility: "dialysisMarseille", weekdays: MWF, appointment: "13:00", accessNotes: "Brancard : ascenseur assez large, 2e étage." },
  { area: "marseille4", mobility: "SEATED", sharing: "BOTH", treatment: "DIALYSIS", facility: "dialysisMarseille", weekdays: MWF, appointment: "13:00", active: false, accessNotes: "Hospitalisé : transports suspendus jusqu'à nouvel ordre." },
  { area: "marseille6", mobility: "LYING", sharing: "NONE", treatment: "DIALYSIS", facility: "dialysisMarseille", weekdays: TTS, appointment: "07:30" },
  { area: "marseille10", mobility: "WHEELCHAIR", sharing: "NONE", treatment: "DIALYSIS", facility: "dialysisMarseille", weekdays: TTS, appointment: "07:30", accessNotes: "Rez-de-chaussée sans marche : accompagner de la porte jusqu'au véhicule." },
  { area: "marseille13", mobility: "SEATED", sharing: "BOTH", treatment: "DIALYSIS", facility: "dialysisMarseille", weekdays: TTS, appointment: "13:00" },
  { area: "marseille13", mobility: "SEATED", sharing: "BOTH", treatment: "DIALYSIS", facility: "dialysisMarseille", weekdays: TTS, appointment: "13:00" },
  // Dialysis — Aix-en-Provence
  { area: "aixNord", mobility: "SEATED", sharing: "BOTH", treatment: "DIALYSIS", facility: "dialysisAix", weekdays: MWF, appointment: "13:00" },
  { area: "aixNord", mobility: "SEATED", sharing: "BOTH", treatment: "DIALYSIS", facility: "dialysisAix", weekdays: MWF, appointment: "13:00" },
  { area: "aixSud", mobility: "LYING", sharing: "NONE", treatment: "DIALYSIS", facility: "dialysisAix", weekdays: TTS, appointment: "13:00" },
  { area: "pertuis", mobility: "WHEELCHAIR", sharing: "BOTH", treatment: "DIALYSIS", facility: "dialysisAix", weekdays: TTS, appointment: "07:30" },
  // Dialysis — Manosque
  { area: "forcalquier", mobility: "SEATED", sharing: "BOTH", treatment: "DIALYSIS", facility: "dialysisManosque", weekdays: MWF, appointment: "07:30" },
  { area: "manosqueNord", mobility: "SEATED", sharing: "BOTH", treatment: "DIALYSIS", facility: "dialysisManosque", weekdays: MWF, appointment: "07:30" },
  { area: "manosque", mobility: "SEATED", sharing: "BOTH", treatment: "DIALYSIS", facility: "dialysisManosque", weekdays: TTS, appointment: "13:00" },
  { area: "manosque", mobility: "SEATED", sharing: "OUTBOUND", treatment: "DIALYSIS", facility: "dialysisManosque", weekdays: TTS, appointment: "13:00" },
  // Dialysis — Gap
  { area: "gap", mobility: "LYING", sharing: "NONE", treatment: "DIALYSIS", facility: "dialysisGap", weekdays: MWF, appointment: "07:30" },
  { area: "gapSud", mobility: "SEATED", sharing: "BOTH", treatment: "DIALYSIS", facility: "dialysisGap", weekdays: MWF, appointment: "07:30" },
  { area: "gapSud", mobility: "SEATED", sharing: "BOTH", treatment: "DIALYSIS", facility: "dialysisGap", weekdays: MWF, appointment: "07:30" },
  // Two Sisteron neighbours: a real shared ride to Gap (Laragne is too far off the road for the detour cap).
  { area: "sisteron", mobility: "SEATED", sharing: "BOTH", treatment: "DIALYSIS", facility: "dialysisGap", weekdays: TTS, appointment: "07:30" },
  { area: "sisteron", mobility: "SEATED", sharing: "BOTH", treatment: "DIALYSIS", facility: "dialysisGap", weekdays: TTS, appointment: "07:30" },
  { area: "veynes", mobility: "SEATED", sharing: "NONE", treatment: "DIALYSIS", facility: "dialysisGap", weekdays: MWF, appointment: "13:00" },

  // Radiotherapy — Marseille (Monday to Friday)
  { area: "marseille13", mobility: "SEATED", sharing: "BOTH", treatment: "RADIOTHERAPY", facility: "radiotherapyMarseille", weekdays: WEEK, appointment: "09:00", sessionMinutes: 20 },
  { area: "marseille13", mobility: "SEATED", sharing: "BOTH", treatment: "RADIOTHERAPY", facility: "radiotherapyMarseille", weekdays: WEEK, appointment: "09:00", sessionMinutes: 20 },
  { area: "marseille4", mobility: "LYING", sharing: "NONE", treatment: "RADIOTHERAPY", facility: "radiotherapyMarseille", weekdays: WEEK, appointment: "10:00", sessionMinutes: 30 },
  { area: "marseille5", mobility: "SEATED", sharing: "RETURN", treatment: "RADIOTHERAPY", facility: "radiotherapyMarseille", weekdays: WEEK, appointment: "08:30", sessionMinutes: 25 },
  { area: "marseille6", mobility: "WHEELCHAIR", sharing: "NONE", treatment: "RADIOTHERAPY", facility: "radiotherapyMarseille", weekdays: WEEK, appointment: "13:30", sessionMinutes: 30 },
  { area: "marseille10", mobility: "SEATED", sharing: "BOTH", treatment: "RADIOTHERAPY", facility: "radiotherapyMarseille", weekdays: WEEK, appointment: "15:00", sessionMinutes: 20 },
  { area: "marseille10", mobility: "SEATED", sharing: "OUTBOUND", treatment: "RADIOTHERAPY", facility: "radiotherapyMarseille", weekdays: WEEK, appointment: "15:00", sessionMinutes: 20 },
  { area: "marseille5", mobility: "SEATED", sharing: "BOTH", treatment: "RADIOTHERAPY", facility: "radiotherapyMarseille", weekdays: WEEK, appointment: "08:00", sessionMinutes: 25, endsNextWeekOn: 3, prescriptionNote: "Dernière séance de la série mercredi prochain." },
  { area: "aixNord", mobility: "SEATED", sharing: "BOTH", treatment: "RADIOTHERAPY", facility: "radiotherapyMarseille", weekdays: WEEK, appointment: "10:30", sessionMinutes: 25 },
  { area: "aixNord", mobility: "SEATED", sharing: "BOTH", treatment: "RADIOTHERAPY", facility: "radiotherapyMarseille", weekdays: WEEK, appointment: "10:30", sessionMinutes: 25 },
  { area: "manosque", mobility: "SEATED", sharing: "BOTH", treatment: "RADIOTHERAPY", facility: "radiotherapyMarseille", weekdays: WEEK, appointment: "11:00", sessionMinutes: 20 },
  { area: "manosqueNord", mobility: "SEATED", sharing: "BOTH", treatment: "RADIOTHERAPY", facility: "radiotherapyMarseille", weekdays: WEEK, appointment: "11:00", sessionMinutes: 20 },
  { area: "gardanne", mobility: "SEATED", sharing: "BOTH", treatment: "RADIOTHERAPY", facility: "radiotherapyMarseille", weekdays: WEEK, appointment: "16:00", sessionMinutes: 30 },
  // Radiotherapy — Grenoble (long distance from the Alps of Haute-Provence)
  { area: "sisteron", mobility: "SEATED", sharing: "BOTH", treatment: "RADIOTHERAPY", facility: "radiotherapyGrenoble", weekdays: WEEK, appointment: "10:30", sessionMinutes: 25 },
  { area: "laragne", mobility: "SEATED", sharing: "BOTH", treatment: "RADIOTHERAPY", facility: "radiotherapyGrenoble", weekdays: WEEK, appointment: "10:30", sessionMinutes: 25 },
  { area: "gap", mobility: "SEATED", sharing: "BOTH", treatment: "RADIOTHERAPY", facility: "radiotherapyGrenoble", weekdays: WEEK, appointment: "15:00", sessionMinutes: 30 },
  { area: "gap", mobility: "SEATED", sharing: "BOTH", treatment: "RADIOTHERAPY", facility: "radiotherapyGrenoble", weekdays: WEEK, appointment: "15:00", sessionMinutes: 30 },

  // Chemotherapy (once a week)
  { area: "pertuis", mobility: "SEATED", sharing: "BOTH", treatment: "CHEMOTHERAPY", facility: "chemotherapyAix", weekdays: [2], appointment: "09:00" },
  { area: "pertuis", mobility: "SEATED", sharing: "BOTH", treatment: "CHEMOTHERAPY", facility: "chemotherapyAix", weekdays: [2], appointment: "09:00" },
  { area: "gardanne", mobility: "SEATED", sharing: "OUTBOUND", treatment: "CHEMOTHERAPY", facility: "chemotherapyAix", weekdays: [1], appointment: "08:30", legs: "OUTBOUND", prescriptionNote: "Retour assuré par la famille." },
  { area: "aixSud", mobility: "WHEELCHAIR", sharing: "BOTH", treatment: "CHEMOTHERAPY", facility: "chemotherapyAix", weekdays: [4], appointment: "13:30" },
  { area: "sisteron", mobility: "LYING", sharing: "NONE", treatment: "CHEMOTHERAPY", facility: "hospitalGap", weekdays: [3], appointment: "09:00" },
  { area: "gapSud", mobility: "LYING", sharing: "NONE", treatment: "CHEMOTHERAPY", facility: "hospitalGap", weekdays: [2], appointment: "10:00" },
  { area: "gap", mobility: "SEATED", sharing: "BOTH", treatment: "CHEMOTHERAPY", facility: "hospitalMarseille", weekdays: [1], appointment: "11:00", prescriptionNote: "Suivi à l'hôpital universitaire de Marseille : trajet long depuis Gap." },
];

// ---------------------------------------------------------------------------
// Private clients of tomorrow (counted in tomorrow's one-off episodes, seed/one-off.ts).

export type PrivateClientSpec = {
  area: AreaKey;
  direction: "OUTBOUND" | "RETURN";
  place: { address: string; lat: number; lng: number };
  /** OUTBOUND: arrival time; RETURN: pickup time. */
  time: string;
  notes: string;
};

export const PRIVATE_CLIENTS: readonly PrivateClientSpec[] = [
  {
    area: "aixNord",
    direction: "OUTBOUND",
    place: { address: "Gare d'Aix-en-Provence TGV, 13290 Aix-en-Provence", lat: 43.4553, lng: 5.3173 },
    time: "09:40",
    notes: "Client privé — train de 10 h 05, une valise.",
  },
  {
    area: "marseille6",
    direction: "RETURN",
    place: { address: "Aéroport Marseille Provence, 13700 Marignane", lat: 43.4393, lng: 5.2214 },
    time: "15:30",
    notes: "Client privé — retour de vol, attente en zone arrivées.",
  },
];

// ---------------------------------------------------------------------------
// Occasional patients (one-off trips, seed/one-off.ts).

/**
 * Where the occasional patients live (relative weights). The series already
 * keep the Marseille vehicles busy (dialysis, radiotherapy); the one-off care
 * follows the depots of the fleet, so that each vehicle finds work near its
 * depot: about a quarter around Marseille, little around Aix (no depot),
 * the rest around Manosque, Sisteron and Gap, villages included.
 */
export const OCCASIONAL_AREAS: readonly (readonly [AreaKey, number])[] = [
  ["marseille5", 3],
  ["marseille10", 3],
  ["marseille12", 4],
  ["marseille13", 3],
  ["allauch", 4],
  ["aubagne", 4],
  ["pennes", 3],
  ["aixSud", 2],
  ["venelles", 1],
  ["gardanne", 2],
  ["pertuis", 1],
  ["manosque", 6],
  ["manosqueNord", 4],
  ["oraison", 5],
  ["vinon", 3],
  ["forcalquier", 4],
  ["sisteron", 8],
  ["chateauArnoux", 7],
  ["laragne", 5],
  ["gap", 8],
  ["gapSud", 6],
  ["tallard", 5],
  ["chorges", 4],
  ["veynes", 5],
];

/**
 * Size of the pool of occasional patients and one-off episodes per weekday
 * (small seed; at J+1 the two PRIVATE_CLIENTS count in it). Five episodes
 * (about 8 trips) is what the 10 vehicles take on top of the series: with 8
 * (about 13 trips, plus 4 written by hand), J+1 had 12 trips without a
 * vehicle, 8 of them legs of the series; with 5, 3 (the series alone leave
 * 2). Measured in the journal, lot 8.
 */
export const OCCASIONAL_POOL_SIZE = 120;
export const ONE_OFF_EPISODES_PER_WEEKDAY = 5;

/** Pool of occasional patients the large fleet (--fleet) adds, and its one-off episodes per weekday. */
export const FLEET_OCCASIONAL_POOL_SIZE = 600;
export const FLEET_ONE_OFF_EPISODES_PER_WEEKDAY = 45;
