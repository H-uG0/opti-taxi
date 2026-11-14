import { describe, expect, it } from "vitest";
import { effectiveTargets, fromInputValue, meetsObjective, targetGap, toInputValue, type TargetRow } from "./kpis-targets";
import { SHARING_OBJECTIVE } from "./kpis-sharing";

const rows: TargetRow[] = [
  { indicator: "tripsPerVehicle", depotId: null, reference: 4.5, objective: 5.5 },
  { indicator: "tripsPerVehicle", depotId: "gap", reference: null, objective: 4.5 },
  { indicator: "emptyKmShare", depotId: null, reference: 0.55, objective: 0.45 },
  { indicator: "sharedRate", depotId: null, reference: 0.2, objective: null },
];

describe("effectiveTargets", () => {
  it("reads the depot's own value, else the company's, field by field", () => {
    const gap = effectiveTargets(rows, "gap");
    expect(gap.tripsPerVehicle).toEqual({ reference: 4.5, objective: 4.5, referenceSource: "company", objectiveSource: "depot" });
    expect(effectiveTargets(rows, null).tripsPerVehicle).toMatchObject({ objective: 5.5, objectiveSource: "company" });
    expect(effectiveTargets(rows, "sis").emptyKmShare).toMatchObject({ reference: 0.55, objective: 0.45 });
  });

  it("gives the shared transport the protocol's objective by default, nothing to the others", () => {
    const targets = effectiveTargets(rows, null);
    expect(targets.sharedRate).toEqual({ reference: 0.2, objective: SHARING_OBJECTIVE, referenceSource: "company", objectiveSource: "protocol" });
    expect(targets.lateRate).toEqual({ reference: null, objective: null, referenceSource: null, objectiveSource: null });
  });
});

describe("gaps", () => {
  it("reads better or worse in the indicator's direction", () => {
    expect(targetGap(4, 5.5)).toBe(-1.5);
    expect(targetGap(null, 5.5)).toBeNull();
    expect(meetsObjective("tripsPerVehicle", 6, 5.5)).toBe(true);
    expect(meetsObjective("emptyKmShare", 0.5, 0.45)).toBe(false);
    expect(meetsObjective("emptyKmShare", 0.45, 0.45)).toBe(true);
    expect(meetsObjective("lateRate", 0.01, null)).toBeNull();
  });
});

describe("form values", () => {
  it("types a rate in percent with a decimal comma, and stores it as a fraction", () => {
    expect(toInputValue("rate", 0.305)).toBe("30,5");
    expect(toInputValue("decimal", 4.5)).toBe("4,5");
    expect(toInputValue("minutes", null)).toBe("");
    expect(fromInputValue("rate", 30.5)).toBe(0.305);
    expect(fromInputValue("euros", 12)).toBe(12);
  });
});
