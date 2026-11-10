import { describe, expect, it } from "vitest";
import { diamondIcon, pixelAt, STOP_ICON_PATTERN, stopIcon, warningIcon } from "./map-icons";

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

  it("draws a warning sign: amber triangle, dark «\u202f!\u202f»", () => {
    const icon = warningIcon(36);
    expect(pixelAt(icon, 18, 16).slice(0, 3)).toEqual([15, 23, 42]); // the bar of the « ! »
    expect(pixelAt(icon, 12, 26).slice(0, 3)).toEqual([251, 191, 36]); // amber inside
    expect(pixelAt(icon, 2, 2)[3]).toBe(0); // outside the triangle
  });
});

describe("stops of a route, by vehicle type", () => {
  const blue = [29, 78, 216];
  it("fills a pick-up with the vehicle's color and a white border; a drop-off is white inside, the color as its border", () => {
    const pickup = stopIcon(30, "TAXI", "#1d4ed8", "PICKUP");
    expect(pixelAt(pickup, 15, 15)).toEqual([...blue, 255]);
    expect(pixelAt(pickup, 15, 1).slice(0, 3)).toEqual([255, 255, 255]);
    const dropoff = stopIcon(30, "TAXI", "#1d4ed8", "DROPOFF");
    expect(pixelAt(dropoff, 15, 15)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(dropoff, 15, 2).slice(0, 3)).toEqual(blue);
  });

  it("tells the type by the shape: a disc for a taxi, a square for a VSL, a cross for an ambulance", () => {
    const taxi = stopIcon(30, "TAXI", "#1d4ed8", "PICKUP");
    const vsl = stopIcon(30, "VSL", "#1d4ed8", "PICKUP");
    const ambulance = stopIcon(30, "AMBULANCE", "#1d4ed8", "PICKUP");
    // Near a corner of the box: inside the square only.
    expect(pixelAt(vsl, 4, 4)[3]).toBe(255);
    expect(pixelAt(taxi, 4, 4)[3]).toBe(0);
    expect(pixelAt(ambulance, 4, 4)[3]).toBe(0);
    // At the end of an arm, on the border of the box: the cross only.
    expect(pixelAt(ambulance, 15, 2)[3]).toBe(255);
    expect(pixelAt(vsl, 15, 2)[3]).toBe(0);
    expect(pixelAt(ambulance, 15, 15)).toEqual([...blue, 255]);
  });

  it("names the images by type, kind and color, as the map's style asks for them", () => {
    expect(STOP_ICON_PATTERN.exec("stop:VSL:DROPOFF:#1d4ed8")?.slice(1)).toEqual(["VSL", "DROPOFF", "#1d4ed8"]);
    expect(STOP_ICON_PATTERN.test("stop:BUS:PICKUP:#1d4ed8")).toBe(false);
  });
});
