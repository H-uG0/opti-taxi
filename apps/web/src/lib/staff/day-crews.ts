/**
 * Crews of the day (lot 3 of docs/besoin-et-solution.md): who drives and who
 * crews each vehicle on a given date. Pure module, unit-tested; the planning
 * screens, the crew screen and the optimizer request all read the same result.
 *
 * Per active vehicle, in this order:
 * 1. the crew the regulator fixed for that date (DayCrew row): kept as is,
 *    problems reported (absence, qualification, incompatible pair, a person
 *    on two vehicles); a working day the person does not usually work is
 *    allowed (weekend duty), noted only;
 * 2. otherwise its default crew, for every member available that day (active,
 *    working that weekday, not absent, not already taken);
 * 3. a seat left empty gets a replacement: an available, qualified person
 *    with no seat yet, from the vehicle's depot first, compatible with the
 *    other crew member. Vehicles with a default crew are served first: a
 *    spare vehicle (no default driver) only gets the people left over.
 * A vehicle with a blocking problem (`blocked`) is left out of the planning.
 */
import type { AbsenceKind, Qualification, VehicleType } from "@prisma/client";
import { REQUIRED_QUALIFICATIONS } from "@/lib/domain/rules";
import { ABSENCE_KIND_LABELS } from "@/lib/labels";
import { formatShortDate, isoWeekday, WEEKDAY_LABELS } from "@/lib/time";

export type StaffPerson = {
  id: string;
  firstName: string;
  lastName: string;
  active: boolean;
  workDays: number[];
  qualifications: Qualification[];
  depotId: string | null;
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
  /** Saved by the regulator, the default crew, a replacement (at least one seat), or nobody available. */
  source: CrewSource;
  issues: CrewIssue[];
  /** First blocking problem: the vehicle cannot work that day. Null when it can. */
  blocked: string | null;
};

export type DayCrewPlan = {
  date: string;
  /** Active vehicles, in display order. */
  crews: DayCrewView[];
  /** People absent that day, with the reason. */
  absent: { driverId: string; kind: AbsenceKind; startDate: string; endDate: string }[];
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
};

const TYPE_ORDER: Record<VehicleType, number> = { TAXI: 0, VSL: 1, AMBULANCE: 2 };

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

/** "Congé du 10/11/2026 au 14/11/2026", "Garde le 10/11/2026". */
export function absenceText(absence: Pick<DatedAbsence, "kind" | "startDate" | "endDate">): string {
  const label = ABSENCE_KIND_LABELS[absence.kind];
  return absence.startDate === absence.endDate
    ? `${label} le ${formatShortDate(absence.startDate)}`
    : `${label} du ${formatShortDate(absence.startDate)} au ${formatShortDate(absence.endDate)}`;
}

const SEAT_LABEL: Record<Seat, string> = { driver: "Chauffeur", crewMate: "Équipier" };

