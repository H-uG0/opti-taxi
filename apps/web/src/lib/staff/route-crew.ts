/**
 * « Changer l'équipage » of a route already validated or started (planning,
 * vehicle panel): a driver sick at 6 a.m. is replaced on their route without
 * re-optimizing the day. Only Route.driverId / crewMateId change, never the
 * stops; the replacement sees the roadmap at once (/chauffeur reads the routes
 * by crew) and the person replaced loses access to it.
 *
 * The rules of the crews of the day apply to the people put on the route:
 * active, not absent, qualified for the seat, on no other route that day, a
 * shift that covers what is left of the route; an ambulance pair compatible,
 * with a DEA at the wheel or beside the patient (rules.ts, R. 6312-10). Pure
 * module, unit-tested; the server action reads the rows and writes.
 */
import type { StopKind, TripStatus, VehicleType } from "@prisma/client";
import { stopState } from "@/app/chauffeur/_lib/roadmap";
import { CREW_REQUIRED_ONE_OF } from "@/lib/domain/rules";
import { QUALIFICATION_LABELS } from "@/lib/labels";
import { isoWeekday, WEEKDAY_LABELS } from "@/lib/time";
import {
  absenceOn,
  areIncompatible,
  completesCrew,
  isQualified,
  planningAbsenceText,
  seatRequirement,
  shiftText,
  staffName,
  type DatedAbsence,
  type Incompatibility,
  type Seat,
  type StaffPerson,
} from "./day-crews";

export type RouteCrew = { driverId: string | null; crewMateId: string | null };

/** The stops of a route as the remaining-part rule reads them. */
export type RemainingStop = { sequence: number; kind: StopKind; startMinute: number; completedAt: Date | null; tripStatus: TripStatus };

/**
 * What is left to drive of a route: from its departure when nothing was
 * recorded yet, else from the first stop still to do, to the return at the
 * depot. Null when every stop is closed (done, absent, cancelled): finished.
 */
export function remainingPart(
  route: { startMinute: number; endMinute: number },
  stops: readonly RemainingStop[],
): { start: number; end: number } | null {
  const ordered = [...stops].sort((a, b) => a.sequence - b.sequence);
  const pending = ordered.filter((stop) => stopState(stop) === "pending");
  if (pending.length === 0) return null;
  const started = ordered.some((stop) => stop.completedAt !== null);
  return { start: started ? (pending[0]?.startMinute ?? route.startMinute) : route.startMinute, end: route.endMinute };
}

export type RouteCrewChangeInput = {
  date: string;
  vehicle: { label: string; type: VehicleType };
  current: RouteCrew;
  next: RouteCrew;
  /** remainingPart of the route (null: finished). */
  remaining: { start: number; end: number } | null;
  people: ReadonlyMap<string, StaffPerson>;
  absences: readonly DatedAbsence[];
  incompatibilities: readonly Incompatibility[];
  /** The other routes of the day and their crew. */
  otherRoutes: readonly ({ vehicleLabel: string } & RouteCrew)[];
};

export type RouteCrewCheck = {
  /** Blocking problems, by seat (or the whole form). Empty: the change can be written. */
  errors: Partial<Record<Seat | "form", string>>;
  /** Non-blocking remarks (a day the person does not usually work). */
  notes: string[];
};

const SEAT_NOUN: Record<Seat, string> = { driver: "chauffeur", crewMate: "équipier" };

export function checkRouteCrewChange(input: RouteCrewChangeInput): RouteCrewCheck {
  const { vehicle, current, people, date } = input;
  const ambulance = vehicle.type === "AMBULANCE";
  const next: RouteCrew = { driverId: input.next.driverId, crewMateId: ambulance ? input.next.crewMateId : null };
  const errors: RouteCrewCheck["errors"] = {};
  const notes: string[] = [];
  if (input.remaining === null) return { errors: { form: "Tournée terminée : son équipage ne se change plus." }, notes };
  if (next.driverId === current.driverId && next.crewMateId === (ambulance ? current.crewMateId : null)) {
    return { errors: { form: "Équipage inchangé." }, notes };
  }
  if (next.driverId === null) errors.driver = "Choisissez un chauffeur.";
  if (ambulance && next.crewMateId === null) errors.crewMate = "Une ambulance part à deux : choisissez un équipier.";
  if (next.driverId !== null && next.driverId === next.crewMateId) {
    errors.crewMate = "Le chauffeur et l'équipier doivent être deux personnes différentes.";
  }
  if (Object.keys(errors).length > 0) return { errors, notes };

  const weekday = isoWeekday(date);
  const remaining = input.remaining;
  for (const seat of ["driver", "crewMate"] as const) {
    const id = seat === "driver" ? next.driverId : next.crewMateId;
    if (id === null || id === (seat === "driver" ? current.driverId : current.crewMateId)) continue;
    const person = people.get(id);
    if (!person) {
      errors[seat] = "Personne introuvable : rechargez la page.";
      continue;
    }
    const name = staffName(person);
    const absence = absenceOn(id, date, input.absences);
    const elsewhere = input.otherRoutes.find((route) => route.driverId === id || route.crewMateId === id);
    const required = seatRequirement(vehicle.type, seat) ?? [];
    let problem: string | null = null;
    if (!person.active) problem = `${name} est désactivé.`;
    else if (absence) problem = `${name} : ${planningAbsenceText(absence).toLowerCase()}.`;
    else if (!isQualified(person, vehicle.type, seat)) {
      problem = `${name} n'a pas la qualification requise pour être ${SEAT_NOUN[seat]} (${required.map((q) => QUALIFICATION_LABELS[q]).join(" ou ")}).`;
    } else if (elsewhere) problem = `${name} est déjà sur la tournée de ${elsewhere.vehicleLabel} ce jour.`;
    else if (person.shiftStartMinute > remaining.start || person.shiftEndMinute < remaining.end) {
      problem = `Horaire de ${name} (${shiftText({ start: person.shiftStartMinute, end: person.shiftEndMinute })}) : ne couvre pas la suite de la tournée (${shiftText(remaining)}).`;
    }
    if (problem) errors[seat] = problem;
    else if (!person.workDays.includes(weekday)) {
      notes.push(`${name} ne travaille pas habituellement le ${(WEEKDAY_LABELS[weekday] ?? "").toLowerCase()} : affectation exceptionnelle.`);
    }
  }
  if (Object.keys(errors).length > 0) return { errors, notes };

  const driver = next.driverId ? people.get(next.driverId) : undefined;
  const mate = next.crewMateId ? people.get(next.crewMateId) : undefined;
  if (ambulance && driver && mate) {
    if (areIncompatible(driver.id, mate.id, input.incompatibilities)) {
      errors.crewMate = `${staffName(driver)} et ${staffName(mate)} ne doivent pas travailler ensemble.`;
    } else if (!completesCrew(driver, mate, vehicle.type)) {
      const oneOf = (CREW_REQUIRED_ONE_OF[vehicle.type] ?? []).map((q) => QUALIFICATION_LABELS[q]).join(" ou ");
      errors.crewMate = `Il faut au moins un ${oneOf} dans l'équipage, au volant ou auprès du patient : ni ${staffName(driver)} ni ${staffName(mate)} ne l'est.`;
    }
  }
  return { errors, notes };
}

