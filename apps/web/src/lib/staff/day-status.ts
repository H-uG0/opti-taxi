/**
 * What a vehicle or a person does on a given day, from the crews of the day
 * (resolveDayCrews): the « Demain » column of the Véhicules and Chauffeurs
 * lists. A person's absence says only what the planning may say
 * (planningAbsenceText: « Garde », « Formation », else « Absence »), never a
 * private reason. Pure module.
 */
import { unavailabilityOn, unavailabilityText, type DatedVehicleUnavailability } from "@/lib/fleet/availability";
import { isoWeekday } from "@/lib/time";
import type { DayCrewPlan, DayCrewView, DatedAbsence, Seat, StaffPerson } from "./day-crews";
import { absenceOn, planningAbsenceLabel, planningAbsenceText, staffName } from "./day-crews";

export type VehicleDay =
  /** Out of service: « Entretien du … au … », « Garde le … ». */
  | { kind: "off"; text: string }
  /** Kept at the depot by the regulator. */
  | { kind: "parked" }
  /** Not planned: nobody to drive, or another blocking problem (the message of the crews of the day). */
  | { kind: "missing"; text: string }
  | {
      kind: "crew";
      driver: string;
      crewMate: string | null;
      /** The usual (default) crew, a replacement the tool proposes on a seat, or a crew the regulator fixed for that day. */
      source: "default" | "replacement" | "fixed";
    };

/** `outages`: the vehicles' unavailability (the input of the crews of the day), for the reason and the dates. */
export function vehicleDay(
  crew: DayCrewView,
  date: string,
  people: ReadonlyMap<string, Pick<StaffPerson, "firstName" | "lastName">>,
  outages: readonly DatedVehicleUnavailability[] = [],
): VehicleDay {
  if (crew.unavailable) {
    const outage = unavailabilityOn(crew.vehicleId, date, outages);
    return { kind: "off", text: outage ? unavailabilityText(outage) : "Indisponible" };
  }
  if (crew.parked) return { kind: "parked" };
  const name = (id: string | null) => {
    const person = id ? people.get(id) : undefined;
    return person ? staffName(person) : null;
  };
  const driver = name(crew.driverId);
  if (crew.blocked !== null || !driver) return { kind: "missing", text: crew.blocked ?? "Aucun chauffeur disponible" };
  return {
    kind: "crew",
    driver,
    crewMate: name(crew.crewMateId),
    source: crew.proposedSeats.length > 0 || crew.source === "replacement" ? "replacement" : crew.source === "saved" ? "fixed" : "default",
  };
}

export type PersonDay =
  | { kind: "inactive" }
  /**
   * « Absence du … au … », « Garde le … », « Formation le … » (text), the
   * word alone (label: « Absence », « Garde », « Formation ») and the last day.
   */
  | { kind: "absent"; text: string; label: string; endDate: string }
  | { kind: "vehicle"; vehicleId: string; seat: Seat; replacement: boolean }
  /** Works that day, available, without a seat. */
  | { kind: "free" }
  /** Does not usually work that weekday. */
  | { kind: "rest" };

/** The day of every person, by id. */
export function peopleDay(
  plan: Pick<DayCrewPlan, "date" | "crews">,
  people: readonly Pick<StaffPerson, "id" | "active" | "workDays">[],
  absences: readonly DatedAbsence[],
): Map<string, PersonDay> {
  const seatOf = new Map<string, { vehicleId: string; seat: Seat; replacement: boolean }>();
  for (const crew of plan.crews) {
    if (crew.unavailable) continue;
    for (const [seat, id] of [
      ["driver", crew.driverId],
      ["crewMate", crew.crewMateId],
    ] as const) {
      if (id && !seatOf.has(id)) seatOf.set(id, { vehicleId: crew.vehicleId, seat, replacement: crew.proposedSeats.includes(seat) });
    }
  }
  const weekday = isoWeekday(plan.date);
  const days = new Map<string, PersonDay>();
  for (const person of people) {
    const absence = absenceOn(person.id, plan.date, absences);
    const seat = seatOf.get(person.id);
    if (!person.active) days.set(person.id, { kind: "inactive" });
    else if (absence) {
      days.set(person.id, { kind: "absent", text: planningAbsenceText(absence), label: planningAbsenceLabel(absence.kind), endDate: absence.endDate });
    }
    else if (seat) days.set(person.id, { kind: "vehicle", ...seat });
    else days.set(person.id, { kind: person.workDays.includes(weekday) ? "free" : "rest" });
  }
  return days;
}
