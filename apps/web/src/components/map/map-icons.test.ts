import { describe, expect, it } from "vitest";
import { diamondIcon, pixelAt, warningIcon } from "./map-icons";

describe("map marker images", () => {
  it("draws a filled diamond with a dark border, transparent in the corners", () => {
    const icon = diamondIcon(32, "#b45309", false);
    expect(icon.width).toBe(32);
    expect(icon.data).toHaveLength(32 * 32 * 4);
    expect(pixelAt(icon, 16, 16)).toEqual([180, 83, 9, 255]);
    expect(pixelAt(icon, 0, 0)[3]).toBe(0);
    expect(pixelAt(icon, 31, 31)[3]).toBe(0);
    // The border, near the top point.
    expect(pixelAt(icon, 16, 1).slice(0, 3)).toEqual([15, 23, 42]);
  });

  it("draws a hollow diamond: white inside, the color as its border", () => {
    const icon = diamondIcon(32, "#b45309", true);
    expect(pixelAt(icon, 16, 16)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(icon, 16, 2).slice(0, 3)).toEqual([180, 83, 9]);
  });

  it("draws a warning sign: amber triangle, dark « ! »", () => {
    const icon = warningIcon(36);
    expect(pixelAt(icon, 18, 16).slice(0, 3)).toEqual([15, 23, 42]); // the bar of the « ! »
    expect(pixelAt(icon, 12, 26).slice(0, 3)).toEqual([251, 191, 36]); // amber inside
    expect(pixelAt(icon, 2, 2)[3]).toBe(0); // outside the triangle
  });
});
