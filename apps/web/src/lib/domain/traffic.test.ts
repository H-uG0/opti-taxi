import { describe, expect, it } from "vitest";
import { trafficSettingsSchema } from "@/lib/optimizer/contract";
import { toContractTraffic, type TrafficInput } from "./traffic";

const PEAKS = { morningPeakStartMinute: 420, morningPeakEndMinute: 570, eveningPeakStartMinute: 960, eveningPeakEndMinute: 1140 };
const MARSEILLE = { lat: 43.2965, lng: 5.3698, radiusKm: 14, morningFactor: 1.5, dayFactor: 1.2, eveningFactor: 1.5 };
const ROAD = { lat: null, lng: null, radiusKm: null, morningFactor: 1.05, dayFactor: 1, eveningFactor: 1.1 };
const INPUT: TrafficInput = { trafficEnabled: true, ...PEAKS, zones: [MARSEILLE, ROAD] };

const TUESDAY = "2026-11-03";
const SATURDAY = "2026-11-07";

describe("toContractTraffic", () => {
  it("sends the three bands with one factor each on a working day", () => {
    const traffic = toContractTraffic(INPUT, TUESDAY);
    expect(traffic).toEqual({
      bands: [
        { startMin: 420, endMin: 570 },
        { startMin: 570, endMin: 960 },
        { startMin: 960, endMin: 1140 },
      ],
      roadFactors: [1.05, 1, 1.1],
      zones: [{ lat: 43.2965, lng: 5.3698, radiusKm: 14, factors: [1.5, 1.2, 1.5] }],
    });
    expect(trafficSettingsSchema.safeParse(traffic).success).toBe(true);
  });

  it("has no commuter peak on a weekend: one band with the day factors", () => {
    const traffic = toContractTraffic(INPUT, SATURDAY);
    expect(traffic).toEqual({
      bands: [{ startMin: 420, endMin: 1140 }],
      roadFactors: [1],
      zones: [{ lat: 43.2965, lng: 5.3698, radiusKm: 14, factors: [1.2] }],
    });
    expect(trafficSettingsSchema.safeParse(traffic).success).toBe(true);
  });

  it("sends nothing when traffic is switched off", () => {
    expect(toContractTraffic({ ...INPUT, trafficEnabled: false }, TUESDAY)).toBeUndefined();
  });

  it("treats the road as free flow when its row is missing", () => {
    expect(toContractTraffic({ ...INPUT, zones: [MARSEILLE] }, TUESDAY)?.roadFactors).toEqual([1, 1, 1]);
  });
});

describe("trafficSettingsSchema", () => {
  const band = { startMin: 420, endMin: 570 };

  it("refuses overlapping bands, a missing factor and a factor under 1", () => {
    const overlap = { bands: [band, { startMin: 500, endMin: 960 }], roadFactors: [1, 1], zones: [] };
    expect(trafficSettingsSchema.safeParse(overlap).success).toBe(false);
    expect(trafficSettingsSchema.safeParse({ bands: [band], roadFactors: [1, 1], zones: [] }).success).toBe(false);
    expect(trafficSettingsSchema.safeParse({ bands: [band], roadFactors: [0.9], zones: [] }).success).toBe(false);
    expect(trafficSettingsSchema.safeParse({ bands: [band], roadFactors: [1], zones: [] }).success).toBe(true);
  });
});
