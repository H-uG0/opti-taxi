import { describe, expect, it } from "vitest";
import { exceptionalAmbulanceIssue, type ExceptionalCandidate } from "./exceptional-ambulance";

const seated: ExceptionalCandidate = { status: "PLANNED", payer: "CPAM", allowedVehicleTypes: ["TAXI", "VSL"], assigned: false };

describe("exceptional ambulance for a seated trip", () => {
  it("is offered for an unassigned seated CPAM trip", () => {
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
  ] as const)("is refused for %o", (overrides, message) => {
    expect(exceptionalAmbulanceIssue({ ...seated, ...overrides } as ExceptionalCandidate)).toMatch(message);
  });
});
