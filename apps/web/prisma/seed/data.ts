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
} as const satisfies Record<string, AreaDef>;

export type AreaKey = keyof typeof AREA_DEFS;

export type Area = { key: AreaKey; city: string; postalCode: string; centre: LatLng; spreadKm: number };

export function area(key: AreaKey): Area {
  const def: AreaDef = AREA_DEFS[key];
  const town = TOWNS[def.town];
  return {
    key,
    city: town.name,
    postalCode: def.postalCode,
    centre: offset(town, def.bearing, def.distanceKm),
    spreadKm: def.spreadKm,
  };
}

// ---------------------------------------------------------------------------
// Facilities (all invented, located around real town centres).

type FacilityDef = {
  name: string;
  type: FacilityType;
  town: TownKey;
  bearing: number;
  distanceKm: number;
  address: string;
  postalCode: string;
  notes: string | null;
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

export type FacilityKey = keyof typeof FACILITIES;

export function facilityLocation(def: FacilityDef): LatLng {
  return offset(TOWNS[def.town], def.bearing, def.distanceKm);
}

// ---------------------------------------------------------------------------
// Depots, drivers and vehicles.

type DepotDef = {
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
  hourlyCost: number;
};

const MON_FRI = [1, 2, 3, 4, 5];
const MON_SAT = [1, 2, 3, 4, 5, 6];
const TUE_SAT = [2, 3, 4, 5, 6];

/** Every driver takes a break in the 11:30 – 14:00 window. */
export const BREAK_WINDOW = ["11:30", "14:00"] as const;

export const DRIVERS = {
  julien: { firstName: "Julien", lastName: "Marchetti", qualifications: ["TAXI_CARD"], workDays: MON_SAT, shift: ["06:00", "18:30"], breakMinutes: 45, hourlyCost: 24 },
  elodie: { firstName: "Élodie", lastName: "Fabre", qualifications: ["AUXILIARY"], workDays: MON_SAT, shift: ["06:30", "19:00"], breakMinutes: 30, hourlyCost: 25.5 },
  laurent: { firstName: "Laurent", lastName: "Giraud", qualifications: ["DEA", "AUXILIARY"], workDays: MON_SAT, shift: ["06:00", "19:00"], breakMinutes: 45, hourlyCost: 29 },
  ines: { firstName: "Inès", lastName: "Moulin", qualifications: ["AUXILIARY"], workDays: MON_SAT, shift: ["06:00", "19:00"], breakMinutes: 45, hourlyCost: 23.5 },
  sophie: { firstName: "Sophie", lastName: "Rinaldi", qualifications: ["TAXI_CARD"], workDays: MON_FRI, shift: ["06:00", "18:30"], breakMinutes: 30, hourlyCost: 24 },
  mathieu: { firstName: "Mathieu", lastName: "Roux", qualifications: ["AUXILIARY", "TAXI_CARD"], workDays: MON_SAT, shift: ["06:00", "19:00"], breakMinutes: 45, hourlyCost: 25 },
  thomas: { firstName: "Thomas", lastName: "Garnier", qualifications: ["TAXI_CARD"], workDays: MON_FRI, shift: ["06:00", "19:00"], breakMinutes: 30, hourlyCost: 23 },
  celine: { firstName: "Céline", lastName: "Arnaud", qualifications: ["AUXILIARY"], workDays: MON_SAT, shift: ["06:00", "18:30"], breakMinutes: 30, hourlyCost: 24.5 },
  nadia: { firstName: "Nadia", lastName: "Belkacem", qualifications: ["TAXI_CARD"], workDays: MON_FRI, shift: ["06:30", "19:00"], breakMinutes: 45, hourlyCost: 23 },
  // Works Saturdays so the Gap fleet is staffed for the Tue/Thu/Sat dialysis patients (with Céline in Sisteron).
  romain: { firstName: "Romain", lastName: "Chabert", qualifications: ["DEA"], workDays: MON_SAT, shift: ["06:00", "19:00"], breakMinutes: 30, hourlyCost: 27 },
  franck: { firstName: "Franck", lastName: "Bonnet", qualifications: ["DEA"], workDays: MON_FRI, shift: ["06:00", "19:00"], breakMinutes: 45, hourlyCost: 28.5 },
  amandine: { firstName: "Amandine", lastName: "Reynaud", qualifications: ["DEA", "AUXILIARY"], workDays: MON_FRI, shift: ["06:00", "19:00"], breakMinutes: 45, hourlyCost: 27.5 },
  // Replacement drivers: default driver of no vehicle, so the optimizer only uses them once the
  // regulator names them on a vehicle (Véhicules page).
  kevin: { firstName: "Kévin", lastName: "Lambert", qualifications: ["TAXI_CARD", "AUXILIARY"], workDays: TUE_SAT, shift: ["07:00", "19:00"], breakMinutes: 30, hourlyCost: 22 },
  sabrina: { firstName: "Sabrina", lastName: "Morel", qualifications: ["DEA", "AUXILIARY"], workDays: MON_FRI, shift: ["06:00", "17:00"], breakMinutes: 30, hourlyCost: 26 },
} as const satisfies Record<string, DriverDef>;

export type DriverKey = keyof typeof DRIVERS;

/** Depot of the replacement drivers (the others belong to the depot of the vehicle they crew). */
export const REPLACEMENT_DRIVER_DEPOTS: Partial<Record<DriverKey, DepotKey>> = { kevin: "marseille", sabrina: "gap" };

type VehicleDef = {
  label: string;
  registration: string;
  type: VehicleType;
  depot: DepotKey;
  costPerKm: number;
  driver: DriverKey;
  crewMate: DriverKey | null;
  /** Diesel unless stated. */
  energy?: EnergyType;
};

export const VEHICLES: readonly VehicleDef[] = [
  { label: "Taxi 1 (Marseille)", registration: "GH-218-PZ", type: "TAXI", depot: "marseille", costPerKm: 0.31, driver: "julien", crewMate: null },
  { label: "VSL 1 (Marseille)", registration: "FK-547-TR", type: "VSL", depot: "marseille", costPerKm: 0.34, driver: "elodie", crewMate: null },
  { label: "Ambulance 1 (Marseille)", registration: "GA-903-MB", type: "AMBULANCE", depot: "marseille", costPerKm: 0.44, driver: "laurent", crewMate: "ines" },
  { label: "Taxi 2 (Manosque)", registration: "FV-162-LD", type: "TAXI", depot: "manosque", costPerKm: 0.3, driver: "sophie", crewMate: null, energy: "ELECTRIC" },
  { label: "VSL 2 (Manosque)", registration: "GC-775-HN", type: "VSL", depot: "manosque", costPerKm: 0.33, driver: "mathieu", crewMate: null },
  { label: "Taxi 3 (Sisteron)", registration: "FS-384-KE", type: "TAXI", depot: "sisteron", costPerKm: 0.29, driver: "thomas", crewMate: null },
  { label: "VSL 3 (Sisteron)", registration: "GE-629-JW", type: "VSL", depot: "sisteron", costPerKm: 0.35, driver: "celine", crewMate: null },
  { label: "Taxi 4 (Gap)", registration: "FP-451-RC", type: "TAXI", depot: "gap", costPerKm: 0.32, driver: "nadia", crewMate: null },
  { label: "VSL 4 (Gap)", registration: "GD-806-XA", type: "VSL", depot: "gap", costPerKm: 0.36, driver: "romain", crewMate: null },
  { label: "Ambulance 2 (Gap)", registration: "FZ-270-BV", type: "AMBULANCE", depot: "gap", costPerKm: 0.45, driver: "franck", crewMate: "amandine" },
];

// ---------------------------------------------------------------------------
// Tariff grids. Amounts are indicative only; they live in the database so the
// regulator can correct them without touching code.

export const TARIFF_NOTE = "Valeurs indicatives à vérifier avec la convention en vigueur.";

type TariffDef = {
  vehicleType: VehicleType;
  department: string;
  label: string;
  baseFare: number;
  pricePerKm: number;
  includedKm: number;
  sharedDiscount2: number;
  sharedDiscount3: number;
  validFrom: string;
  validTo: string | null;
  notes: string;
};

const TAP_DISCOUNTS = { sharedDiscount2: 0.23, sharedDiscount3: 0.35 };
const CURRENT = { validFrom: "2025-01-01", validTo: null, notes: TARIFF_NOTE };

export const TARIFFS: readonly TariffDef[] = [
  { vehicleType: "TAXI", department: "13", label: "Taxi conventionné — Bouches-du-Rhône", baseFare: 13, pricePerKm: 1.12, includedKm: 0, ...TAP_DISCOUNTS, ...CURRENT },
  { vehicleType: "TAXI", department: "04", label: "Taxi conventionné — Alpes-de-Haute-Provence", baseFare: 13, pricePerKm: 1.17, includedKm: 0, ...TAP_DISCOUNTS, ...CURRENT },
  { vehicleType: "TAXI", department: "05", label: "Taxi conventionné — Hautes-Alpes", baseFare: 13, pricePerKm: 1.2, includedKm: 0, ...TAP_DISCOUNTS, ...CURRENT },
  { vehicleType: "TAXI", department: "38", label: "Taxi conventionné — Isère", baseFare: 13, pricePerKm: 1.07, includedKm: 0, ...TAP_DISCOUNTS, ...CURRENT },
  { vehicleType: "VSL", department: "*", label: "VSL — toutes zones", baseFare: 13.6, pricePerKm: 1.0, includedKm: 0, ...TAP_DISCOUNTS, ...CURRENT },
  { vehicleType: "AMBULANCE", department: "*", label: "Ambulance — toutes zones", baseFare: 64.5, pricePerKm: 2.4, includedKm: 3, sharedDiscount2: 0, sharedDiscount3: 0, ...CURRENT },
  {
    vehicleType: "TAXI",
    department: "13",
    label: "Taxi conventionné — Bouches-du-Rhône (ancienne grille)",
    baseFare: 12.5,
    pricePerKm: 1.05,
    includedKm: 0,
    ...TAP_DISCOUNTS,
    validFrom: "2023-01-01",
    validTo: "2024-12-31",
    notes: `${TARIFF_NOTE} Grille expirée, conservée pour l'historique.`,
  },
];

// ---------------------------------------------------------------------------
// Patients: one regular treatment each. Cohorts are tuned so a weekday yields
// about 55-65 trips and several pairs share a facility, an appointment time,
// a neighbourhood and a prescription that allows sharing.

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
// One-off trips for tomorrow.

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

/** A CPAM patient with a one-off consultation tomorrow (both legs, no recurrence). */
export const ONE_OFF_CONSULTATION: {
  area: AreaKey;
  facility: FacilityKey;
  appointment: string;
  ready: string;
  prescriber: string;
  notes: string;
} = {
  area: "aixSud",
  facility: "hospitalMarseille",
  appointment: "14:30",
  ready: "16:00",
  prescriber: "Dr Hugo Ferrier — cardiologie",
  notes: "Consultation de cardiologie (ponctuelle).",
};
