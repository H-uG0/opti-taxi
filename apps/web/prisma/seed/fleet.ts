/**
 * The large fleet of `pnpm db:seed --fleet` (pure, unit-tested): what is added
 * to the small data set to reach the size V announced (6 depots, 120 vehicles,
 * about 150 people, about 300 one-way trips a working day), in the proportions
 * of the optimizer's load test (services/optimizer/tests/builders.py,
 * fleet_day): 30 / 15 / 10 / 15 / 15 / 15 % of the vehicles and patients at
 * Marseille, Aix, Manosque, Sisteron, Gap and Grenoble; 50 % taxis, 35 % VSL,
 * 15 % ambulances; staggered shifts; about 12 % of lying patients; four
 * prescriptions in five allow sharing; many patients treated outside their
 * town. These shares are assumptions, not V's figures.
 *
 * Everything is drawn from the generators it is given: the small data set
 * (its own generators) is never changed by --fleet.
 */
import type { EnergyType, Mobility, Qualification, SharingScope, VehicleType } from "@prisma/client";
import { FACILITIES, ONE_OFF_FACILITIES, type AnyFacilityKey, type AreaKey, type FleetDepotKey, type TownKey, type Treatment } from "./data";
import type { NameFactory } from "./identity";
import type { HubTown } from "./one-off";
import type { Rng } from "./random";

// ---------------------------------------------------------------------------
// Vehicles and people

/** Vehicles of each depot by type, in total (the small data set's included): 120 = 60 taxis, 42 VSL, 18 ambulances. */
export const FLEET_VEHICLE_MIX: Record<FleetDepotKey, Record<VehicleType, number>> = {
  marseille: { TAXI: 18, VSL: 13, AMBULANCE: 5 },
  aix: { TAXI: 9, VSL: 6, AMBULANCE: 3 },
  manosque: { TAXI: 6, VSL: 4, AMBULANCE: 2 },
  sisteron: { TAXI: 9, VSL: 7, AMBULANCE: 2 },
  gap: { TAXI: 9, VSL: 6, AMBULANCE: 3 },
  grenoble: { TAXI: 9, VSL: 6, AMBULANCE: 3 },
};

/** Replacement staff of each depot in total (default driver of no vehicle): one taxi/auxiliary, one DEA/auxiliary. */
export const FLEET_REPLACEMENTS: readonly (readonly Qualification[])[] = [
  ["TAXI_CARD", "AUXILIARY"],
  ["DEA", "AUXILIARY"],
];

/** Staggered shifts (minutes since midnight), as in fleet_day: early, day, late, short. */
export const FLEET_SHIFTS: readonly (readonly [number, number])[] = [
  [360, 1140],
  [420, 1080],
  [360, 960],
  [480, 1200],
  [330, 930],
  [450, 1110],
];

const MON_FRI = [1, 2, 3, 4, 5];
const MON_SAT = [1, 2, 3, 4, 5, 6];
const TUE_SAT = [2, 3, 4, 5, 6];

/** Share of the electric taxis in the towns with charging points at the depot. */
const ELECTRIC_TAXI_SHARE: Partial<Record<FleetDepotKey, number>> = { marseille: 0.2, aix: 0.2, grenoble: 0.25 };

export type FleetPersonSpec = {
  firstName: string;
  lastName: string;
  qualifications: Qualification[];
  workDays: number[];
  shift: readonly [number, number];
  breakMinutes: number;
  seniorityYears: number;
  depot: FleetDepotKey;
};

export type FleetVehicleSpec = {
  label: string;
  registration: string;
  type: VehicleType;
  depot: FleetDepotKey;
  energy: EnergyType;
  ageSurcharge: number;
  /** Index of the default driver in `people`. */
  driver: number;
  /** Index of the default crew mate (ambulance), or null. */
  crewMate: number | null;
};

export type FleetPlan = { people: FleetPersonSpec[]; vehicles: FleetVehicleSpec[] };

