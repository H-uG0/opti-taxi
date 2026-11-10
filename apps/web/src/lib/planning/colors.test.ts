import { describe, expect, it } from "vitest";
import { DISPLAY_PALETTE, displayColors, hexToRgb, readableTextColor, relativeLuminance } from "./colors";

describe("display colors of the vehicles shown", () => {
  it("gives the vehicles shown distinct colors in display order, and repeats the palette beyond it", () => {
    const ids = Array.from({ length: 14 }, (_, i) => `v${i}`);
    const colors = displayColors(ids);
    expect(new Set(ids.slice(0, DISPLAY_PALETTE.length).map((id) => colors.get(id))).size).toBe(DISPLAY_PALETTE.length);
    expect(colors.get("v0")).toBe(DISPLAY_PALETTE[0]);
    expect(colors.get("v12")).toBe(DISPLAY_PALETTE[0]);
    // Neighbours never share a color.
    for (let i = 1; i < ids.length; i++) expect(colors.get(ids[i]!)).not.toBe(colors.get(ids[i - 1]!));
  });

  it("colors the selected vehicle shown outside the filter after the others, without recoloring them", () => {
    const before = displayColors(["a", "b"]);
    const after = displayColors(["a", "b"], "z");
    expect(after.get("a")).toBe(before.get("a"));
    expect(after.get("b")).toBe(before.get("b"));
    expect(after.get("z")).toBe(DISPLAY_PALETTE[2]);
    expect(displayColors(["a"], "a").size).toBe(1);
  });

  it("keeps red and amber for problems and trips without a vehicle", () => {
    for (const color of DISPLAY_PALETTE) {
      const [r, g, b] = hexToRgb(color);
      // Neither red (#dc2626, the old ambulance color and the alerts) nor amber / orange.
      expect(r > 150 && g < 120 && b < 120).toBe(false);
      expect(r > 180 && g > 100 && b < 60).toBe(false);
    }
  });

  it("writes the text in white or dark, whichever reads better", () => {
    expect(readableTextColor("#1e3a8a")).toBe("#ffffff");
    expect(readableTextColor("#fde68a")).toBe("#0f172a");
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1);
    expect(relativeLuminance("#000000")).toBe(0);
  });
});
