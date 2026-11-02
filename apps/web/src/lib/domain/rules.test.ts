import type { SharingScope, SharingStatus, TripDirection } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  allowedVehicleTypesFor,
  DEFAULT_CAPACITY,
  formatAddress,
  initialSharingStatus,
  isShareable,
  REQUIRED_QUALIFICATIONS,
  sharingAllowedFor,
} from "./rules";

describe("allowedVehicleTypesFor", () => {
  it("sends lying patients (ambulance prescription) by ambulance only", () => {
    expect(allowedVehicleTypesFor("AMBULANCE", "CPAM")).toEqual(["AMBULANCE"]);
  });

  it("lets seated patients (TAP) ride a taxi or a VSL", () => {
    expect(allowedVehicleTypesFor("TAP", "CPAM")).toEqual(["TAXI", "VSL"]);
  });

  it("treats a CPAM trip without prescribed mode as TAP", () => {
    expect(allowedVehicleTypesFor(null, "CPAM")).toEqual(["TAXI", "VSL"]);
  });

  it("puts private clients in a taxi whatever the mode", () => {
    expect(allowedVehicleTypesFor(null, "PRIVATE")).toEqual(["TAXI"]);
    expect(allowedVehicleTypesFor("TAP", "PRIVATE")).toEqual(["TAXI"]);
    expect(allowedVehicleTypesFor("AMBULANCE", "PRIVATE")).toEqual(["TAXI"]);
  });

  it("returns a fresh array each time (callers may mutate it)", () => {
    const first = allowedVehicleTypesFor("TAP", "CPAM");
    first.push("AMBULANCE");
    expect(allowedVehicleTypesFor("TAP", "CPAM")).toEqual(["TAXI", "VSL"]);
  });
});

describe("sharingAllowedFor", () => {
  const cases: [SharingScope, TripDirection, boolean][] = [
    ["BOTH", "OUTBOUND", true],
    ["BOTH", "RETURN", true],
    ["OUTBOUND", "OUTBOUND", true],
    ["OUTBOUND", "RETURN", false],
    ["RETURN", "OUTBOUND", false],
    ["RETURN", "RETURN", true],
    ["NONE", "OUTBOUND", false],
    ["NONE", "RETURN", false],
  ];

  it.each(cases)("TAP prescription with scope %s allows sharing on %s: %s", (scope, direction, expected) => {
    expect(sharingAllowedFor(scope, direction, "TAP", "CPAM")).toBe(expected);
  });

  it("never shares an ambulance transport", () => {
    expect(sharingAllowedFor("BOTH", "OUTBOUND", "AMBULANCE", "CPAM")).toBe(false);
    expect(sharingAllowedFor("BOTH", "RETURN", "AMBULANCE", "CPAM")).toBe(false);
  });

  it("never shares a private client", () => {
    expect(sharingAllowedFor("BOTH", "OUTBOUND", "TAP", "PRIVATE")).toBe(false);
    expect(sharingAllowedFor(null, "RETURN", null, "PRIVATE")).toBe(false);
  });

  it("needs a prescription (scope and mode) to share", () => {
    expect(sharingAllowedFor(null, "OUTBOUND", "TAP", "CPAM")).toBe(false);
    expect(sharingAllowedFor("BOTH", "OUTBOUND", null, "CPAM")).toBe(false);
  });
});

describe("initialSharingStatus", () => {
  it("starts eligible trips as not proposed and the others as not eligible", () => {
    expect(initialSharingStatus(true)).toBe("NOT_PROPOSED");
    expect(initialSharingStatus(false)).toBe("NOT_ELIGIBLE");
  });
});

describe("isShareable", () => {
  const statuses: [SharingStatus, boolean][] = [
    ["NOT_PROPOSED", true],
    ["PROPOSED", true],
    ["ACCEPTED", true],
    ["REFUSED", false],
    ["NOT_ELIGIBLE", false],
  ];

  it.each(statuses)("an allowed trip with status %s is shareable: %s", (sharingStatus, expected) => {
    expect(isShareable({ sharingAllowed: true, sharingStatus })).toBe(expected);
  });

  it("never shares a trip whose prescription forbids it, even if marked accepted", () => {
    for (const [sharingStatus] of statuses) {
      expect(isShareable({ sharingAllowed: false, sharingStatus })).toBe(false);
    }
  });

  it("honours a patient's refusal (traced on the trip)", () => {
    expect(isShareable({ sharingAllowed: true, sharingStatus: "REFUSED" })).toBe(false);
  });
});

describe("vehicle constants", () => {
  it("carries 2 patients in a taxi or VSL and 1 in an ambulance", () => {
    expect(DEFAULT_CAPACITY).toEqual({ TAXI: 2, VSL: 2, AMBULANCE: 1 });
  });

  it("requires a taxi card for taxis and a qualified crew of two for ambulances", () => {
    expect(REQUIRED_QUALIFICATIONS.TAXI.driver).toContain("TAXI_CARD");
    expect(REQUIRED_QUALIFICATIONS.TAXI.crewMate).toBeNull();
    expect(REQUIRED_QUALIFICATIONS.VSL.driver).toEqual(expect.arrayContaining(["AUXILIARY", "DEA"]));
    expect(REQUIRED_QUALIFICATIONS.VSL.crewMate).toBeNull();
    expect(REQUIRED_QUALIFICATIONS.AMBULANCE.driver).toEqual(["DEA"]);
    expect(REQUIRED_QUALIFICATIONS.AMBULANCE.crewMate).toEqual(expect.arrayContaining(["AUXILIARY", "DEA"]));
  });
});

describe("formatAddress", () => {
  it("joins street, postal code and city the French way", () => {
    expect(formatAddress({ address: "12 rue des Lilas", postalCode: "04100", city: "Manosque" })).toBe(
      "12 rue des Lilas, 04100 Manosque",
    );
  });
});
