import { describe, expect, it } from "vitest";
import { crewHoldsRequired, REQUIRED_QUALIFICATIONS } from "@/lib/domain/rules";
import { area, DEPOTS, FLEET_DEPOTS, REPLACEMENT_DRIVER_DEPOTS, VEHICLES, type FleetDepotKey } from "./data";
import { drawRegistration, FLEET_VEHICLE_MIX, planFleet, planFleetAbsences, planFleetPatients } from "./fleet";
import { NameFactory, STAFF_FIRST_NAMES } from "./identity";
import { hubOf } from "./one-off";
import { Rng } from "./random";

const labels = Object.fromEntries(
  Object.entries({ ...DEPOTS, ...FLEET_DEPOTS }).map(([key, def]) => [key, def.label]),
) as Record<FleetDepotKey, string>;
const replacements: Partial<Record<FleetDepotKey, number>> = {};
for (const depot of Object.values(REPLACEMENT_DRIVER_DEPOTS)) if (depot) replacements[depot] = (replacements[depot] ?? 0) + 1;

function plan(seed = 1) {
  return planFleet(
    new Rng(seed),
    new NameFactory(new Rng(seed + 1), [], { firstNames: STAFF_FIRST_NAMES, extended: true }),
    { vehicles: VEHICLES, replacements, registrations: VEHICLES.map((v) => v.registration) },
    labels,
    { TAXI: 5, VSL: 5, AMBULANCE: 3 },
  );
}

describe("large fleet", () => {
  it("reaches 120 vehicles on 6 depots, 50 / 35 / 15 %, with the small data set's vehicles", () => {
    const totals = { TAXI: 0, VSL: 0, AMBULANCE: 0 };
    for (const mix of Object.values(FLEET_VEHICLE_MIX)) for (const [type, n] of Object.entries(mix)) totals[type as keyof typeof totals] += n;
    expect(totals).toEqual({ TAXI: 60, VSL: 42, AMBULANCE: 18 });
    const { vehicles } = plan();
    expect(vehicles.length + VEHICLES.length).toBe(120);
    const marseille = [...VEHICLES, ...vehicles].filter((v) => v.depot === "marseille").length;
    expect(marseille).toBe(36); // 30 %, as fleet_day
    expect(new Set(vehicles.map((v) => v.depot)).size).toBe(6);
  });

  it("gives about 150 people in total, each crew qualified (an ambulance holds a DE whoever drives)", () => {
    const { people, vehicles } = plan();
    expect(people.length + 14).toBeGreaterThanOrEqual(145);
    expect(people.length + 14).toBeLessThanOrEqual(155);
    for (const vehicle of vehicles) {
      const driver = people[vehicle.driver];
      const mate = vehicle.crewMate === null ? null : people[vehicle.crewMate];
      const required = REQUIRED_QUALIFICATIONS[vehicle.type];
      expect(driver?.qualifications.some((q) => (required.driver as readonly string[]).includes(q))).toBe(true);
      if (vehicle.type === "AMBULANCE") {
        expect(mate).toBeTruthy();
        expect(mate?.shift).toEqual(driver?.shift);
        expect(crewHoldsRequired("AMBULANCE", [driver?.qualifications ?? [], mate?.qualifications ?? []])).toBe(true);
      } else expect(mate).toBeNull();
    }
  });

  it("numbers the vehicles after the small data set's, with unique registrations and staggered shifts", () => {
    const { vehicles } = plan();
    expect(vehicles.some((v) => v.label === "Taxi 5 (Marseille)")).toBe(true);
    expect(vehicles.some((v) => v.label === "Ambulance 3 (Marseille)")).toBe(true);
    const plates = [...VEHICLES.map((v) => v.registration), ...vehicles.map((v) => v.registration)];
    expect(new Set(plates).size).toBe(plates.length);
    expect(new Set(plan().people.map((p) => p.shift.join("-"))).size).toBeGreaterThanOrEqual(4);
    expect(plan(1)).toEqual(plan(1));
  });

  it("draws registrations in the French format, never one already taken", () => {
    const taken = new Set(["AB-123-CD"]);
    const plate = drawRegistration(new Rng(1), taken);
    expect(plate).toMatch(/^[A-HJ-NP-TV-Z]{2}-\d{3}-[A-HJ-NP-TV-Z]{2}$/);
    expect(taken.has(plate)).toBe(true);
  });

  it("plans leaves, sick days, training, on-call duty and vehicles off the road without overlapping a person's days", () => {
    const { people, vehicles } = plan();
    const { absences, unavailabilities } = planFleetAbsences(new Rng(4), people, vehicles);
    const kinds = new Set(absences.map((a) => a.kind));
    expect(kinds.has("ON_CALL")).toBe(true);
    expect(kinds.has("LEAVE") || kinds.has("SICK")).toBe(true);
    expect(unavailabilities.some((u) => u.kind === "ON_CALL" && vehicles[u.vehicle]?.type === "AMBULANCE")).toBe(true);
    expect(absences.filter((a) => a.kind === "SICK").every((a) => a.note === null)).toBe(true);
    const days = new Map<number, Set<number>>();
    for (const a of absences) {
      for (let d = a.from; d <= a.to; d++) {
        const set = days.get(a.person) ?? new Set<number>();
        expect(set.has(d)).toBe(false);
        set.add(d);
        days.set(a.person, set);
      }
    }
  });

  it("plans patients of the series in the proportions of fleet_day: about 12 % lying, 80 % shareable, many treated away from home", () => {
    const patients = planFleetPatients(new Rng(6), 400, (key) => hubOf(area(key).town));
    const share = (predicate: (p: (typeof patients)[number]) => boolean) => patients.filter(predicate).length / patients.length;
    expect(share((p) => p.mobility === "LYING")).toBeGreaterThan(0.07);
    expect(share((p) => p.mobility === "LYING")).toBeLessThan(0.17);
    expect(share((p) => p.sharing !== "NONE")).toBeGreaterThan(0.72);
    expect(share((p) => p.treatment === "RADIOTHERAPY" && (p.facility === "radiotherapyMarseille" || p.facility === "radiotherapyGrenoble"))).toBeGreaterThan(0.2);
    for (const p of patients) {
      if (p.treatment === "DIALYSIS") expect([[1, 3, 5], [2, 4, 6]]).toContainEqual(p.weekdays);
      expect(p.appointment % 15).toBe(0);
    }
  });
});
