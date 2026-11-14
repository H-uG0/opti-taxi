import { describe, expect, it } from "vitest";
import { lateLabel, lateThreshold } from "./format";

describe("lateness wording", () => {
  it("says « après l'heure du RDV » without tolerance, as the select does", () => {
    expect(lateThreshold(0)).toBe("après l'heure du RDV");
    expect(lateLabel(0)).toBe("Retards (après l'heure du RDV)");
  });

  it("gives the tolerance in minutes otherwise", () => {
    expect(lateThreshold(5)).toBe("plus de 5 min après le RDV");
    expect(lateLabel(10)).toBe("Retards (> 10 min)");
  });
});
