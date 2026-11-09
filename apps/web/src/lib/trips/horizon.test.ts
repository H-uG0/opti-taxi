import { describe, expect, it } from "vitest";
import { horizonOf, inHorizon, writableRange } from "./horizon";

describe("trip horizon", () => {
  it("runs from tomorrow to D+N", () => {
    expect(horizonOf("2026-11-09", 14)).toEqual({ from: "2026-11-10", to: "2026-11-23" });
    expect(horizonOf("2026-11-09", 0)).toEqual({ from: "2026-11-10", to: "2026-11-10" });
  });

  it("tells whether a date is in it, both ends included", () => {
    const horizon = horizonOf("2026-11-09", 14);
    expect(["2026-11-09", "2026-11-10", "2026-11-23", "2026-11-24"].map((d) => inHorizon(d, horizon))).toEqual([false, true, true, false]);
  });

  it("never writes before tomorrow", () => {
    expect(writableRange({ from: "2026-11-09", to: "2026-11-15" }, "2026-11-10")).toEqual({ from: "2026-11-10", to: "2026-11-15" });
    expect(writableRange({ from: "2026-11-12", to: "2026-11-15" }, "2026-11-10")).toEqual({ from: "2026-11-12", to: "2026-11-15" });
    expect(writableRange({ from: "2026-11-02", to: "2026-11-08" }, "2026-11-10")).toBeNull();
  });
});
