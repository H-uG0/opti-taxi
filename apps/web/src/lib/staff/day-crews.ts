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
 *    shift they cover, then the least versatile first (a DEA is kept for the
 *    ambulances: a VSL takes an auxiliary when one is free). Seats are served
 *    in this order: fixed crews that lost a member, vehicles with a default
 *    crew, then spare vehicles (no default crew), which only take the people
 *    left over beyond the reserve kept per depot (CrewRules.reservePerDepot);
 *    within each group, ambulances first (the scarcest people), then VSL,
 *    then taxis.
 * An ambulance crew needs a DEA at the wheel or beside the patient (rules.ts,
 * R. 6312-10) and CrewRules.minPairOverlapMin of shared working time.
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
import { ABSENCE_KIND_LABELS, QUALIFICATION_LABELS } from "@/lib/labels";
import { formatDuration, formatMinute, formatShortDate, isoWeekday, WEEKDAY_LABELS } from "@/lib/time";

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
export type CrewIssue = { level: "error" | "info"; seat: Seat | null; message: string };

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

const TYPE_ORDER: Record<VehicleType, number> = { TAXI: 0, VSL: 1, AMBULANCE: 2 };
const TYPES = Object.keys(TYPE_ORDER) as VehicleType[];
/** Replacements are served from the scarcest people to the most common: ambulance, VSL, taxi. */
const SCARCITY_ORDER: Record<VehicleType, number> = { AMBULANCE: 0, VSL: 1, TAXI: 2 };

/** Same display order as the optimizer request: type, then label. */
function compareVehicles(a: CrewVehicle, b: CrewVehicle): number {
  return TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.label.localeCompare(b.label, "fr", { numeric: true });
}

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

/** "Ambulancier DE" for an ambulance: what one member of its crew must hold. */
function oneOfLabel(type: VehicleType): string | null {
  const oneOf: readonly Qualification[] | null = CREW_REQUIRED_ONE_OF[type];
  return oneOf ? oneOf.map((q) => QUALIFICATION_LABELS[q]).join(" ou ") : null;
}

type Shift = Pick<StaffPerson, "shiftStartMinute" | "shiftEndMinute">;

/** Minutes two shifts have in common (0 when they do not meet). */
export function sharedMinutes(a: Shift, b: Shift): number {
  return Math.max(0, Math.min(a.shiftEndMinute, b.shiftEndMinute) - Math.max(a.shiftStartMinute, b.shiftStartMinute));
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
  return datedText(DUTY_KINDS[absence.kind] ?? "Absence", absence);
}

/** "07:00 – 15:00". */
export function shiftText(shift: { start: number; end: number }): string {
  return `${formatMinute(shift.start)} – ${formatMinute(shift.end)}`;
}

const SEAT_LABEL: Record<Seat, string> = { driver: "Chauffeur", crewMate: "Équipier" };

/** Message of a vehicle kept at the depot by the regulator. */
export const PARKED_MESSAGE = "Laissé au dépôt ce jour (choix du régulateur)";

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
};

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
    if (partner && !completesCrew(person, partner, vehicle.type)) return `aucun ${oneOfLabel(vehicle.type)} dans l'équipage`;
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
  const hasDefaultCrew = (d: Draft) => d.vehicle.defaultDriverId !== null || d.vehicle.defaultCrewMateId !== null;
  const group = (d: Draft) => (d.source === "saved" ? 0 : hasDefaultCrew(d) ? 1 : 2);
  const order = drafts
    .filter((d) => d.open.size > 0)
    .sort((a, b) => group(a) - group(b) || SCARCITY_ORDER[a.vehicle.type] - SCARCITY_ORDER[b.vehicle.type] || a.index - b.index);

  /** Ranked candidates for a seat; `partner`: the other member (on board or about to be). */
  const candidatesFor = (d: Draft, seat: Seat, partner: StaffPerson | undefined, spare: boolean): Candidate[] => {
    const { vehicle } = d;
    const holder = d.holder[seat] ?? null;
    const found: Candidate[] = [];
    for (const p of pool) {
      if (taken.has(p.id) || p.id === partner?.id || !isQualified(p, vehicle.type, seat)) continue;
      if (partner && (areIncompatible(partner.id, p.id, incompatibilities) || !completesCrew(p, partner, vehicle.type))) continue;
      if (partner && vehicle.type === "AMBULANCE" && sharedMinutes(p, partner) < rules.minPairOverlapMin) continue;
      const km = depotKm(p.depotId, vehicle.depotId);
      if (km !== null && km > rules.maxReplacementKm) continue;
      if (spare && p.depotId) {
        // Keep the reserve of the person's depot (the partner chosen with them counts as taken).
        const free = (freeByDepot.get(p.depotId) ?? 0) - (partner && partner.depotId === p.depotId && !taken.has(partner.id) ? 1 : 0);
        if (free <= rules.reservePerDepot) continue;
      }
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

  for (const d of order) {
    const spare = group(d) === 2;
    const seats = seatsOf(d.vehicle).filter((seat) => d.open.has(seat) && seatOf(d, seat) === null);
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
  }

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
          message: `Il faut au moins un ${oneOfLabel(vehicle.type)} dans l'équipage, au volant ou auprès du patient`,
        });
      } else if (vehicle.type === "AMBULANCE" && sharedMinutes(driver, mate) < rules.minPairOverlapMin) {
        issues.push({
          level: "error",
          seat: "crewMate",
          message: `${staffName(driver)} et ${staffName(mate)} n'ont que ${formatDuration(sharedMinutes(driver, mate))} d'horaire commun (${formatDuration(rules.minPairOverlapMin)} au moins, Paramètres)`,
        });
      }
    }
    if (d.parked) {
      issues.push({ level: "info", seat: "driver", message: PARKED_MESSAGE });
    } else if (d.driverId === null) {
      issues.push({ level: "error", seat: "driver", message: "Aucun chauffeur disponible" });
    } else if (vehicle.type === "AMBULANCE" && d.crewMateId === null) {
      // With an auxiliary at the wheel, only a DEA completes the crew.
      const needed = driver && !crewHoldsRequired(vehicle.type, [driver.qualifications]) ? ` ${oneOfLabel(vehicle.type)}` : "";
      const fixedAlone = saved && !d.open.has("crewMate") && !d.holder.crewMate;
      issues.push({ level: "error", seat: "crewMate", message: fixedAlone ? "Ambulance sans équipier ce jour" : `Aucun équipier${needed} disponible` });
    }
    let shift: DayCrewView["shift"] = driver ? { start: driver.shiftStartMinute, end: driver.shiftEndMinute } : null;
    if (shift && mate && vehicle.type === "AMBULANCE") {
      shift = { start: Math.max(shift.start, mate.shiftStartMinute), end: Math.min(shift.end, mate.shiftEndMinute) };
      if (shift.end <= shift.start) shift = null;
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