export function resolveDayCrews(input: DayCrewInput): DayCrewPlan {
  const { date, absences, incompatibilities } = input;
  const weekday = isoWeekday(date);
  const dayName = (WEEKDAY_LABELS[weekday] ?? "").toLowerCase();
  const people = new Map(input.people.map((p) => [p.id, p]));
  const savedByVehicle = new Map(input.saved.map((s) => [s.vehicleId, s]));
  const vehicles = input.vehicles.filter((v) => v.active).sort(compareVehicles);
  /** Person -> label of the vehicle that holds them. */
  const taken = new Map<string, string>();

  /** Can this person be proposed (default or replacement) for the date? */
  const proposable = (person: StaffPerson | undefined): person is StaffPerson =>
    person !== undefined && person.active && person.workDays.includes(weekday) && !absenceOn(person.id, date, absences);

  type Draft = { vehicle: CrewVehicle; driverId: string | null; crewMateId: string | null; source: CrewSource; issues: CrewIssue[] };
  const drafts: Draft[] = [];

  // 1. Crews fixed by the regulator reserve their people first.
  for (const vehicle of vehicles) {
    const saved = savedByVehicle.get(vehicle.id);
    if (!saved) continue;
    const crewMateId = vehicle.type === "AMBULANCE" ? saved.crewMateId : null;
    const draft: Draft = { vehicle, driverId: saved.driverId, crewMateId, source: "saved", issues: [] };
    for (const [seat, id] of [["driver", saved.driverId], ["crewMate", crewMateId]] as const) {
      if (id === null) continue;
      const holder = taken.get(id);
      const name = people.get(id) ? staffName(people.get(id)!) : "Personne inconnue";
      if (holder) draft.issues.push({ level: "error", seat, message: `${name} est déjà affecté à ${holder} ce jour` });
      else taken.set(id, vehicle.label);
    }
    drafts.push(draft);
  }

  /** Why a default crew member cannot take their seat that day, or null. */
  const defaultUnavailable = (person: StaffPerson, vehicle: CrewVehicle, seat: Seat, other: string | null): string | null => {
    if (!person.active) return "désactivé";
    const absence = absenceOn(person.id, date, absences);
    if (absence) return absenceText(absence).toLowerCase();
    if (!person.workDays.includes(weekday)) return `ne travaille pas le ${dayName}`;
    const holder = taken.get(person.id);
    if (holder) return `déjà sur ${holder}`;
    if (!isQualified(person, vehicle.type, seat)) return "qualification manquante";
    if (other && areIncompatible(other, person.id, incompatibilities)) return "incompatible avec le chauffeur";
    return null;
  };

  // 2. Default crews, member by member, when available.
  for (const vehicle of vehicles) {
    if (savedByVehicle.has(vehicle.id)) continue;
    const draft: Draft = { vehicle, driverId: null, crewMateId: null, source: "default", issues: [] };
    const seats: Seat[] = vehicle.type === "AMBULANCE" ? ["driver", "crewMate"] : ["driver"];
    for (const seat of seats) {
      const id = seat === "driver" ? vehicle.defaultDriverId : vehicle.defaultCrewMateId;
      const person = id ? people.get(id) : undefined;
      if (!person) continue;
      const why = defaultUnavailable(person, vehicle, seat, seat === "crewMate" ? draft.driverId : null);
      if (why) {
        draft.issues.push({ level: "info", seat, message: `${SEAT_LABEL[seat]} attitré indisponible (${staffName(person)} : ${why})` });
        continue;
      }
      if (seat === "driver") draft.driverId = person.id;
      else draft.crewMateId = person.id;
      taken.set(person.id, vehicle.label);
    }
    drafts.push(draft);
  }

  // 3. Replacements for the empty seats of the vehicles not fixed by the regulator,
  // vehicles with a default crew first (stable: display order otherwise).
  const pool = [...input.people].sort(comparePeople);
  const hasDefaultCrew = (d: Draft) => d.vehicle.defaultDriverId !== null || d.vehicle.defaultCrewMateId !== null;
  const replacementOrder = [...drafts.filter(hasDefaultCrew), ...drafts.filter((d) => !hasDefaultCrew(d))];
  for (const draft of replacementOrder) {
    if (draft.source === "saved") continue;
    const { vehicle } = draft;
    const seats: Seat[] = vehicle.type === "AMBULANCE" ? ["driver", "crewMate"] : ["driver"];
    for (const seat of seats) {
      if ((seat === "driver" ? draft.driverId : draft.crewMateId) !== null) continue;
      const other = seat === "driver" ? draft.crewMateId : draft.driverId;
      const candidates = pool.filter(
        (p) =>
          proposable(p) &&
          !taken.has(p.id) &&
          isQualified(p, vehicle.type, seat) &&
          !(other && areIncompatible(other, p.id, incompatibilities)),
      );
      const pick = candidates.find((p) => p.depotId === vehicle.depotId) ?? candidates[0];
      if (!pick) continue;
      if (seat === "driver") draft.driverId = pick.id;
      else draft.crewMateId = pick.id;
      taken.set(pick.id, vehicle.label);
      draft.source = "replacement";
      draft.issues.push({
        level: "info",
        seat,
        message: `${SEAT_LABEL[seat]} remplaçant proposé : ${staffName(pick)}${pick.depotId === vehicle.depotId ? "" : " (autre dépôt)"}`,
      });
    }
    if (draft.driverId === null && (vehicle.type !== "AMBULANCE" || draft.crewMateId === null)) draft.source = "none";
  }

  // Problems of every crew, then the first blocking one.
  const crews: DayCrewView[] = [];
  const byVehicle = new Map(drafts.map((d) => [d.vehicle.id, d]));
  for (const vehicle of vehicles) {
    const draft = byVehicle.get(vehicle.id)!;
    const issues = [...draft.issues];
    const saved = draft.source === "saved";
    for (const seat of ["driver", "crewMate"] as const) {
      const id = seat === "driver" ? draft.driverId : draft.crewMateId;
      if (id === null) continue;
      const person = people.get(id);
      if (!person) {
        issues.push({ level: "error", seat, message: `${SEAT_LABEL[seat]} introuvable` });
        continue;
      }
      if (!saved) continue; // proposals are only made of available, qualified people
      const name = staffName(person);
      const absence = absenceOn(id, date, absences);
      if (!person.active) issues.push({ level: "error", seat, message: `${name} est désactivé` });
      if (absence) issues.push({ level: "error", seat, message: `${name} : ${absenceText(absence).toLowerCase()}` });
      if (!isQualified(person, vehicle.type, seat)) {
        issues.push({ level: "error", seat, message: `${name} n'a pas la qualification requise pour ce poste` });
      }
      if (person.active && !absence && !person.workDays.includes(weekday)) {
        issues.push({ level: "info", seat, message: `${name} ne travaille pas habituellement le ${dayName} : affectation exceptionnelle` });
      }
    }
    if (draft.driverId !== null && draft.driverId === draft.crewMateId) {
      issues.push({ level: "error", seat: "crewMate", message: "Le chauffeur et l'équipier sont la même personne" });
    } else if (draft.driverId && draft.crewMateId && areIncompatible(draft.driverId, draft.crewMateId, incompatibilities)) {
      const a = people.get(draft.driverId);
      const b = people.get(draft.crewMateId);
      issues.push({
        level: "error",
        seat: "crewMate",
        message: `${a ? staffName(a) : "Le chauffeur"} et ${b ? staffName(b) : "l'équipier"} ne doivent pas travailler ensemble`,
      });
    }
    if (draft.driverId === null) {
      issues.push({
        level: "error",
        seat: "driver",
        message: saved ? "Pas de chauffeur ce jour (choix du régulateur)" : "Aucun chauffeur disponible",
      });
    } else if (vehicle.type === "AMBULANCE" && draft.crewMateId === null) {
      issues.push({ level: "error", seat: "crewMate", message: saved ? "Ambulance sans équipier ce jour" : "Aucun équipier disponible" });
    }
    const blocked = issues.find((i) => i.level === "error")?.message ?? null;
    crews.push({ vehicleId: vehicle.id, driverId: draft.driverId, crewMateId: draft.crewMateId, source: draft.source, issues, blocked });
  }

  const absent = input.people
    .filter((p) => p.active)
    .map((p) => ({ person: p, absence: absenceOn(p.id, date, absences) }))
    .filter((x): x is { person: StaffPerson; absence: DatedAbsence } => x.absence !== null)
    .sort((x, y) => comparePeople(x.person, y.person))
    .map(({ absence }) => ({ driverId: absence.driverId, kind: absence.kind, startDate: absence.startDate, endDate: absence.endDate }));
  const idle = pool.filter((p) => proposable(p) && !taken.has(p.id)).map((p) => p.id);

  return { date, crews, absent, idle };
}