const TYPE_LABEL: Record<VehicleType, string> = { TAXI: "Taxi", VSL: "VSL", AMBULANCE: "Ambulance" };
/** French registration letters (SIV): no I, O or U. */
const PLATE_LETTERS = "ABCDEFGHJKLMNPQRSTVWXYZ";

/** A unique fictitious registration "AB-123-CD", not in `taken` (which it fills). */
export function drawRegistration(rng: Rng, taken: Set<string>): string {
  for (;;) {
    const letter = () => PLATE_LETTERS[rng.int(0, PLATE_LETTERS.length - 1)];
    const plate = `${letter()}${letter()}-${String(rng.int(100, 999))}-${letter()}${letter()}`;
    if (!taken.has(plate)) {
      taken.add(plate);
      return plate;
    }
  }
}

function drawWorkDays(rng: Rng): number[] {
  const draw = rng.next();
  return draw < 0.55 ? MON_FRI : draw < 0.85 ? MON_SAT : TUE_SAT;
}

/**
 * The vehicles and people to add. `existing` lists the vehicles of the small
 * data set (by depot and type: they count in FLEET_VEHICLE_MIX) and the
 * replacements it already has per depot; `depotLabels` names the depots in
 * the vehicle labels; numbering goes on after `nextNumber` of each type.
 */
export function planFleet(
  rng: Rng,
  names: NameFactory,
  existing: {
    vehicles: readonly { type: VehicleType; depot: FleetDepotKey }[];
    replacements: Partial<Record<FleetDepotKey, number>>;
    registrations: readonly string[];
  },
  depotLabels: Record<FleetDepotKey, string>,
  nextNumber: Record<VehicleType, number>,
): FleetPlan {
  const people: FleetPersonSpec[] = [];
  const vehicles: FleetVehicleSpec[] = [];
  const plates = new Set(existing.registrations);
  const number = { ...nextNumber };
  let shiftIndex = 0;

  const person = (depot: FleetDepotKey, qualifications: Qualification[], shift: readonly [number, number], workDays: number[]) => {
    people.push({
      ...names.next(),
      qualifications,
      workDays,
      shift,
      breakMinutes: rng.chance(0.3) ? 30 : 45,
      seniorityYears: rng.int(0, 5),
      depot,
    });
    return people.length - 1;
  };

  for (const depot of Object.keys(FLEET_VEHICLE_MIX) as FleetDepotKey[]) {
    for (const type of ["TAXI", "VSL", "AMBULANCE"] as const) {
      const already = existing.vehicles.filter((v) => v.depot === depot && v.type === type).length;
      for (let i = already; i < FLEET_VEHICLE_MIX[depot][type]; i++) {
        const shift = FLEET_SHIFTS[shiftIndex++ % FLEET_SHIFTS.length] ?? [360, 1140];
        const workDays = drawWorkDays(rng);
        let driver: number;
        let crewMate: number | null = null;
        if (type === "TAXI") {
          driver = person(depot, ["TAXI_CARD"], shift, workDays);
        } else if (type === "VSL") {
          driver = person(depot, rng.chance(0.25) ? ["AUXILIARY", "TAXI_CARD"] : ["AUXILIARY"], shift, workDays);
        } else {
          // The usual crew: the auxiliary drives, the DE rides beside the patient; same shift and days.
          driver = person(depot, ["AUXILIARY"], shift, workDays);
          crewMate = person(depot, rng.chance(0.3) ? ["DEA", "AUXILIARY"] : ["DEA"], shift, workDays);
        }
        const electric = type === "TAXI" && rng.chance(ELECTRIC_TAXI_SHARE[depot] ?? 0);
        vehicles.push({
          label: `${TYPE_LABEL[type]} ${number[type]++} (${depotLabels[depot]})`,
          registration: drawRegistration(rng, plates),
          type,
          depot,
          energy: electric ? "ELECTRIC" : "DIESEL",
          ageSurcharge: rng.int(0, 3) / 100,
          driver,
          crewMate,
        });
      }
    }
    for (const qualifications of FLEET_REPLACEMENTS.slice(existing.replacements[depot] ?? 0)) {
      person(depot, [...qualifications], [360, 1140], rng.chance(0.5) ? MON_FRI : TUE_SAT);
    }
  }
  return { people, vehicles };
}

