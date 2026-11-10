import { describe, expect, it } from "vitest";
import { hexToRgb, shade, vehicleShade } from "./colors";
import { coPassengers, computeTimeRange, DEFAULT_TIME_RANGE, percentOf } from "./timeline";

type Kind = "PICKUP" | "DROPOFF";
const stop = (sequence: number, tripId: string, kind: Kind, arrival: number, start: number, loadAfter: number) => ({
  sequence,
  tripId,
  kind,
  arrivalMinute: arrival,
  startMinute: start,
  departureMinute: start + 5,
  loadAfter,
});

describe("computeTimeRange", () => {
  it("falls back to 05:00–21:00 without data", () => {
    expect(computeTimeRange([])).toEqual(DEFAULT_TIME_RANGE);
    expect(computeTimeRange([{ shift: null, route: null }])).toEqual(DEFAULT_TIME_RANGE);
  });

  it("covers shifts and routes, aligned on hours, at least 6 hours wide", () => {
    expect(
      computeTimeRange([
        { shift: { start: 375, end: 1110 }, route: null },
        { shift: null, route: { startMinute: 350, endMinute: 1130, stops: [] } },
      ]),
    ).toEqual({ start: 300, end: 1140 });
    expect(computeTimeRange([{ shift: { start: 600, end: 700 }, route: null }])).toEqual({ start: 600, end: 960 });
  });

  it("covers the windows given too (trips without a vehicle outside the shifts)", () => {
    const rows = [{ shift: { start: 420, end: 1200 }, route: null }];
    expect(computeTimeRange(rows, DEFAULT_TIME_RANGE, [{ start: 1230, end: 1245 }])).toEqual({ start: 420, end: 1260 });
    expect(computeTimeRange(rows, DEFAULT_TIME_RANGE, [{ start: 350, end: 380 }])).toEqual({ start: 300, end: 1200 });
    expect(computeTimeRange([], DEFAULT_TIME_RANGE, [{ start: 600, end: 630 }])).toEqual({ start: 600, end: 960 });
  });

  it("positions minutes as clamped percentages", () => {
    const range = { start: 360, end: 1080 };
    expect(percentOf(720, range)).toBe(50);
    expect(percentOf(0, range)).toBe(0);
    expect(percentOf(2000, range)).toBe(100);
  });
});

describe("coPassengers", () => {
  it("links trips on board at the same time only", () => {
    const links = coPassengers([
      stop(0, "a", "PICKUP", 0, 0, 1),
      stop(1, "b", "PICKUP", 0, 0, 2),
      stop(2, "a", "DROPOFF", 0, 0, 1),
      stop(3, "c", "PICKUP", 0, 0, 2),
      stop(4, "b", "DROPOFF", 0, 0, 1),
      stop(5, "c", "DROPOFF", 0, 0, 0),
      stop(6, "d", "PICKUP", 0, 0, 1),
      stop(7, "d", "DROPOFF", 0, 0, 0),
    ]);
    expect([...(links.get("a") ?? [])]).toEqual(["b"]);
    expect([...(links.get("b") ?? [])].sort()).toEqual(["a", "c"]);
    expect([...(links.get("c") ?? [])]).toEqual(["b"]);
    expect(links.has("d")).toBe(false);
  });
});

describe("vehicle colors", () => {
  it("keeps the type color for the first vehicle and shades the next ones distinctly", () => {
    const base = "#2563eb";
    const shades = Array.from({ length: 5 }, (_, i) => vehicleShade(base, i));
    expect(shades[0]).toBe(base);
    expect(new Set(shades).size).toBe(5);
    for (const color of shades) expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("darkens and lightens", () => {
    expect(shade("#808080", 1)).toBe("#000000");
    expect(shade("#808080", -1)).toBe("#ffffff");
    expect(hexToRgb("#c27c0e")).toEqual([194, 124, 14]);
  });
});
