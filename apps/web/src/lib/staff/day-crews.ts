/**
 * Crews of the day (lot 3 of docs/besoin-et-solution.md): who drives and who
 * crews each vehicle on a given date. Pure module, unit-tested; the planning
 * screens, the crew screen and the optimizer request all read the same result.
 *
 * Per active vehicle, in this order:
 * 1. the crew the regulator fixed for that date (DayCrew row): kept as is,
 *    problems reported (qualification, incompatible pair, a person on two
 *    vehicles, too little shared time on an ambulance); a working day the
 *    person does not usually work is allowed (weekend duty), noted only. A
 *    fixed member who became unavailable since (absent, deactivated) leaves
 *    the seat: the other member is kept and the seat gets a replacement (3.).
 *    A crew fixed with nobody keeps the vehicle at the depot on purpose
 *    (`parked`), unlike a vehicle for which nobody is available;
 * 2. otherwise its default crew, for every member available that day (active,
 *    working that weekday, not absent, not already taken, qualified, sharing
 *    enough working time with the driver on an ambulance);
 * 3. a seat left empty gets a replacement: an available, qualified person
 *    with no seat yet, compatible with the other crew member. Candidates are
 *    ranked by depot (the vehicle's own first, then the nearest, within
 *    CrewRules.maxReplacementKm), then by how much of the holder's usual
 *    shift they cover, then the least versatile first. Seats are served from
 *    the scarcest people to the most common, so a DEA is kept for the
 *    ambulances: the ambulances of the fixed and default crews first (a seat
 *    only a DEA can fill before the others), then the VSL, then the taxis
 *    (within a type, fixed crews that lost a member before default crews);
 *    spare vehicles (no default crew) come last and only take the people left
 *    over beyond the reserve kept per depot (CrewRules.reservePerDepot).
 *    A default member left alone on an ambulance nobody can complete is
 *    offered to the other vehicles (a VSL whose driver is absent) before the
 *    spare vehicles; when none needs them, they stay on the ambulance.
 *    An empty seat says why the free qualified people were not proposed
 *    (too far, kept in reserve).
 * An ambulance crew needs a DEA at the wheel or beside the patient (rules.ts,
 * R. 6312-10) and CrewRules.minPairOverlapMin of shared working time. A crew
 * working more than 6 hours needs the driver's break of at least 20 min to fit
 * in its hours (Code du travail, art. L. 3121-16; lib/staff/work-time.ts): a
 * replacement who would break it is not proposed.
 * A vehicle with a blocking problem (`blocked`) is left out of the planning.
 * A vehicle unavailable that day (maintenance, on-call duty…, lib/fleet)
 * gets nobody, even a crew fixed earlier, and its default crew is free for
 * the other vehicles.
 *
 * The reason of a person's absence (sick leave is health data about an
 * employee) never leaves this module: the crews, their problems and the
 * absent list say « absence » for leave, sick leave and other reasons alike
 * (planningAbsenceText), so none can be told from the others. Duty reasons
 * the regulator needs (on-call duty, training) keep their name. The full
 * reason shows on the person's own sheet alone (absenceText).
 */
import type { AbsenceKind, Qualification, VehicleType } from "@prisma/client";
import { CREW_REQUIRED_ONE_OF, crewHoldsRequired, REQUIRED_QUALIFICATIONS } from "@/lib/domain/rules";
import { unavailabilityOn, unavailabilityText, type DatedVehicleUnavailability } from "@/lib/fleet/availability";
// Same display order as the optimizer request and every list: type, then label in numeric order.
import { compareVehicles, VEHICLE_TYPE_ORDER } from "@/lib/fleet/order";
import { ABSENCE_KIND_LABELS, QUALIFICATION_NOUNS } from "@/lib/labels";
import { formatDuration, formatMinute, formatShortDate, isoWeekday, WEEKDAY_LABELS } from "@/lib/time";
import { workTimeIssue, workTimeSummary, type BreakSettings } from "./work-time";

export type StaffPerson = {
  id: string;
  firstName: string;
  lastName: string;
  active: boolean;
  workDays: number[];
  qualifications: Qualification[];
  depotId: string | null;
  /** Usual working hours, minutes since local midnight. */
  shiftStartMinute: number;
  shiftEndMinute: number;
  /** Break settings (Driver); absent: not checked (lib/staff/work-time.ts). */
  breakWindowStartMinute?: number | null;
  breakWindowEndMinute?: number | null;
  breakMinutes?: number;
};

export type CrewVehicle = {
  id: string;
  label: string;
  type: VehicleType;
  active: boolean;
  depotId: string;
  defaultDriverId: string | null;
  defaultCrewMateId: string | null;
};

/** Where a depot is: replacements from another depot come from the nearest ones. */
export type CrewDepot = { id: string; name: string; lat: number; lng: number };

/** Settings of the automatic crews (AppSettings, Paramètres « Équipages »). */
export type CrewRules = {
  /** A replacement from another depot comes from at most this far (km, straight line between depots). */
  maxReplacementKm: number;
  /** Working time the driver and the crew mate of an ambulance share at least (min). */
  minPairOverlapMin: number;
  /** People of each depot kept without a seat (reserve of the day) before a spare vehicle is staffed. */
  reservePerDepot: number;
};