// ---------------------------------------------------------------------------
// Patients of the series

/** Where the patients of the series live (relative weights): 30 / 15 / 10 / 15 / 15 / 15 % by town, as fleet_day. */
export const FLEET_PATIENT_AREAS: readonly (readonly [AreaKey, number])[] = [
  ["marseille4", 4],
  ["marseille5", 4],
  ["marseille6", 4],
  ["marseille10", 4],
  ["marseille12", 4],
  ["marseille13", 4],
  ["allauch", 2],
  ["aubagne", 2],
  ["pennes", 2],
  ["aixNord", 4],
  ["aixSud", 4],
  ["venelles", 2],
  ["bouc", 2],
  ["gardanne", 2],
  ["pertuis", 1],
  ["manosque", 4],
  ["manosqueNord", 2],
  ["oraison", 2],
  ["vinon", 1],
  ["forcalquier", 1],
  ["sisteron", 6],
  ["chateauArnoux", 5],
  ["laragne", 4],
  ["gap", 6],
  ["gapSud", 4],
  ["tallard", 2],
  ["chorges", 1],
  ["veynes", 2],
  ["grenoble", 5],
  ["grenobleSud", 4],
  ["meylan", 2],
  ["echirolles", 3],
  ["vizille", 1],
];

/** Where each treatment is given, by home town: radiotherapy only in Marseille and Grenoble, hence long trips. */
const TREATMENT_FACILITIES: Record<Treatment, Record<HubTown, readonly AnyFacilityKey[]>> = {
  DIALYSIS: {
    marseille: ["dialysisMarseille"],
    aix: ["dialysisAix"],
    gardanne: ["dialysisAix", "dialysisMarseille"],
    pertuis: ["dialysisAix"],
    manosque: ["dialysisManosque"],
    forcalquier: ["dialysisManosque"],
    sisteron: ["dialysisGap", "dialysisManosque"],
    laragne: ["dialysisGap"],
    gap: ["dialysisGap"],
    veynes: ["dialysisGap"],
    grenoble: ["dialysisGrenoble"],
  },
  RADIOTHERAPY: {
    marseille: ["radiotherapyMarseille"],
    aix: ["radiotherapyMarseille"],
    gardanne: ["radiotherapyMarseille"],
    pertuis: ["radiotherapyMarseille"],
    manosque: ["radiotherapyMarseille"],
    forcalquier: ["radiotherapyMarseille"],
    sisteron: ["radiotherapyGrenoble", "radiotherapyMarseille"],
    laragne: ["radiotherapyGrenoble"],
    gap: ["radiotherapyGrenoble"],
    veynes: ["radiotherapyGrenoble"],
    grenoble: ["radiotherapyGrenoble"],
  },
  CHEMOTHERAPY: {
    marseille: ["hospitalMarseille"],
    aix: ["chemotherapyAix"],
    gardanne: ["chemotherapyAix"],
    pertuis: ["chemotherapyAix"],
    manosque: ["chemotherapyAix", "hospitalManosque"],
    forcalquier: ["hospitalManosque"],
    sisteron: ["hospitalGap"],
    laragne: ["hospitalGap"],
    gap: ["hospitalGap"],
    veynes: ["hospitalGap"],
    grenoble: ["hospitalGrenoble"],
  },
};

export type FleetPatientSpec = {
  area: AreaKey;
  mobility: Mobility;
  sharing: SharingScope;
  treatment: Treatment;
  facility: AnyFacilityKey;
  weekdays: number[];
  /** Appointment, minutes since midnight. */
  appointment: number;
  sessionMinutes: number;
};

