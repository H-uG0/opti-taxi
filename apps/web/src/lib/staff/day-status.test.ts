import { describe, expect, it } from "vitest";
import type { Qualification } from "@prisma/client";
import { resolveDayCrews, type CrewVehicle, type DayCrewInput, type StaffPerson } from "./day-crews";
import { peopleDay, vehicleDay } from "./day-status";

const TUESDAY = "2026-11-10";

function person(id: string, qualifications: Qualification[], workDays = [1, 2, 3, 4, 5], active = true): StaffPerson {
  return {
    id,
    firstName: id,
    lastName: id.toUpperCase(),
    active,
    workDays,
    qualifications,
    depotId: "dep",
    shiftStartMinute: 360,
    shiftEndMinute: 1080,
  };
}

function vehicle(id: string, type: CrewVehicle["type"], driver: string | null, mate: string | null = null): CrewVehicle {
  return { id, label: id, type, active: true, depotId: "dep", defaultDriverId: driver, defaultCrewMateId: mate };
}

const PEOPLE = [
  person("ana", ["TAXI_CARD"]),
  person("bob", ["TAXI_CARD"]),
  person("sick", ["TAXI_CARD"]),
  person("duty", ["DEA"]),
  person("weekend", ["TAXI_CARD"], [6, 7]),
  person("gone", ["TAXI_CARD"], [1, 2, 3, 4, 5], false),
  person("free", ["AUXILIARY"]),
];

const INPUT: DayCrewInput = {
  date: TUESDAY,
  vehicles: [vehicle("Taxi 1", "TAXI", "ana"), vehicle("Taxi 2", "TAXI", "sick"), vehicle("Taxi 3", "TAXI", "bob"), vehicle("Amb", "AMBULANCE", null)],
  people: PEOPLE,
  absences: [
    { driverId: "sick", kind: "SICK", startDate: "2026-11-09", endDate: "2026-11-12" },
    { driverId: "duty", kind: "ON_CALL", startDate: TUESDAY, endDate: TUESDAY },
  ],
  incompatibilities: [],
  saved: [],
  vehicleUnavailabilities: [{ vehicleId: "Taxi 3", kind: "MAINTENANCE", startDate: TUESDAY, endDate: "2026-11-11" }],
};

const plan = resolveDayCrews(INPUT);
const names = new Map(PEOPLE.map((p) => [p.id, p]));
const crewOf = (id: string) => plan.crews.find((c) => c.vehicleId === id)!;

describe("vehicleDay", () => {
  it("names the crew, a replacement, an outage and a vehicle nobody can take", () => {
    expect(vehicleDay(crewOf("Taxi 1"), TUESDAY, names, INPUT.vehicleUnavailabilities)).toEqual({
      kind: "crew",
      driver: "ANA ana",
      crewMate: null,
      source: "default",
    });
    // Taxi 3 is out of service: its driver bob replaces the absent driver of Taxi 2.
    expect(vehicleDay(crewOf("Taxi 2"), TUESDAY, names)).toMatchObject({ kind: "crew", driver: "BOB bob", source: "replacement" });
    expect(vehicleDay(crewOf("Taxi 3"), TUESDAY, names, INPUT.vehicleUnavailabilities)).toEqual({
      kind: "off",
      text: "Entretien du 10/11/2026 au 11/11/2026",
    });
    expect(vehicleDay(crewOf("Amb"), TUESDAY, names)).toMatchObject({ kind: "missing" });
  });

  it("says when the regulator keeps the vehicle at the depot, or fixed its crew", () => {
    const saved = resolveDayCrews({
      ...INPUT,
      saved: [
        { vehicleId: "Taxi 1", driverId: null, crewMateId: null },
        { vehicleId: "Taxi 2", driverId: "ana", crewMateId: null },
      ],
    });
    const crew = (id: string) => saved.crews.find((c) => c.vehicleId === id)!;
    expect(vehicleDay(crew("Taxi 1"), TUESDAY, names)).toEqual({ kind: "parked" });
    expect(vehicleDay(crew("Taxi 2"), TUESDAY, names)).toMatchObject({ kind: "crew", driver: "ANA ana", source: "fixed" });
  });
});

describe("peopleDay", () => {
  const days = peopleDay(plan, PEOPLE, INPUT.absences);

  it("gives each person's vehicle, absence, rest day or free day", () => {
    expect(days.get("ana")).toEqual({ kind: "vehicle", vehicleId: "Taxi 1", seat: "driver", replacement: false });
    expect(days.get("bob")).toEqual({ kind: "vehicle", vehicleId: "Taxi 2", seat: "driver", replacement: true });
    expect(days.get("weekend")).toEqual({ kind: "rest" });
    expect(days.get("gone")).toEqual({ kind: "inactive" });
    expect(days.get("free")).toEqual({ kind: "free" });
  });

  it("names a duty but never the private reason of an absence", () => {
    expect(days.get("duty")).toEqual({ kind: "absent", text: "Garde le 10/11/2026", label: "Garde", endDate: TUESDAY });
    expect(days.get("sick")).toEqual({ kind: "absent", text: "Absence du 09/11/2026 au 12/11/2026", label: "Absence", endDate: "2026-11-12" });
  });
});