/** Schema defaults of AppSettings (crewMaxReplacementKm, crewMinPairOverlapMin, crewReservePerDepot). */
export const DEFAULT_CREW_RULES: CrewRules = { maxReplacementKm: 60, minPairOverlapMin: 240, reservePerDepot: 0 };

/** Absence from startDate to endDate included ("YYYY-MM-DD"). */
export type DatedAbsence = { driverId: string; kind: AbsenceKind; startDate: string; endDate: string };
export type Incompatibility = { driverAId: string; driverBId: string };
export type SavedCrew = { vehicleId: string; driverId: string | null; crewMateId: string | null };

export type Seat = "driver" | "crewMate";
export type CrewSource = "saved" | "default" | "replacement" | "none";
export type CrewIssue = {
  level: "error" | "info";
  seat: Seat | null;
  message: string;
  /** Problem of the work-time rule (lib/staff/work-time.ts): `message` says what to do, `summary` sums it up for the lists. */
  workTime?: { summary: string };
};

export type DayCrewView = {
  vehicleId: string;
  driverId: string | null;
  crewMateId: string | null;
  /** Fixed by the regulator, the default crew, a replacement (at least one seat), or nobody available. */
  source: CrewSource;
  /** Seats filled with a replacement the tool proposes, on a fixed crew too (its member became unavailable). */
  proposedSeats: Seat[];
  /** Fixed with nobody: the regulator keeps the vehicle at the depot that day (not « nobody available »). */
  parked: boolean;
  /** Working hours of the crew: the driver's, within the crew mate's on an ambulance. Null without a driver. */
  shift: { start: number; end: number } | null;
  issues: CrewIssue[];
  /** First blocking problem: the vehicle cannot work that day. Null when it can. */
  blocked: string | null;
  /** The vehicle itself is unavailable that day (maintenance, on-call duty…): no crew to choose. */
  unavailable: boolean;
};

export type DayCrewPlan = {
  date: string;
  /** Active vehicles, in display order. */
  crews: DayCrewView[];
  /** People absent that day, with what the planning may say (planningAbsenceText): never a private reason. */
  absent: { driverId: string; startDate: string; endDate: string; text: string }[];
  /** Active people working that weekday, not absent, with no seat. */
  idle: string[];
};

export type DayCrewInput = {
  date: string;
  vehicles: readonly CrewVehicle[];
  people: readonly StaffPerson[];
  absences: readonly DatedAbsence[];
  incompatibilities: readonly Incompatibility[];
  saved: readonly SavedCrew[];
  /** Vehicle unavailability (absent: none). */
  vehicleUnavailabilities?: readonly DatedVehicleUnavailability[];
  /** Depots and their position (absent: distances unknown, any other depot is allowed). */
  depots?: readonly CrewDepot[];
  /** Absent: DEFAULT_CREW_RULES. */
  rules?: CrewRules;
};

const TYPES = Object.keys(VEHICLE_TYPE_ORDER) as VehicleType[];
/** Replacements are served from the scarcest people to the most common: ambulance, VSL, taxi. */
const SCARCITY_ORDER: Record<VehicleType, number> = { AMBULANCE: 0, VSL: 1, TAXI: 2 };

function comparePeople(a: StaffPerson, b: StaffPerson): number {
  return a.lastName.localeCompare(b.lastName, "fr") || a.firstName.localeCompare(b.firstName, "fr") || a.id.localeCompare(b.id);
}

export function staffName(person: Pick<StaffPerson, "firstName" | "lastName">): string {
  return `${person.firstName} ${person.lastName}`.trim();
}

/** Qualifications accepted for a seat of this vehicle type; null: the seat does not exist. */
export function seatRequirement(type: VehicleType, seat: Seat): readonly Qualification[] | null {
  const rule = REQUIRED_QUALIFICATIONS[type];
  return seat === "driver" ? rule.driver : rule.crewMate;
}

export function isQualified(person: Pick<StaffPerson, "qualifications">, type: VehicleType, seat: Seat): boolean {
  const required = seatRequirement(type, seat);
  return required !== null && person.qualifications.some((q) => required.includes(q));
}

/**
 * Can `person` complete a crew whose other member is `other` (null: the other
 * seat is empty)? An ambulance needs a DEA at the wheel or beside the patient
 * (rules.ts, R. 6312-10): with an auxiliary already on board, the second
 * person must be a DEA.
 */
export function completesCrew(
  person: Pick<StaffPerson, "qualifications">,
  other: Pick<StaffPerson, "qualifications"> | null | undefined,
  type: VehicleType,
): boolean {
  return !other || crewHoldsRequired(type, [person.qualifications, other.qualifications]);
}

/** "ambulancier DE" for an ambulance (inside a sentence): what one member of its crew must hold. */
export function oneOfNoun(type: VehicleType): string | null {
  const oneOf: readonly Qualification[] | null = CREW_REQUIRED_ONE_OF[type];
  return oneOf ? oneOf.map((q) => QUALIFICATION_NOUNS[q]).join(" ou ") : null;
}

type Shift = Pick<StaffPerson, "shiftStartMinute" | "shiftEndMinute">;

