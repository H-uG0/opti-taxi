import { describe, expect, it } from "vitest";
import { VEHICLE_TYPE_HEX } from "@/components/ui/badge";
import { DISPLAY_PALETTE, displayColors, hexToRgb, readableTextColor, relativeLuminance } from "./colors";

/** Hue (degrees) and saturation (0 to 1, HSL) of a hex color. */
function hueAndSaturation(hex: string): { hue: number; saturation: number } {
  const [r, g, b] = hexToRgb(hex).map((c) => c / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return { hue: 0, saturation: 0 };
  const saturation = delta / (1 - Math.abs(max + min - 1));
  const hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { hue: (hue * 60 + 360) % 360, saturation };
}

/** Red, orange, amber or brown: hues from 345° to 45°, unless greyish. */
const redOrAmber = (hex: string) => {
  const { hue, saturation } = hueAndSaturation(hex);
  return saturation > 0.3 && (hue <= 45 || hue >= 345);
};

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

  it("keeps red and amber for problems and trips without a vehicle, and leaves the type colors alone", () => {
    // The check itself: the map's trips without a vehicle (amber-700), the alerts' red, the taxi's amber, a brown.
    for (const hex of ["#b45309", "#dc2626", "#c27c0e", "#92400e", "#be123c", "#f59e0b"]) expect(redOrAmber(hex)).toBe(true);
    for (const color of DISPLAY_PALETTE) {
      expect(redOrAmber(color), color).toBe(false);
      expect(Object.values(VEHICLE_TYPE_HEX).map((c) => c.toLowerCase())).not.toContain(color);
    }
  });

  it("writes the text in white or dark, whichever reads better", () => {
    expect(readableTextColor("#1e3a8a")).toBe("#ffffff");
    expect(readableTextColor("#fde68a")).toBe("#0f172a");
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1);
    expect(relativeLuminance("#000000")).toBe(0);
  });
});