function weightedPick<T>(rng: Rng, items: readonly (readonly [T, number])[]): T {
  const total = items.reduce((sum, [, weight]) => sum + weight, 0);
  let draw = rng.float(0, total);
  for (const [item, weight] of items) {
    draw -= weight;
    if (draw < 0) return item;
  }
  const last = items[items.length - 1];
  if (!last) throw new Error("weightedPick() called on an empty list");
  return last[0];
}

const quarter = (rng: Rng, from: number, to: number) => rng.int(from / 15, to / 15) * 15;

/** Town of a facility of the seed. */
export function facilityTown(key: AnyFacilityKey): TownKey {
  return key in FACILITIES ? FACILITIES[key as keyof typeof FACILITIES].town : ONE_OFF_FACILITIES[key as keyof typeof ONE_OFF_FACILITIES].town;
}

/**
 * Patients of the series: dialysis three times a week (the centres run a
 * morning and an early afternoon shift), radiotherapy every weekday, weekly
 * chemotherapy. `hubOf` gives the town whose facilities a home area uses.
 */
export function planFleetPatients(
  rng: Rng,
  count: number,
  hubOfArea: (area: AreaKey) => HubTown,
): FleetPatientSpec[] {
  const patients: FleetPatientSpec[] = [];
  for (let i = 0; i < count; i++) {
    const area = weightedPick(rng, FLEET_PATIENT_AREAS);
    const treatment = weightedPick<Treatment>(rng, [
      ["DIALYSIS", 0.45],
      ["RADIOTHERAPY", 0.3],
      ["CHEMOTHERAPY", 0.25],
    ]);
    const facility = rng.pick(TREATMENT_FACILITIES[treatment][hubOfArea(area)]);
    const mobility = weightedPick<Mobility>(rng, [
      ["SEATED", 0.82],
      ["WHEELCHAIR", 0.06],
      ["LYING", 0.12],
    ]);
    const sharing = weightedPick<SharingScope>(rng, [
      ["BOTH", 0.7],
      ["NONE", 0.2],
      ["OUTBOUND", 0.05],
      ["RETURN", 0.05],
    ]);
    let weekdays: number[];
    let appointment: number;
    let sessionMinutes: number;
    if (treatment === "DIALYSIS") {
      weekdays = rng.chance(0.5) ? [1, 3, 5] : [2, 4, 6];
      appointment = rng.pick(rng.chance(0.55) ? [420, 450, 480] : [750, 780, 810]);
      sessionMinutes = 240;
    } else if (treatment === "RADIOTHERAPY") {
      weekdays = [1, 2, 3, 4, 5];
      // A centre far from home: between 09:00 and 14:00, so the patient is home in the evening.
      const far = facilityTown(facility) !== hubOfArea(area);
      appointment = far ? quarter(rng, 540, 840) : quarter(rng, 480, 990);
      sessionMinutes = rng.pick([20, 25, 30]);
    } else {
      weekdays = [rng.int(1, 5)];
      appointment = quarter(rng, 510, 630);
      sessionMinutes = rng.pick([120, 150, 180, 240]);
    }
    patients.push({ area, mobility, sharing, treatment, facility, weekdays, appointment, sessionMinutes });
  }
  return patients;
}

// ---------------------------------------------------------------------------
// Absences, on-call duty and vehicles off the road over the seeded fortnight

export type FleetAbsenceSpec = {
  person: number;
  kind: "LEAVE" | "SICK" | "TRAINING" | "ON_CALL";
  /** Days from the Monday of the seeded fortnight (0 = that Monday). */
  from: number;
  to: number;
  note: string | null;
};

export type FleetUnavailabilitySpec = {
  vehicle: number;
  kind: "MAINTENANCE" | "REPAIR" | "ON_CALL";
  from: number;
  to: number;
  note: string;
};

/** Department of each depot (on-call duty is organised by department). */
const DEPARTMENT_OF: Record<FleetDepotKey, string> = {
  marseille: "13",
  aix: "13",
  manosque: "04",
  sisteron: "04",
  gap: "05",
  grenoble: "38",
};

