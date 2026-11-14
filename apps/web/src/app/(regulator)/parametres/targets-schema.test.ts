import { describe, expect, it } from "vitest";
import { targetChanges, targetsFormValues, targetsSchema, toTargetRows } from "./targets-schema";

describe("targets form", () => {
  it("reads rates in percent with a comma, blanks as no value", () => {
    const parsed = targetsSchema().safeParse({ "sharedRate-objective": "30,5", "tripsPerVehicle-reference": "4,2", "planningMinutes-objective": "" });
    expect(parsed.success).toBe(true);
    const rows = toTargetRows(parsed.success ? parsed.data : {}, "gap");
    expect(rows).toEqual([
      { indicator: "tripsPerVehicle", depotId: "gap", reference: 4.2, objective: null },
      { indicator: "sharedRate", depotId: "gap", reference: null, objective: 0.305 },
    ]);
  });

  it("refuses a rate over 100 % and a text", () => {
    const parsed = targetsSchema().safeParse({ "lateRate-objective": "150", "marginPerTrip-objective": "dix" });
    expect(parsed.success).toBe(false);
    const fields = parsed.success ? [] : parsed.error.issues.map((issue) => issue.path[0]);
    expect(fields).toEqual(expect.arrayContaining(["lateRate-objective", "marginPerTrip-objective"]));
  });

  it("shows the stored values of a scope and traces what changed", () => {
    const stored = [
      { indicator: "sharedRate", depotId: null, reference: 0.2, objective: 0.3 },
      { indicator: "sharedRate", depotId: "gap", reference: null, objective: 0.4 },
    ];
    expect(targetsFormValues(stored, null)).toMatchObject({ "sharedRate-reference": "20", "sharedRate-objective": "30", "lateRate-objective": "" });
    expect(targetsFormValues(stored, "gap")).toMatchObject({ "sharedRate-reference": "", "sharedRate-objective": "40" });
    expect(targetChanges([stored[0]!], [{ indicator: "sharedRate", depotId: null, reference: 0.2, objective: 0.35 }])).toEqual({
      "sharedRate.objective": { from: "0,3", to: "0,35" },
    });
    expect(targetChanges([stored[0]!], [stored[0]!])).toEqual({});
  });
});