/** Minutes two shifts have in common (0 when they do not meet). */
export function sharedMinutes(a: Shift, b: Shift): number {
  return Math.max(0, Math.min(a.shiftEndMinute, b.shiftEndMinute) - Math.max(a.shiftStartMinute, b.shiftStartMinute));
}

/** Working hours of a crew: the driver's, within the crew mate's on an ambulance; null when they do not meet. */
function crewShift(driver: Shift, mate: Shift | undefined, type: VehicleType): { start: number; end: number } | null {
  if (!mate || type !== "AMBULANCE") return { start: driver.shiftStartMinute, end: driver.shiftEndMinute };
  const start = Math.max(driver.shiftStartMinute, mate.shiftStartMinute);
  const end = Math.min(driver.shiftEndMinute, mate.shiftEndMinute);
  return end > start ? { start, end } : null;
}

/** The person's break settings, null when the caller gave none (not checked). */
function breakSettingsOf(person: StaffPerson): BreakSettings | null {
  if (person.breakMinutes === undefined) return null;
  return {
    breakWindowStartMinute: person.breakWindowStartMinute ?? null,
    breakWindowEndMinute: person.breakWindowEndMinute ?? null,
    breakMinutes: person.breakMinutes,
  };
}

/** Whether this crew would work more than 6 hours without a legal break (the driver's applies to the crew). */
function breaksWorkTime(driver: StaffPerson, mate: StaffPerson | undefined, type: VehicleType): boolean {
  const settings = breakSettingsOf(driver);
  const shift = crewShift(driver, mate, type);
  return settings !== null && shift !== null && workTimeSummary(settings, shift) !== null;
}

/**
 * The blocking problem of a crew in a few words when it is the work-time rule
 * (its remedy is on /equipages), else null: what the planning's lists show in
 * place of `blocked` (vehicles to review, vehicles left out).
 */
export function workTimeBlock(crew: Pick<DayCrewView, "blocked"> & { issues?: readonly CrewIssue[] }): string | null {
  if (crew.blocked === null) return null;
  const issue = crew.issues?.find((i) => i.level === "error");
  return issue?.message === crew.blocked ? (issue.workTime?.summary ?? null) : null;
}

/** Minutes of `holder`'s shift that `person` does not work. */
function uncoveredMinutes(person: Shift, holder: Shift | null): number {
  if (!holder) return 0;
  return Math.max(0, person.shiftStartMinute - holder.shiftStartMinute) + Math.max(0, holder.shiftEndMinute - person.shiftEndMinute);
}

/**
 * How many kinds of seats a person can take: one per vehicle type they may
 * drive or crew, plus as many again for a qualification a crew must hold
 * (a DEA): the least versatile people are proposed first, a DEA last.
 */
export function versatility(person: Pick<StaffPerson, "qualifications">): number {
  let score = 0;
  for (const type of TYPES) {
    if (isQualified(person, type, "driver") || isQualified(person, type, "crewMate")) score++;
    const oneOf: readonly Qualification[] | null = CREW_REQUIRED_ONE_OF[type];
    if (oneOf && person.qualifications.some((q) => oneOf.includes(q))) score += TYPES.length;
  }
  return score;
}

const EARTH_RADIUS_KM = 6371;

/** Straight-line distance between two depots (haversine), in km. */
export function depotDistanceKm(a: Pick<CrewDepot, "lat" | "lng">, b: Pick<CrewDepot, "lat" | "lng">): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The absence covering the date, if any (the earliest one when several overlap). */
export function absenceOn(driverId: string, isoDate: string, absences: readonly DatedAbsence[]): DatedAbsence | null {
  let found: DatedAbsence | null = null;
  for (const a of absences) {
    if (a.driverId !== driverId || a.startDate > isoDate || a.endDate < isoDate) continue;
    if (!found || a.startDate < found.startDate) found = a;
  }
  return found;
}

export function areIncompatible(a: string, b: string, pairs: readonly Incompatibility[]): boolean {
  return pairs.some((p) => (p.driverAId === a && p.driverBId === b) || (p.driverAId === b && p.driverBId === a));
}

function datedText(label: string, absence: Pick<DatedAbsence, "startDate" | "endDate">): string {
  return absence.startDate === absence.endDate
    ? `${label} le ${formatShortDate(absence.startDate)}`
    : `${label} du ${formatShortDate(absence.startDate)} au ${formatShortDate(absence.endDate)}`;
}

/**
 * "Congé du 10/11/2026 au 14/11/2026", "Arrêt maladie le 10/11/2026": with the
 * reason, for the person's own sheet only (/chauffeurs/[id]).
 */
export function absenceText(absence: Pick<DatedAbsence, "kind" | "startDate" | "endDate">): string {
  return datedText(ABSENCE_KIND_LABELS[absence.kind], absence);
}

/** Reasons the planning screens name: duties, not private matters. */
const DUTY_KINDS: Partial<Record<AbsenceKind, string>> = { ON_CALL: "Garde", TRAINING: "Formation" };