/**
 * What the regulation of a 150-person company deals with over a fortnight
 * (assumptions): a week of leave for 6 % of the people, one to three days of
 * sick leave for 5 %, a day of training for 3 %; one ambulance of each
 * department on call each Saturday (its crew too), and the Marseille
 * ambulances in turn one weekday a week; a day of servicing for 4 % of the
 * vehicles and a two-day repair for 1 %. Sick leaves carry no note (a note
 * never holds medical information).
 */
export function planFleetAbsences(
  rng: Rng,
  people: readonly Pick<FleetPersonSpec, "depot">[],
  vehicles: readonly Pick<FleetVehicleSpec, "type" | "depot" | "driver" | "crewMate">[],
): { absences: FleetAbsenceSpec[]; unavailabilities: FleetUnavailabilitySpec[] } {
  const absences: FleetAbsenceSpec[] = [];
  const unavailabilities: FleetUnavailabilitySpec[] = [];
  const busy = new Map<number, Set<number>>();
  const free = (person: number, from: number, to: number) => {
    const days = busy.get(person) ?? new Set<number>();
    for (let d = from; d <= to; d++) if (days.has(d)) return false;
    for (let d = from; d <= to; d++) days.add(d);
    busy.set(person, days);
    return true;
  };
  const weekday = () => rng.int(0, 1) * 7 + rng.int(0, 4);

  // On-call duty first: the crews of these ambulances are not on leave that day.
  const ambulances = vehicles.flatMap((v, index) => (v.type === "AMBULANCE" ? [{ ...v, index }] : []));
  const onCall = (vehicle: (typeof ambulances)[number], day: number) => {
    const crew = [vehicle.driver, vehicle.crewMate].filter((p): p is number => p !== null);
    if (!crew.every((p) => free(p, day, day))) return;
    unavailabilities.push({ vehicle: vehicle.index, kind: "ON_CALL", from: day, to: day, note: "Garde départementale 8 h – 20 h." });
    for (const person of crew) absences.push({ person, kind: "ON_CALL", from: day, to: day, note: "Garde départementale 8 h – 20 h." });
  };
  for (const department of [...new Set(Object.values(DEPARTMENT_OF))]) {
    const own = ambulances.filter((a) => DEPARTMENT_OF[a.depot] === department);
    if (own.length === 0) continue;
    for (const saturday of [5, 12]) onCall(rng.pick(own), saturday);
  }
  const marseille = ambulances.filter((a) => a.depot === "marseille");
  if (marseille.length > 0) for (const week of [0, 7]) onCall(rng.pick(marseille), week + rng.int(0, 4));

  for (const [person] of people.entries()) {
    if (rng.chance(0.06)) {
      const week = rng.int(0, 1) * 7;
      if (free(person, week, week + 4)) absences.push({ person, kind: "LEAVE", from: week, to: week + 4, note: "Congés posés." });
    }
    if (rng.chance(0.05)) {
      const from = weekday();
      const to = Math.min(from + rng.int(0, 2), from - (from % 7) + 5);
      if (free(person, from, to)) absences.push({ person, kind: "SICK", from, to, note: null });
    }
    if (rng.chance(0.03)) {
      const day = weekday();
      if (free(person, day, day)) absences.push({ person, kind: "TRAINING", from: day, to: day, note: "Formation continue (AFGSU)." });
    }
  }

  const offRoad = new Set(unavailabilities.map((u) => u.vehicle));
  for (const [index] of vehicles.entries()) {
    if (offRoad.has(index)) continue;
    if (rng.chance(0.04)) {
      const day = weekday();
      unavailabilities.push({ vehicle: index, kind: "MAINTENANCE", from: day, to: day, note: "Révision au garage." });
    } else if (rng.chance(0.01)) {
      const from = weekday();
      unavailabilities.push({ vehicle: index, kind: "REPAIR", from, to: from + 1, note: "Carrosserie : choc arrière." });
    }
  }
  return { absences, unavailabilities };
}
