import { describe, expect, it } from "vitest";
import type { Qualification, VehicleType } from "@prisma/client";
import {
  crewQualificationErrors,
  otherSeats,
  plannedSeatCount,
  qualificationScope,
  seatsByPerson,
  sharedCrewWarning,
  type CrewSeat,
} from "./crew";

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
    // The other vehicle is not left out: it gets a replacement (crews of the day).
    expect(sharedCrewWarning("Anna Roux", [{ vehicleId: "v2", label: "VSL 2", role: "driver" }])).toBe(
      "Anna Roux est déjà chauffeur par défaut de « VSL 2 » : une personne ne roule que sur un véhicule par jour, l'autre recevra un remplaçant s'il y en a un de libre (page Équipages).",
    );
  });

  it("lists several vehicles", () => {
    const others: CrewSeat[] = [
      { vehicleId: "v2", label: "VSL 2", role: "driver" },
      { vehicleId: "a1", label: "Ambulance 1", role: "crewMate" },
    ];
    expect(sharedCrewWarning("Anna Roux", others)).toBe(
      "Anna Roux est déjà chauffeur par défaut de « VSL 2 » et équipier de « Ambulance 1 » : une personne ne roule que sur un véhicule par jour, les autres recevront un remplaçant s'il y en a un de libre (page Équipages).",
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

describe("crewQualificationErrors", () => {
  const member = (firstName: string, qualifications: Qualification[]) => ({
    firstName,
    lastName: "Roux",
    qualifications,
  });

  it("accepts an auxiliary at the wheel of an ambulance with a DEA crew mate (R. 6312-10)", () => {
    expect(crewQualificationErrors("AMBULANCE", member("Inès", ["AUXILIARY"]), member("Laurent", ["DEA"]))).toEqual({});
    expect(crewQualificationErrors("AMBULANCE", member("Laurent", ["DEA"]), member("Inès", ["AUXILIARY"]))).toEqual({});
    expect(crewQualificationErrors("AMBULANCE", member("Inès", ["AUXILIARY"]), null)).toEqual({});
  });

  it("refuses an ambulance crew without any DEA, on the crew mate field", () => {
    expect(crewQualificationErrors("AMBULANCE", member("Inès", ["AUXILIARY"]), member("Paul", ["AUXILIARY", "TAXI_CARD"]))).toEqual({
      defaultCrewMateId:
        "Il faut au moins un ambulancier DE dans l'équipage d'ambulance, au volant ou auprès du patient : ni Inès Roux ni Paul Roux ne l'est.",
    });
  });

  it("still checks each seat first", () => {
    expect(crewQualificationErrors("AMBULANCE", member("Julien", ["TAXI_CARD"]), member("Laurent", ["DEA"]))).toEqual({
      defaultDriverId:
        "Julien Roux n'a pas la qualification requise pour conduire une ambulance (Auxiliaire ambulancier ou Ambulancier DE).",
    });
    expect(crewQualificationErrors("VSL", member("Julien", ["TAXI_CARD"]), null).defaultDriverId).toMatch(/conduire un VSL/);
  });
});

describe("qualificationScope", () => {
  it("says what each qualification allows, the DEA rule included", () => {
    expect(qualificationScope("TAXI_CARD")).toBe("Conduite : taxi");
    expect(qualificationScope("AUXILIARY")).toBe(
      "Conduite : VSL, ambulance · Équipier : ambulance · En ambulance, avec un ambulancier DE",
    );
    expect(qualificationScope("DEA")).toBe("Conduite : VSL, ambulance · Équipier : ambulance · Au moins un dans chaque équipage d'ambulance");
  });
});