/** A person offered in « Changer l'équipage », with what the form needs to tell the possible choices. */
export type CrewChoice = {
  id: string;
  /** "NOM Prénom". */
  name: string;
  depotId: string | null;
  canDrive: Record<VehicleType, boolean>;
  canCrew: boolean;
  /** Holds the qualification an ambulance crew needs once (DEA). */
  completesAmbulance: boolean;
  /** Why the person cannot work that day (deactivated, absence: never the private reason), or null. */
  unavailable: string | null;
  /** Vehicle of the route the person is on that day, or null. */
  routeVehicleId: string | null;
  routeVehicleLabel: string | null;
  shift: { start: number; end: number };
  worksThatDay: boolean;
};

const VEHICLE_TYPES: readonly VehicleType[] = ["TAXI", "VSL", "AMBULANCE"];

/**
 * The people « Changer l'équipage » offers on `date`: everyone active, plus
 * whoever is on a route that day (an absent driver stays listed, as the
 * current crew), sorted by name.
 */
export function crewChoices(
  date: string,
  people: readonly StaffPerson[],
  absences: readonly DatedAbsence[],
  routes: readonly ({ vehicleId: string; vehicleLabel: string } & RouteCrew)[],
): CrewChoice[] {
  const weekday = isoWeekday(date);
  const routeOf = new Map<string, { vehicleId: string; vehicleLabel: string }>();
  for (const route of routes) {
    for (const id of [route.driverId, route.crewMateId]) if (id) routeOf.set(id, route);
  }
  const oneOf: readonly string[] = CREW_REQUIRED_ONE_OF.AMBULANCE ?? [];
  return people
    .filter((p) => p.active || routeOf.has(p.id))
    .sort((a, b) => a.lastName.localeCompare(b.lastName, "fr") || a.firstName.localeCompare(b.firstName, "fr"))
    .map((p) => {
      const absence = absenceOn(p.id, date, absences);
      const route = routeOf.get(p.id);
      return {
        id: p.id,
        name: `${p.lastName.toUpperCase()} ${p.firstName}`,
        depotId: p.depotId,
        canDrive: Object.fromEntries(VEHICLE_TYPES.map((t) => [t, isQualified(p, t, "driver")])) as Record<VehicleType, boolean>,
        canCrew: isQualified(p, "AMBULANCE", "crewMate"),
        completesAmbulance: p.qualifications.some((q) => oneOf.includes(q)),
        unavailable: !p.active ? "désactivé" : absence ? planningAbsenceText(absence).toLowerCase() : null,
        routeVehicleId: route?.vehicleId ?? null,
        routeVehicleLabel: route?.vehicleLabel ?? null,
        shift: { start: p.shiftStartMinute, end: p.shiftEndMinute },
        worksThatDay: p.workDays.includes(weekday),
      };
    });
}

/**
 * Why `choice` cannot take `seat` on the route of `vehicle` (the same rules
 * as checkRouteCrewChange, seat by seat: the server checks the pair), or null.
 */
export function choiceProblem(
  choice: CrewChoice,
  seat: Seat,
  vehicle: { id: string; type: VehicleType },
  remaining: { start: number; end: number } | null,
): string | null {
  if (choice.unavailable) return choice.unavailable;
  if (!(seat === "driver" ? choice.canDrive[vehicle.type] : choice.canCrew)) return "non qualifié";
  if (choice.routeVehicleId && choice.routeVehicleId !== vehicle.id) return `sur ${choice.routeVehicleLabel ?? "une autre tournée"}`;
  if (remaining && (choice.shift.start > remaining.start || choice.shift.end < remaining.end)) {
    return `horaire ${shiftText(choice.shift)}`;
  }
  return null;
}
