/**
 * Vehicles whose saved route can no longer be driven as planned, or that
 * should not be driven at all on the service date. Pure module, unit-tested;
 * the planning (« À traiter », validation) and /equipages show the same list.
 *
 * Since the crews of the day (lib/staff/day-crews.ts) and the vehicle
 * unavailability (lib/fleet) exist, both can change after the routes were
 * computed: a route keeps the vehicle and the crew it was planned with. They
 * are compared here with the crew plan of the date:
 * - a vehicle deactivated or made unavailable since;
 * - a crew of the day that is no longer complete (blocked);
 * - a driver or crew mate of the route who is now absent or deactivated, or
 *   who is no longer the one of the day's crew (crew changed on /equipages);
 * and, for every vehicle with a route or that could get one (complete crew),
 * an inspection or insurance overdue on the date (DayCrewContext.fleetAlerts):
 * it informs the next optimization; validation only counts it on a vehicle
 * with a route (validation.ts).
 */
import type { VehicleType } from "@prisma/client";
import {
  absenceOn,
  planningAbsenceText,
  staffName,
  type DatedAbsence,
  type DayCrewPlan,
  type StaffPerson,
} from "@/lib/staff/day-crews";

/** The crew saved with a route. */
export type RouteCrewRow = { vehicleId: string; driverId: string | null; crewMateId: string | null };

export type IssueVehicle = { id: string; label: string; type: VehicleType; active: boolean };

export type VehicleIssue = {
  vehicleId: string;
  label: string;
  /** The vehicle has a route that day. */
  hasRoute: boolean;
  /** The route was planned before these changes of vehicle or crew: re-optimize. */
  changes: string[];
  /** Inspection or insurance overdue on the date. */
  compliance: string[];
};

export type VehicleIssuesInput = {
  date: string;
  routes: readonly RouteCrewRow[];
  /** Every vehicle (active or not): a route may be on a vehicle deactivated since. */
  vehicles: readonly IssueVehicle[];
  plan: Pick<DayCrewPlan, "crews">;
  absences: readonly DatedAbsence[];
  people: ReadonlyMap<string, Pick<StaffPerson, "firstName" | "lastName" | "active">>;
  /** DayCrewContext.fleetAlerts. */
  fleetAlerts: ReadonlyMap<string, readonly string[]>;
};

type Seat = "driver" | "crewMate";
const SEAT_NOUN: Record<Seat, string> = { driver: "chauffeur", crewMate: "équipier" };

/** Problems of one seat of a route against the crew of the day. */
function seatMessages(
  seat: Seat,
  routePersonId: string | null,
  dayPersonId: string | null,
  input: Pick<VehicleIssuesInput, "date" | "absences" | "people">,
): string[] {
  const nameOf = (id: string) => {
    const person = input.people.get(id);
    return person ? staffName(person) : "Personne supprimée";
  };
  if (routePersonId === null) {
    return seat === "driver" ? ["Tournée sans chauffeur (compte supprimé depuis le calcul)"] : [];
  }
  const name = nameOf(routePersonId);
  // Who takes the seat in the crew of the day, when someone does.
  const replacement = dayPersonId !== null && dayPersonId !== routePersonId ? ` ; équipage du jour : ${nameOf(dayPersonId)}` : "";
  const absence = absenceOn(routePersonId, input.date, input.absences);
  if (absence) return [`${name} (${SEAT_NOUN[seat]}) : ${planningAbsenceText(absence).toLowerCase()}${replacement}`];
  if (input.people.get(routePersonId)?.active === false) {
    return [`${name} (${SEAT_NOUN[seat]}) : désactivé depuis le calcul${replacement}`];
  }
  if (routePersonId !== dayPersonId) {
    const day = dayPersonId === null ? "personne" : nameOf(dayPersonId);
    return [`${seat === "driver" ? "Chauffeur" : "Équipier"} changé : ${name} sur la tournée, ${day} dans l'équipage du jour`];
  }
  return [];
}

/**
 * One entry per vehicle with something to fix, in the crew plan's display
 * order (vehicles with a route on an inactive vehicle last).
 */
export function vehicleIssues(input: VehicleIssuesInput): VehicleIssue[] {
  const vehicleById = new Map(input.vehicles.map((v) => [v.id, v]));
  const routeByVehicle = new Map(input.routes.map((r) => [r.vehicleId, r]));
  const issues: VehicleIssue[] = [];
  const seen = new Set<string>();

  for (const crew of input.plan.crews) {
    seen.add(crew.vehicleId);
    const route = routeByVehicle.get(crew.vehicleId);
    const label = vehicleById.get(crew.vehicleId)?.label ?? "Véhicule";
    const changes: string[] = [];
    if (route) {
      if (crew.unavailable) {
        changes.push(crew.blocked ?? "Véhicule indisponible");
      } else {
        if (crew.blocked) changes.push(`Équipage du jour incomplet : ${crew.blocked}`);
        changes.push(...seatMessages("driver", route.driverId, crew.driverId, input));
        if (vehicleById.get(crew.vehicleId)?.type === "AMBULANCE") {
          changes.push(...seatMessages("crewMate", route.crewMateId, crew.crewMateId, input));
        }
      }
    }
    // Overdue inspection or insurance: on every vehicle with a route, or that the next optimization may use.
    const compliance = route || crew.blocked === null ? [...(input.fleetAlerts.get(crew.vehicleId) ?? [])] : [];
    if (changes.length + compliance.length > 0) {
      issues.push({ vehicleId: crew.vehicleId, label, hasRoute: route !== undefined, changes: [...new Set(changes)], compliance });
    }
  }

  // Routes on a vehicle the crew plan no longer knows: deactivated (or deleted) since the computation.
  for (const route of input.routes) {
    if (seen.has(route.vehicleId)) continue;
    const vehicle = vehicleById.get(route.vehicleId);
    issues.push({
      vehicleId: route.vehicleId,
      label: vehicle?.label ?? "Véhicule supprimé",
      hasRoute: true,
      changes: ["Véhicule désactivé depuis le calcul"],
      compliance: [],
    });
  }
  return issues;
}