/**
 * What the planning screens show (crews, crew problems, absent list): "Garde
 * le 11/11/2026" or "Formation du …" for a duty, "Absence du 10/11/2026 au
 * 14/11/2026" for leave, sick leave and any other reason alike, so a sick
 * leave cannot be told from a holiday there. A noun, so it reads right for anyone.
 */
export function planningAbsenceText(absence: Pick<DatedAbsence, "kind" | "startDate" | "endDate">): string {
  return datedText(planningAbsenceLabel(absence.kind), absence);
}

/** « Garde », « Formation », else « Absence »: the word of planningAbsenceText, without the dates. */
export function planningAbsenceLabel(kind: AbsenceKind): string {
  return DUTY_KINDS[kind] ?? "Absence";
}

/** "07:00 – 15:00". */
export function shiftText(shift: { start: number; end: number }): string {
  return `${formatMinute(shift.start)} – ${formatMinute(shift.end)}`;
}

const SEAT_LABEL: Record<Seat, string> = { driver: "Chauffeur", crewMate: "Équipier" };

/** Message of a vehicle kept at the depot by the regulator. */
export const PARKED_MESSAGE = "Laissé au dépôt ce jour (choix du régulateur)";
/** Message of a fixed ambulance whose driver seat the regulator left empty (crew mate only). */
export const NO_DRIVER_CHOSEN_MESSAGE = "Pas de chauffeur ce jour (choix du régulateur)";

type Draft = {
  vehicle: CrewVehicle;
  /** Display order of the vehicle. */
  index: number;
  driverId: string | null;
  crewMateId: string | null;
  source: CrewSource;
  issues: CrewIssue[];
  /** Seats to fill with a replacement: empty ones (default and spare vehicles), vacated ones (fixed crews). */
  open: Set<Seat>;
  /** Seats filled by a proposed replacement. */
  proposed: Set<Seat>;
  /** Usual holder of each seat (default member, or the fixed member who became unavailable). */
  holder: Partial<Record<Seat, StaffPerson>>;
  parked: boolean;
  /** The lone default member proposed on another vehicle, and the seat nobody could fill next to them. */
  shortOf: { seat: Seat; partner: StaffPerson } | null;
};

/** "Aucun chauffeur disponible", "Aucun équipier ambulancier DE disponible": what a seat left empty lacks. */
function missingText(type: VehicleType, seat: Seat, onBoard: Pick<StaffPerson, "qualifications"> | undefined): string {
  if (seat === "driver") return "Aucun chauffeur disponible";
  // With an auxiliary at the wheel, only a DEA completes the crew.
  const needed = onBoard && !crewHoldsRequired(type, [onBoard.qualifications]) ? ` ${oneOfNoun(type)}` : "";
  return `Aucun équipier${needed} disponible`;
}

type Candidate = { person: StaffPerson; sameDepot: boolean; km: number | null; uncovered: number; versatility: number };

function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    Number(b.sameDepot) - Number(a.sameDepot) ||
    (a.km ?? Number.POSITIVE_INFINITY) - (b.km ?? Number.POSITIVE_INFINITY) ||
    a.uncovered - b.uncovered ||
    a.versatility - b.versatility ||
    comparePeople(a.person, b.person)
  );
}

