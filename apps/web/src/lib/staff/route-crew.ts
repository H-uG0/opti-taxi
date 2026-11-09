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
 * with a DEA at the wheel or beside the patient (rules.ts, R. 6312-10) and
 * the shared working time of CrewRules.minPairOverlapMin, so the crew of the
 * day written with the route (DayCrew) resolves without a blocking problem.
 * Pure module, unit-tested; the server action reads the rows and writes.
 */
import type { StopKind, TripStatus, VehicleType } from "@prisma/client";
import { stopState } from "@/lib/domain/stops";
import { CREW_REQUIRED_ONE_OF } from "@/lib/domain/rules";
import { QUALIFICATION_LABELS } from "@/lib/labels";
import { formatDuration, isoWeekday, WEEKDAY_LABELS } from "@/lib/time";
import {
  absenceOn,
  areIncompatible,
  completesCrew,
  DEFAULT_CREW_RULES,
  depotDistanceKm,
  isQualified,
  oneOfNoun,
  planningAbsenceText,
  seatRequirement,
  sharedMinutes,
  shiftText,
  staffName,
  versatility,
  type CrewDepot,
  type CrewRules,
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
  /** Settings of the crews of the day (absent: DEFAULT_CREW_RULES). */
  rules?: Pick<CrewRules, "minPairOverlapMin">;
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
    const pair = pairProblem(driver, mate, vehicle.type, input.rules ?? DEFAULT_CREW_RULES);
    if (areIncompatible(driver.id, mate.id, input.incompatibilities)) {
      errors.crewMate = `${staffName(driver)} et ${staffName(mate)} ne doivent pas travailler ensemble.`;
    } else if (pair) errors.crewMate = pair;
  }
  return { errors, notes };
}

type PairMember = Pick<StaffPerson, "firstName" | "lastName" | "qualifications" | "shiftStartMinute" | "shiftEndMinute">;

/**
 * Why an ambulance pair cannot work together (no DEA in the crew, too little
 * shared working time), or null; the same rules as the crews of the day. Also
 * read by the form, before submitting.
 */
export function pairProblem(
  driver: PairMember,
  mate: PairMember,
  type: VehicleType,
  rules: Pick<CrewRules, "minPairOverlapMin">,
): string | null {
  if (type !== "AMBULANCE") return null;
  if (!completesCrew(driver, mate, type)) {
    return `Il faut au moins un ${oneOfNoun(type)} dans l'équipage, au volant ou auprès du patient : ni ${staffName(driver)} ni ${staffName(mate)} ne l'est.`;
  }
  const shared = sharedMinutes(driver, mate);
  if (shared < rules.minPairOverlapMin) {
    return `${staffName(driver)} et ${staffName(mate)} n'ont que ${formatDuration(shared)} d'horaire commun (${formatDuration(rules.minPairOverlapMin)} au moins, Paramètres).`;
  }
  return null;
}

/** A person offered in « Changer l'équipage », with what the form needs to tell the possible choices. */
export type CrewChoice = {
  id: string;
  /** "NOM Prénom". */
  name: string;
  firstName: string;
  lastName: string;
  depotId: string | null;
  /** The person's depot and where it is (distance to the vehicle's depot), null without one. */
  depot: { name: string; lat: number; lng: number } | null;
  qualifications: StaffPerson["qualifications"];
  /** lib/staff/day-crews versatility: the least versatile are offered first, as in the replacements. */
  versatility: number;
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
  shiftStartMinute: number;
  shiftEndMinute: number;
  worksThatDay: boolean;
};

const VEHICLE_TYPES: readonly VehicleType[] = ["TAXI", "VSL", "AMBULANCE"];

/**
 * The people « Changer l'équipage » offers on `date`: everyone active, plus
 * whoever is on a route that day (an absent driver stays listed, as the
 * current crew), sorted by name (rankChoices sorts them for a vehicle).
 */
export function crewChoices(
  date: string,
  people: readonly StaffPerson[],
  absences: readonly DatedAbsence[],
  routes: readonly ({ vehicleId: string; vehicleLabel: string } & RouteCrew)[],
  depots: readonly CrewDepot[] = [],
): CrewChoice[] {
  const depotOf = new Map(depots.map((d) => [d.id, d]));
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
      const depot = p.depotId ? depotOf.get(p.depotId) : undefined;
      return {
        id: p.id,
        name: `${p.lastName.toUpperCase()} ${p.firstName}`,
        firstName: p.firstName,
        lastName: p.lastName,
        depotId: p.depotId,
        depot: depot ? { name: depot.name, lat: depot.lat, lng: depot.lng } : null,
        qualifications: [...p.qualifications],
        versatility: versatility(p),
        canDrive: Object.fromEntries(VEHICLE_TYPES.map((t) => [t, isQualified(p, t, "driver")])) as Record<VehicleType, boolean>,
        canCrew: isQualified(p, "AMBULANCE", "crewMate"),
        completesAmbulance: p.qualifications.some((q) => oneOf.includes(q)),
        unavailable: !p.active ? "désactivé" : absence ? planningAbsenceText(absence).toLowerCase() : null,
        routeVehicleId: route?.vehicleId ?? null,
        routeVehicleLabel: route?.vehicleLabel ?? null,
        shift: { start: p.shiftStartMinute, end: p.shiftEndMinute },
        shiftStartMinute: p.shiftStartMinute,
        shiftEndMinute: p.shiftEndMinute,
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

/** Straight-line distance from the person's depot to the vehicle's (0: same depot), null without a depot. */
export function choiceDepotKm(choice: Pick<CrewChoice, "depot">, vehicleDepot: { lat: number; lng: number }): number | null {
  return choice.depot ? depotDistanceKm(choice.depot, vehicleDepot) : null;
}

/** Same place: the same depot (positions are those of the Depot rows). */
const SAME_DEPOT_KM = 0.1;

/** "dépôt de Manosque, 66 km" when the person belongs to another depot than the vehicle; "sans dépôt"; null for the same depot. */
export function choiceDepotText(choice: Pick<CrewChoice, "depot">, vehicleDepot: { lat: number; lng: number }): string | null {
  const km = choiceDepotKm(choice, vehicleDepot);
  if (km === null || !choice.depot) return "sans dépôt";
  return km < SAME_DEPOT_KM ? null : `dépôt de ${choice.depot.name}, ${Math.round(km)} km`;
}

/**
 * The choices in the order of the automatic replacements (lib/staff/day-crews):
 * the vehicle's depot first, then the nearest, then the least versatile (a DEA
 * last), then by name; a person without a depot last.
 */
export function rankChoices<T extends Pick<CrewChoice, "depot" | "versatility" | "name">>(
  choices: readonly T[],
  vehicleDepot: { lat: number; lng: number },
): T[] {
  const km = new Map(choices.map((c) => [c, choiceDepotKm(c, vehicleDepot) ?? Number.POSITIVE_INFINITY]));
  const near = (c: T) => (km.get(c) ?? Number.POSITIVE_INFINITY) < SAME_DEPOT_KM;
  return [...choices].sort(
    (a, b) =>
      Number(near(b)) - Number(near(a)) ||
      (km.get(a) ?? 0) - (km.get(b) ?? 0) ||
      a.versatility - b.versatility ||
      a.name.localeCompare(b.name, "fr"),
  );
}
