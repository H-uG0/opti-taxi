import { describe, expect, it } from "vitest";
import type { VehicleType } from "@prisma/client";
import { exceptionalAmbulanceIssue, isExceptionalAmbulanceTrip, type ExceptionalCandidate } from "./exceptional-ambulance";

const seated: ExceptionalCandidate = {
  status: "PLANNED",
  payer: "CPAM",
  allowedVehicleTypes: ["TAXI", "VSL"],
  assigned: false,
  leftByOptimizer: true,
};

describe("exceptional ambulance for a seated trip", () => {
  it("is offered for a seated CPAM trip the last optimization left unassigned", () => {
    expect(exceptionalAmbulanceIssue(seated)).toBeNull();
    expect(exceptionalAmbulanceIssue({ ...seated, status: "ASSIGNED" })).toBeNull();
  });

  it.each([
    [{ status: "CANCELLED" }, /annulée/],
    [{ status: "PICKED_UP" }, /commencée/],
    [{ allowedVehicleTypes: ["AMBULANCE"] }, /déjà prescrite en ambulance/],
    [{ allowedVehicleTypes: [] }, /transport assis/],
    [{ payer: "PRIVATE", allowedVehicleTypes: ["TAXI"] }, /Assurance maladie/],
    [{ assigned: true }, /non affectée/],
    // Not optimized yet, or added after the last computation: no taxi or VSL was tried.
    [{ leftByOptimizer: false }, /^Optimisez d'abord la journée/],
  ] as const)("is refused for %o", (overrides, message) => {
    expect(exceptionalAmbulanceIssue({ ...seated, ...overrides } as ExceptionalCandidate)).toMatch(message);
  });
});

describe("isExceptionalAmbulanceTrip", () => {
  const types: Record<string, VehicleType> = { amb: "AMBULANCE", vsl: "VSL" };
  const typeOf = (id: string) => types[id];
  const proposed = { exceptionalAmbulanceAt: new Date("2026-11-02T17:00:00Z"), lockedVehicleId: "amb", allowedVehicleTypes: ["TAXI", "VSL"] as VehicleType[] };

  it("holds while the seated trip stays locked on an ambulance", () => {
    expect(isExceptionalAmbulanceTrip(proposed, typeOf)).toBe(true);
  });

  it.each([
    ["not proposed", { exceptionalAmbulanceAt: null }],
    ["unlocked", { lockedVehicleId: null }],
    ["moved to a VSL", { lockedVehicleId: "vsl" }],
    ["prescribed in ambulance since", { allowedVehicleTypes: ["AMBULANCE"] as VehicleType[] }],
  ])("lapses once %s", (_, overrides) => {
    expect(isExceptionalAmbulanceTrip({ ...proposed, ...overrides }, typeOf)).toBe(false);
  });
});
