// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { AUTO_SCROLL_EDGE_PX, AUTO_SCROLL_MAX_PX, autoScrollStep, dropRowIdOf } from "./drag";

describe("autoScrollStep", () => {
  it("scrolls up near the top, down near the bottom, faster at the edge, never elsewhere", () => {
    expect(autoScrollStep(500, 100, 900)).toBe(0);
    expect(autoScrollStep(100, 100, 900)).toBe(-AUTO_SCROLL_MAX_PX);
    expect(autoScrollStep(900, 100, 900)).toBe(AUTO_SCROLL_MAX_PX);
    const near = autoScrollStep(900 - AUTO_SCROLL_EDGE_PX / 2, 100, 900);
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(AUTO_SCROLL_MAX_PX);
    // Outside the box: the pointer left it, nothing scrolls.
    expect(autoScrollStep(50, 100, 900)).toBe(0);
    expect(autoScrollStep(950, 100, 900)).toBe(0);
  });

  it("starts the top band below the pinned rows", () => {
    expect(autoScrollStep(100 + 60 + AUTO_SCROLL_EDGE_PX + 1, 100, 900, 60)).toBe(0);
    expect(autoScrollStep(100 + 60, 100, 900, 60)).toBe(-AUTO_SCROLL_MAX_PX);
    // Over the pinned rows themselves (the « À placer » drop zone): still.
    expect(autoScrollStep(100 + 30, 100, 900, 60)).toBe(0);
    expect(autoScrollStep(100, 100, 900, 60)).toBe(0);
  });
});

describe("dropRowIdOf", () => {
  it("names the row of a vehicle, « À placer », or nothing", () => {
    document.body.innerHTML = `
      <div data-pinned-row><button id="pinned"></button></div>
      <div data-vehicle-id="taxi-1"><span><button id="trip"></button></span></div>
      <div data-depot-header><button id="header"></button></div>`;
    expect(dropRowIdOf(document.getElementById("trip"), "a-placer")).toBe("taxi-1");
    expect(dropRowIdOf(document.getElementById("pinned"), "a-placer")).toBe("a-placer");
    expect(dropRowIdOf(document.getElementById("header"), "a-placer")).toBeUndefined();
    expect(dropRowIdOf(null, "a-placer")).toBeUndefined();
  });
});