export function resolveDayCrews(input: DayCrewInput): DayCrewPlan {
  const { date, absences, incompatibilities } = input;
  const rules = input.rules ?? DEFAULT_CREW_RULES;
  const weekday = isoWeekday(date);
  const dayName = (WEEKDAY_LABELS[weekday] ?? "").toLowerCase();
  const people = new Map(input.people.map((p) => [p.id, p]));
  const savedByVehicle = new Map(input.saved.map((s) => [s.vehicleId, s]));
  const vehicles = input.vehicles.filter((v) => v.active).sort(compareVehicles);
  const depots = new Map((input.depots ?? []).map((d) => [d.id, d]));
  /** Vehicles out of service that day: no seat, nobody reserved. */
  const outOfService = new Map(
    vehicles.flatMap((v) => {
      const u = unavailabilityOn(v.id, date, input.vehicleUnavailabilities ?? []);
      return u ? [[v.id, u] as const] : [];
    }),
  );
  const absenceOf = new Map<string, DatedAbsence>();
  for (const person of input.people) {
    const absence = absenceOn(person.id, date, absences);
    if (absence) absenceOf.set(person.id, absence);
  }
  /** People who can be proposed (default or replacement) for the date: active, working that weekday, not absent. */
  const proposable = new Set(
    input.people.filter((p) => p.active && p.workDays.includes(weekday) && !absenceOf.has(p.id)).map((p) => p.id),
  );
  /** Person -> label of the vehicle that holds them. */
  const taken = new Map<string, string>();

  const distanceCache = new Map<string, number | null>();
  /** Distance between two depots, null when unknown (no depot, or no position given). */
  const depotKm = (from: string | null, to: string): number | null => {
    if (from === to) return 0;
    if (from === null) return null;
    const key = from < to ? `${from}|${to}` : `${to}|${from}`;
    if (!distanceCache.has(key)) {
      const a = depots.get(from);
      const b = depots.get(to);
      distanceCache.set(key, a && b ? depotDistanceKm(a, b) : null);
    }
    return distanceCache.get(key) ?? null;
  };

  const drafts: Draft[] = [];
  const draft = (vehicle: CrewVehicle, index: number, source: CrewSource): Draft => ({
    vehicle,
    index,
    driverId: null,
    crewMateId: null,
    source,
    issues: [],
    open: new Set(),
    proposed: new Set(),
    holder: {},
    parked: false,
    shortOf: null,
  });
  const seatsOf = (vehicle: CrewVehicle): Seat[] => (vehicle.type === "AMBULANCE" ? ["driver", "crewMate"] : ["driver"]);
  const setSeat = (d: Draft, seat: Seat, id: string | null) => {
    if (seat === "driver") d.driverId = id;
    else d.crewMateId = id;
  };
  const seatOf = (d: Draft, seat: Seat) => (seat === "driver" ? d.driverId : d.crewMateId);
  const other = (d: Draft, seat: Seat) => {
    const id = seat === "driver" ? d.crewMateId : d.driverId;
    return id ? people.get(id) : undefined;
  };

  // 1. Crews fixed by the regulator reserve their people first.
  vehicles.forEach((vehicle, index) => {
    const saved = savedByVehicle.get(vehicle.id);
    if (!saved || outOfService.has(vehicle.id)) return;
    const crewMateId = vehicle.type === "AMBULANCE" ? saved.crewMateId : null;
    const d = draft(vehicle, index, "saved");
    d.parked = saved.driverId === null && crewMateId === null;
    for (const [seat, id] of [["driver", saved.driverId], ["crewMate", crewMateId]] as const) {
      if (id === null) continue;
      const person = people.get(id);
      if (person && (!person.active || absenceOf.has(id))) {
        // Became unavailable since it was fixed: the seat gets a replacement, the other member stays.
        const absence = absenceOf.get(id);
        const why = absence ? planningAbsenceText(absence).toLowerCase() : "désactivé";
        d.issues.push({ level: "info", seat, message: `${SEAT_LABEL[seat]} fixé indisponible (${staffName(person)} : ${why})` });
        d.holder[seat] = person;
        d.open.add(seat);
        continue;
      }
      setSeat(d, seat, id);
      const holder = taken.get(id);
      const name = person ? staffName(person) : "Personne inconnue";
      if (holder) d.issues.push({ level: "error", seat, message: `${name} est déjà affecté à ${holder} ce jour` });
      else taken.set(id, vehicle.label);
    }
    drafts.push(d);
  });

  /** Why a default crew member cannot take their seat that day, or null. */
  const defaultUnavailable = (person: StaffPerson, vehicle: CrewVehicle, seat: Seat, partner: StaffPerson | undefined): string | null => {
    if (!person.active) return "désactivé";
    const absence = absenceOf.get(person.id);
    if (absence) return planningAbsenceText(absence).toLowerCase();
    if (!person.workDays.includes(weekday)) return `ne travaille pas le ${dayName}`;
    const holder = taken.get(person.id);
    if (holder) return `déjà sur ${holder}`;
    if (!isQualified(person, vehicle.type, seat)) return "qualification manquante";
    if (partner && areIncompatible(partner.id, person.id, incompatibilities)) return "incompatible avec le chauffeur";
    if (partner && !completesCrew(person, partner, vehicle.type)) return `aucun ${oneOfNoun(vehicle.type)} dans l'équipage`;
    if (partner && vehicle.type === "AMBULANCE" && sharedMinutes(person, partner) < rules.minPairOverlapMin) {
      return `${formatDuration(sharedMinutes(person, partner))} d'horaire commun avec le chauffeur, ${formatDuration(rules.minPairOverlapMin)} au moins`;
    }
    return null;
  };

  // 2. Default crews, member by member, when available.
  vehicles.forEach((vehicle, index) => {
    if (savedByVehicle.has(vehicle.id) || outOfService.has(vehicle.id)) return;
    const d = draft(vehicle, index, "default");
    for (const seat of seatsOf(vehicle)) {
      const id = seat === "driver" ? vehicle.defaultDriverId : vehicle.defaultCrewMateId;
      const person = id ? people.get(id) : undefined;
      d.open.add(seat);
      if (!person) continue;
      d.holder[seat] = person;
      const why = defaultUnavailable(person, vehicle, seat, seat === "crewMate" ? other(d, seat) : undefined);
      if (why) {
        d.issues.push({ level: "info", seat, message: `${SEAT_LABEL[seat]} attitré indisponible (${staffName(person)} : ${why})` });
        continue;
      }
      setSeat(d, seat, person.id);
      d.open.delete(seat);
      taken.set(person.id, vehicle.label);
    }
    drafts.push(d);
  });

  // 3. Replacements for the seats left open.
  const pool = input.people.filter((p) => proposable.has(p.id)).sort(comparePeople);
  /** Free people of each depot (reserve), counted once the fixed and default crews are placed. */
  const freeByDepot = new Map<string, number>();
  for (const p of pool) {
    if (p.depotId && !taken.has(p.id)) freeByDepot.set(p.depotId, (freeByDepot.get(p.depotId) ?? 0) + 1);
  }
  const take = (person: StaffPerson, label: string) => {
    taken.set(person.id, label);
    if (person.depotId) freeByDepot.set(person.depotId, (freeByDepot.get(person.depotId) ?? 0) - 1);
  };
  const release = (person: StaffPerson) => {
    taken.delete(person.id);
    if (person.depotId) freeByDepot.set(person.depotId, (freeByDepot.get(person.depotId) ?? 0) + 1);
  };
  const hasDefaultCrew = (d: Draft) => d.vehicle.defaultDriverId !== null || d.vehicle.defaultCrewMateId !== null;
  const group = (d: Draft) => (d.source === "saved" ? 0 : hasDefaultCrew(d) ? 1 : 2);
  const isSpare = (d: Draft) => group(d) === 2;
  const emptySeats = (d: Draft) => seatsOf(d.vehicle).filter((seat) => d.open.has(seat) && seatOf(d, seat) === null);
  /**
   * How scarce the people a vehicle needs are, among its type: 0 for a seat
   * only a DEA can fill (the member on board is not one), 1 for both seats
   * of an ambulance, 2 for anyone qualified.
   */
  const need = (d: Draft): number => {
    if (CREW_REQUIRED_ONE_OF[d.vehicle.type] === null) return 2;
    const seats = emptySeats(d);
    if (seats.length === 2) return 1;
    const onBoard = seats[0] ? other(d, seats[0]) : undefined;
    return onBoard && !crewHoldsRequired(d.vehicle.type, [onBoard.qualifications]) ? 0 : 2;
  };
  const needOf = new Map(drafts.map((d) => [d, need(d)]));
  const order = drafts
    .filter((d) => d.open.size > 0)
    .sort(
      (a, b) =>
        Number(isSpare(a)) - Number(isSpare(b)) ||
        SCARCITY_ORDER[a.vehicle.type] - SCARCITY_ORDER[b.vehicle.type] ||
        (needOf.get(a) ?? 2) - (needOf.get(b) ?? 2) ||
        group(a) - group(b) ||
        a.index - b.index,
    );

  /** Whether `p` may take `seat` next to `partner`, before the distance and reserve limits. */
  const fits = (p: StaffPerson, d: Draft, seat: Seat, partner: StaffPerson | undefined): boolean => {
    const { type } = d.vehicle;
    if (taken.has(p.id) || p.id === partner?.id || !isQualified(p, type, seat)) return false;
    if (!partner) return true;
    if (areIncompatible(partner.id, p.id, incompatibilities) || !completesCrew(p, partner, type)) return false;
    return type !== "AMBULANCE" || sharedMinutes(p, partner) >= rules.minPairOverlapMin;
  };
  /** The reserve of the person's depot is reached (the partner chosen with them counts as taken). */
  const inReserve = (p: StaffPerson, partner: StaffPerson | undefined): boolean => {
    if (!p.depotId) return false;
    const free = (freeByDepot.get(p.depotId) ?? 0) - (partner && partner.depotId === p.depotId && !taken.has(partner.id) ? 1 : 0);
    return free <= rules.reservePerDepot;
  };

  /** Whether the crew with `p` in `seat` would work more than 6 hours without a legal break: `p` is not proposed. */
  const breaksRule = (p: StaffPerson, d: Draft, seat: Seat, partner: StaffPerson | undefined): boolean => {
    const driver = seat === "driver" ? p : partner;
    return driver !== undefined && breaksWorkTime(driver, seat === "driver" ? partner : p, d.vehicle.type);
  };

  /** Ranked candidates for a seat; `partner`: the other member (on board or about to be). */
  const candidatesFor = (d: Draft, seat: Seat, partner: StaffPerson | undefined, spare: boolean): Candidate[] => {
    const { vehicle } = d;
    const holder = d.holder[seat] ?? null;
    const found: Candidate[] = [];
    for (const p of pool) {
      if (!fits(p, d, seat, partner) || breaksRule(p, d, seat, partner)) continue;
      const km = depotKm(p.depotId, vehicle.depotId);
      if (km !== null && km > rules.maxReplacementKm) continue;
      if (spare && inReserve(p, partner)) continue;
      found.push({
        person: p,
        sameDepot: p.depotId === vehicle.depotId,
        km,
        uncovered: uncoveredMinutes(p, holder),
        versatility: versatility(p),
      });
    }
    return found.sort(compareCandidates);
  };

  /**
   * `base` and why the free qualified people were not proposed for an empty
   * seat: the nearest one beyond the replacement distance, one kept in the
   * reserve of their depot (spare vehicle), or one whose hours with this crew
   * would need a break they do not have. Read once every seat is served.
   */
  const unfilledText = (d: Draft, seat: Seat, partner: StaffPerson | undefined, base: string): string => {
    let far: { person: StaffPerson; km: number } | null = null;
    let kept: StaffPerson | null = null;
    let breakless: StaffPerson | null = null;
    for (const p of pool) {
      if (!fits(p, d, seat, partner)) continue;
      const km = depotKm(p.depotId, d.vehicle.depotId);
      if (breaksRule(p, d, seat, partner)) {
        if (km === null || km <= rules.maxReplacementKm) breakless ??= p;
      } else if (km !== null && km > rules.maxReplacementKm) {
        if (!far || km < far.km) far = { person: p, km };
      } else if (isSpare(d) && inReserve(p, partner)) kept ??= p;
    }
    if (far) {
      const depot = far.person.depotId ? depots.get(far.person.depotId) : undefined;
      const where = `${depot ? `dépôt de ${depot.name}, ` : ""}${Math.round(far.km)} km`;
      return `${base} dans un rayon de ${rules.maxReplacementKm.toLocaleString("fr-FR")} km (Paramètres) : ${staffName(far.person)} (${where}) est libre`;
    }
    if (kept) return `${base} sans entamer la réserve du dépôt (Paramètres) : ${staffName(kept)} reste en réserve`;
    if (breakless) {
      return `${base} : ${staffName(breakless)} est libre, mais l'équipage dépasserait 6 h de travail sans pause de 20 min (art. L. 3121-16)`;
    }
    return base;
  };

  const proposalText = (d: Draft, seat: Seat, c: Candidate): string => {
    const notes: string[] = [];
    const depot = c.person.depotId ? depots.get(c.person.depotId) : undefined;
    if (!c.sameDepot) {
      if (c.person.depotId === null) notes.push("sans dépôt");
      else if (c.km !== null && depot) notes.push(`dépôt de ${depot.name}, ${Math.round(c.km)} km`);
      else notes.push("autre dépôt");
    }
    const holder = d.holder[seat];
    if (holder && c.uncovered > 0) {
      const own = shiftText({ start: c.person.shiftStartMinute, end: c.person.shiftEndMinute });
      notes.push(`horaire ${own} au lieu de ${shiftText({ start: holder.shiftStartMinute, end: holder.shiftEndMinute })}`);
    }
    return `${SEAT_LABEL[seat]} remplaçant proposé : ${staffName(c.person)}${notes.length > 0 ? ` (${notes.join(" ; ")})` : ""}`;
  };

  const place = (d: Draft, seat: Seat, c: Candidate) => {
    setSeat(d, seat, c.person.id);
    take(c.person, d.vehicle.label);
    d.open.delete(seat);
    d.proposed.add(seat);
    if (d.source !== "saved") d.source = "replacement";
    d.issues.push({ level: "info", seat, message: proposalText(d, seat, c) });
  };

  const serve = (d: Draft) => {
    const spare = isSpare(d);
    const seats = emptySeats(d);
    if (seats.length === 2) {
      // Both seats of an ambulance: the first driver who can be completed, with the best crew mate for them.
      for (const driver of candidatesFor(d, "driver", undefined, spare)) {
        const mate = candidatesFor(d, "crewMate", driver.person, spare)[0];
        if (!mate) continue;
        place(d, "driver", driver);
        place(d, "crewMate", mate);
        break;
      }
    } else {
      for (const seat of seats) {
        const pick = candidatesFor(d, seat, other(d, seat), spare)[0];
        if (pick) place(d, seat, pick);
      }
    }
  };

  const staffed = order.filter((d) => !isSpare(d));
  for (const d of staffed.filter((d) => d.vehicle.type === "AMBULANCE")) serve(d);
  // A default member alone on an ambulance nobody can complete is offered to the other vehicles first.
  const alone: { d: Draft; seat: Seat; person: StaffPerson; empty: Seat }[] = [];
  for (const d of staffed) {
    if (d.source === "saved" || d.vehicle.type !== "AMBULANCE") continue;
    const [empty, ...more] = emptySeats(d);
    if (!empty || more.length > 0) continue;
    const seat: Seat = empty === "driver" ? "crewMate" : "driver";
    const id = seatOf(d, seat);
    const person = id ? people.get(id) : undefined;
    if (!person) continue;
    alone.push({ d, seat, person, empty });
    setSeat(d, seat, null);
    release(person);
  }
  for (const d of staffed.filter((d) => d.vehicle.type !== "AMBULANCE")) serve(d);
  for (const { d, seat, person, empty } of alone) {
    const elsewhere = taken.get(person.id);
    if (elsewhere) {
      d.shortOf = { seat: empty, partner: person };
      const lacking = missingText(d.vehicle.type, empty, person);
      d.issues.push({
        level: "info",
        seat,
        message: `${SEAT_LABEL[seat]} attitré proposé sur ${elsewhere} (${staffName(person)}) : ${lacking.charAt(0).toLowerCase()}${lacking.slice(1)} pour cette ambulance`,
      });
    } else {
      // Nobody needs them: they stay on their ambulance, which still lacks its partner.
      setSeat(d, seat, person.id);
      take(person, d.vehicle.label);
    }
  }
  for (const d of order.filter(isSpare)) serve(d);

  // Problems of every crew, then the first blocking one.
  const crews: DayCrewView[] = [];
  const byVehicle = new Map(drafts.map((d) => [d.vehicle.id, d]));
  for (const vehicle of vehicles) {
    const outage = outOfService.get(vehicle.id);
    if (outage) {
      const message = `Véhicule indisponible (${unavailabilityText(outage).toLowerCase()})`;
      crews.push({
        vehicleId: vehicle.id,
        driverId: null,
        crewMateId: null,
        source: "none",
        proposedSeats: [],
        parked: false,
        shift: null,
        issues: [{ level: "error", seat: null, message }],
        blocked: message,
        unavailable: true,
      });
      continue;
    }
    const d = byVehicle.get(vehicle.id)!;
    const issues = [...d.issues];
    const saved = d.source === "saved";
    for (const seat of ["driver", "crewMate"] as const) {
      const id = seatOf(d, seat);
      if (id === null) continue;
      const person = people.get(id);
      if (!person) {
        issues.push({ level: "error", seat, message: `${SEAT_LABEL[seat]} introuvable` });
        continue;
      }
      // Proposals are only made of available, qualified people; a fixed member who became unavailable left the seat.
      if (!saved || d.proposed.has(seat)) continue;
      const name = staffName(person);
      if (!isQualified(person, vehicle.type, seat)) {
        issues.push({ level: "error", seat, message: `${name} n'a pas la qualification requise pour ce poste` });
      }
      if (!person.workDays.includes(weekday)) {
        issues.push({ level: "info", seat, message: `${name} ne travaille pas habituellement le ${dayName} : affectation exceptionnelle` });
      }
    }
    const driver = d.driverId ? people.get(d.driverId) : undefined;
    const mate = d.crewMateId ? people.get(d.crewMateId) : undefined;
    if (d.driverId !== null && d.driverId === d.crewMateId) {
      issues.push({ level: "error", seat: "crewMate", message: "Le chauffeur et l'équipier sont la même personne" });
    } else if (d.driverId && d.crewMateId && areIncompatible(d.driverId, d.crewMateId, incompatibilities)) {
      issues.push({
        level: "error",
        seat: "crewMate",
        message: `${driver ? staffName(driver) : "Le chauffeur"} et ${mate ? staffName(mate) : "l'équipier"} ne doivent pas travailler ensemble`,
      });
    } else if (saved && driver && mate) {
      if (!completesCrew(driver, mate, vehicle.type)) {
        issues.push({
          level: "error",
          seat: "crewMate",
          message: `Il faut au moins un ${oneOfNoun(vehicle.type)} dans l'équipage, au volant ou auprès du patient`,
        });
      } else if (vehicle.type === "AMBULANCE" && sharedMinutes(driver, mate) < rules.minPairOverlapMin) {
        issues.push({
          level: "error",
          seat: "crewMate",
          message: `${staffName(driver)} et ${staffName(mate)} n'ont que ${formatDuration(sharedMinutes(driver, mate))} d'horaire commun (${formatDuration(rules.minPairOverlapMin)} au moins, Paramètres)`,
        });
      }
    }
    /** Left empty by the regulator on a fixed crew (not vacated by an absence). */
    const chosenEmpty = (seat: Seat) => saved && !d.open.has(seat) && !d.holder[seat];
    if (d.parked) {
      issues.push({ level: "info", seat: "driver", message: PARKED_MESSAGE });
    } else if (d.shortOf) {
      const { seat, partner } = d.shortOf;
      issues.push({ level: "error", seat, message: unfilledText(d, seat, partner, missingText(vehicle.type, seat, partner)) });
    } else if (d.driverId === null) {
      const message = chosenEmpty("driver")
        ? NO_DRIVER_CHOSEN_MESSAGE
        : // Both seats of an ambulance empty: no single person to name.
          mate || vehicle.type !== "AMBULANCE"
          ? unfilledText(d, "driver", mate, missingText(vehicle.type, "driver", mate))
          : missingText(vehicle.type, "driver", undefined);
      issues.push({ level: "error", seat: "driver", message });
    } else if (vehicle.type === "AMBULANCE" && d.crewMateId === null) {
      const message = chosenEmpty("crewMate")
        ? "Ambulance sans équipier ce jour"
        : unfilledText(d, "crewMate", driver, missingText(vehicle.type, "crewMate", driver));
      issues.push({ level: "error", seat: "crewMate", message });
    }
    const shift = driver ? crewShift(driver, mate, vehicle.type) : null;
    // The optimizer gets the driver's break for the whole crew: over 6 hours it must be a legal one.
    const settings = driver ? breakSettingsOf(driver) : null;
    if (shift && driver && settings && !d.parked) {
      const message = workTimeIssue(settings, shift, staffName(driver));
      const summary = workTimeSummary(settings, shift);
      if (message && summary) issues.push({ level: "error", seat: "driver", message, workTime: { summary } });
    }
    const blocked = issues.find((i) => i.level === "error")?.message ?? (d.parked ? PARKED_MESSAGE : null);
    crews.push({
      vehicleId: vehicle.id,
      driverId: d.driverId,
      crewMateId: d.crewMateId,
      source: d.driverId === null && d.crewMateId === null && !saved ? "none" : d.source,
      proposedSeats: [...d.proposed],
      parked: d.parked,
      shift,
      issues,
      blocked,
      unavailable: false,
    });
  }

  const absent = input.people
    .filter((p) => p.active && absenceOf.has(p.id))
    .sort(comparePeople)
    .map((p) => {
      const absence = absenceOf.get(p.id)!;
      return { driverId: absence.driverId, startDate: absence.startDate, endDate: absence.endDate, text: planningAbsenceText(absence) };
    });
  const idle = pool.filter((p) => !taken.has(p.id)).map((p) => p.id);

  return { date, crews, absent, idle };
}
