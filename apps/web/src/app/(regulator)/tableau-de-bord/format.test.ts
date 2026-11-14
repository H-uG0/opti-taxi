import { describe, expect, it } from "vitest";
import { gapVerdict, lateLabel, lateThreshold } from "./format";

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

describe("gapVerdict", () => {
  it("reads the gap as it is shown: « 0 € » is neither missed nor beaten", () => {
    expect(gapVerdict("euros", true, -0.4)).toBe("even");
    expect(gapVerdict("euros", true, -0.6)).toBe("worse");
    expect(gapVerdict("rate", true, 0.0004)).toBe("even");
    expect(gapVerdict("rate", true, 0.0006)).toBe("better");
    expect(gapVerdict("rate", false, 0.02)).toBe("worse");
    expect(gapVerdict("decimal", true, -0.04)).toBe("even");
    expect(gapVerdict("minutes", false, -3)).toBe("better");
  });
});
