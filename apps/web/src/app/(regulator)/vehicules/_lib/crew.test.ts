import { describe, expect, it } from "vitest";
import type { VehicleType } from "@prisma/client";
import { otherSeats, plannedSeatCount, seatsByPerson, sharedCrewWarning, type CrewSeat } from "./crew";

function vehicle(
  id: string,
  type: VehicleType,
  defaultDriverId: string | null,
  defaultCrewMateId: string | null = null,
  active = true,
) {
  return { id, label: id.toUpperCase(), type, active, defaultDriverId, defaultCrewMateId };
}

describe("seatsByPerson", () => {
  it("lists the active vehicles of each person, crew mates on ambulances only", () => {
    const seats = seatsByPerson([
      vehicle("vsl1", "VSL", "anna"),
      vehicle("amb1", "AMBULANCE", "bruno", "anna"),
      // Stale crew mate on a taxi: ignored, as in the optimisation request.
      vehicle("taxi1", "TAXI", "carl", "bruno"),
      // Inactive vehicle: not planned, ignored.
      vehicle("vsl2", "VSL", "anna", null, false),
    ]);
    expect(seats.get("anna")).toEqual([
      { vehicleId: "vsl1", label: "VSL1", role: "driver" },
      { vehicleId: "amb1", label: "AMB1", role: "crewMate" },
    ]);
    expect(seats.get("bruno")).toEqual([{ vehicleId: "amb1", label: "AMB1", role: "driver" }]);
    expect(seats.get("carl")).toHaveLength(1);
  });
});

describe("otherSeats", () => {
  const seats = seatsByPerson([vehicle("vsl1", "VSL", "anna"), vehicle("vsl2", "VSL", "anna"), vehicle("vsl3", "VSL", "bob")]);

  it("leaves out the vehicle being looked at", () => {
    expect(otherSeats(seats, "anna", "vsl1")).toEqual([{ vehicleId: "vsl2", label: "VSL2", role: "driver" }]);
    expect(otherSeats(seats, "bob", "vsl3")).toEqual([]);
  });

  it("handles a missing or unknown person", () => {
    expect(otherSeats(seats, null, "vsl1")).toEqual([]);
    expect(otherSeats(seats, "nobody", "vsl1")).toEqual([]);
  });
});

describe("sharedCrewWarning", () => {
  it("is null without another vehicle", () => {
    expect(sharedCrewWarning("Anna Roux", [])).toBeNull();
  });

  it("names the other vehicle and the role held there", () => {
    expect(sharedCrewWarning("Anna Roux", [{ vehicleId: "v2", label: "VSL 2", role: "driver" }])).toBe(
      "Anna Roux est déjà chauffeur par défaut de « VSL 2 » : un seul des deux véhicules pourra être planifié chaque jour.",
    );
  });

  it("lists several vehicles", () => {
    const others: CrewSeat[] = [
      { vehicleId: "v2", label: "VSL 2", role: "driver" },
      { vehicleId: "a1", label: "Ambulance 1", role: "crewMate" },
    ];
    expect(sharedCrewWarning("Anna Roux", others)).toBe(
      "Anna Roux est déjà chauffeur par défaut de « VSL 2 » et équipier de « Ambulance 1 » : un seul des 3 véhicules pourra être planifié chaque jour.",
    );
  });
});

describe("plannedSeatCount", () => {
  it("counts active vehicles, crew mate seats on ambulances only", () => {
    expect(
      plannedSeatCount(
        [{ active: true }, { active: false }],
        [
          { active: true, type: "AMBULANCE" },
          { active: true, type: "TAXI" },
          { active: false, type: "AMBULANCE" },
        ],
      ),
    ).toBe(2);
    expect(plannedSeatCount([], [])).toBe(0);
  });
});
