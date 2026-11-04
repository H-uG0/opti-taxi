import { describe, expect, it } from "vitest";
import { legsFromStops, MIN_OBSERVED_LEGS, observedFactors, type ObservedLeg, type ObservedStop } from "./traffic-observed";

const SETTINGS = {
  trafficEnabled: true,
  morningPeakStartMinute: 420,
  morningPeakEndMinute: 570,
  eveningPeakStartMinute: 960,
  eveningPeakEndMinute: 1140,
};
const MARSEILLE = { id: "mrs", lat: 43.2965, lng: 5.3698, radiusKm: 14, morningFactor: 1.5, dayFactor: 1.2, eveningFactor: 1.5 };
const ROAD = { id: "road", lat: null, lng: null, radiusKm: null, morningFactor: 1.05, dayFactor: 1, eveningFactor: 1.05 };
const ZONES = [MARSEILLE, ROAD];

const IN_MARSEILLE = { lat: 43.3, lng: 5.38 };
const IN_MARSEILLE_2 = { lat: 43.28, lng: 5.39 };
const GAP = { lat: 44.5594, lng: 6.0786 };
const SISTERON = { lat: 44.1955, lng: 5.9436 };
const TUESDAY = "2026-11-03";
const SATURDAY = "2026-11-07";

function leg(overrides: Partial<ObservedLeg> = {}): ObservedLeg {
  return {
    from: IN_MARSEILLE,
    to: IN_MARSEILLE_2,
    isoDate: TUESDAY,
    departureMinute: 480,
    plannedMinutes: 20,
    actualMinutes: 24,
    ...overrides,
  };
}

function legs(count: number, overrides: Partial<ObservedLeg> = {}): ObservedLeg[] {
  return Array.from({ length: count }, () => leg(overrides));
}

function factorOf(result: ReturnType<typeof observedFactors>, zoneId: string, band: string) {
  return result.find((cell) => cell.zoneId === zoneId && cell.band === band);
}

describe("observedFactors", () => {
  it("fits the applied factor times the median ratio", () => {
    // Applied 1.5, real drives 20 % longer than planned: 1.8.
    const cell = factorOf(observedFactors(legs(MIN_OBSERVED_LEGS), ZONES, SETTINGS), "mrs", "morning");
    expect(cell).toEqual({ zoneId: "mrs", band: "morning", legs: MIN_OBSERVED_LEGS, factor: 1.8 });
  });

  it("gives no value below the minimum number of legs, but counts them", () => {
    const cell = factorOf(observedFactors(legs(MIN_OBSERVED_LEGS - 1), ZONES, SETTINGS), "mrs", "morning");
    expect(cell).toEqual({ zoneId: "mrs", band: "morning", legs: MIN_OBSERVED_LEGS - 1, factor: null });
  });

  it("is not moved by a few outliers (median)", () => {
    const data = [...legs(MIN_OBSERVED_LEGS), ...legs(3, { actualMinutes: 70 })];
    expect(factorOf(observedFactors(data, ZONES, SETTINGS), "mrs", "morning")?.factor).toBe(1.8);
  });

  it("ignores a forgotten tap, a short drive and a weekend", () => {
    const data = [
      ...legs(5, { actualMinutes: 200 }),
      ...legs(5, { actualMinutes: 1 }),
      ...legs(5, { plannedMinutes: 3, actualMinutes: 6 }),
      ...legs(5, { isoDate: SATURDAY }),
    ];
    expect(factorOf(observedFactors(data, ZONES, SETTINGS), "mrs", "morning")?.legs).toBe(0);
  });

  it("assigns a leg to the band it lies in", () => {
    const result = observedFactors([leg({ departureMinute: 700 }), leg({ departureMinute: 1050 }), leg({ departureMinute: 300 })], ZONES, SETTINGS);
    expect(factorOf(result, "mrs", "morning")?.legs).toBe(0);
    expect(factorOf(result, "mrs", "day")?.legs).toBe(1);
    expect(factorOf(result, "mrs", "evening")?.legs).toBe(1);
  });

  it("leaves out a leg near a band edge: the plan may have timed it in the other band", () => {
    // Morning peak until 570. The stops' references may lie 45 min from the planned times.
    const counted = (departureMinute: number) =>
      factorOf(observedFactors([leg({ departureMinute })], ZONES, SETTINGS), "mrs", "morning")?.legs;
    expect(counted(420 + 45)).toBe(1);
    expect(counted(420 + 44)).toBe(0);
    expect(counted(570 - 20 - 45 - 1)).toBe(1);
    expect(counted(570 - 20 - 45)).toBe(0);
  });

  it("counts a leg outside every zone for the road row and leaves out a leg entering a zone", () => {
    const result = observedFactors([leg({ from: GAP, to: SISTERON }), leg({ from: GAP, to: IN_MARSEILLE })], ZONES, SETTINGS);
    expect(factorOf(result, "road", "morning")?.legs).toBe(1);
    expect(factorOf(result, "mrs", "morning")?.legs).toBe(0);
  });

  it("leaves out a leg crossing a zone with both ends outside it", () => {
    const across = leg({ from: { lat: MARSEILLE.lat, lng: 4.9 }, to: { lat: MARSEILLE.lat, lng: 5.9 } });
    const result = observedFactors([across], ZONES, SETTINGS);
    expect(factorOf(result, "road", "morning")?.legs).toBe(0);
    expect(factorOf(result, "mrs", "morning")?.legs).toBe(0);
  });

  it("starts from a factor of 1 when traffic was switched off", () => {
    const cell = factorOf(observedFactors(legs(MIN_OBSERVED_LEGS), ZONES, { ...SETTINGS, trafficEnabled: false }), "mrs", "morning");
    expect(cell?.factor).toBe(1.2);
  });

  it("keeps the factor between 1 and the maximum", () => {
    const faster = legs(MIN_OBSERVED_LEGS, { actualMinutes: 8 });
    expect(factorOf(observedFactors(faster, ZONES, SETTINGS), "mrs", "morning")?.factor).toBe(1);
    const slower = legs(MIN_OBSERVED_LEGS, { actualMinutes: 70 });
    expect(factorOf(observedFactors(slower, ZONES, SETTINGS), "mrs", "morning")?.factor).toBe(3);
  });
});

describe("legsFromStops", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 3, 0, minute));

  function stop(overrides: Partial<ObservedStop> = {}): ObservedStop {
    return {
      routeId: "r1",
      sequence: 0,
      kind: "PICKUP",
      lat: 43.3,
      lng: 5.38,
      arrivalMinute: 480,
      startMinute: 480,
      departureMinute: 485,
      loadAfter: 1,
      completedAt: at(480),
      route: { serviceDate: new Date(Date.UTC(2026, 10, 3)) },
      ...overrides,
    };
  }

  // Planned: 20 min of driving, from the end of a pickup to the arrival at a dropoff.
  const next = { sequence: 1, kind: "DROPOFF", arrivalMinute: 505, startMinute: 505, departureMinute: 510, loadAfter: 0, completedAt: at(510) } as const;

  it("takes a ride as the time between its two taps: on board, then on arrival", () => {
    const [measured] = legsFromStops([stop({ completedAt: at(485) }), stop(next)]);
    expect(measured).toMatchObject({ isoDate: "2026-11-03", departureMinute: 485, plannedMinutes: 20, actualMinutes: 25 });
  });

  it("takes out the stop's duration when it lies between the two taps", () => {
    const kinds = (first: "PICKUP" | "DROPOFF", second: "PICKUP" | "DROPOFF") =>
      legsFromStops([stop({ kind: first, completedAt: at(485) }), stop({ ...next, kind: second })])[0]?.actualMinutes;
    expect(kinds("PICKUP", "DROPOFF")).toBe(25);
    expect(kinds("PICKUP", "PICKUP")).toBe(20); // the second pickup is tapped at its end
    expect(kinds("DROPOFF", "DROPOFF")).toBe(20); // the first dropoff is tapped at its start
    expect(kinds("DROPOFF", "PICKUP")).toBe(15);
  });

  it("skips a leg driven empty, a planned wait, a missing tap, a gap and another route", () => {
    expect(legsFromStops([stop({ loadAfter: 0 }), stop(next)])).toEqual([]);
    expect(legsFromStops([stop(), stop({ ...next, arrivalMinute: 500 })])).toEqual([]);
    expect(legsFromStops([stop({ completedAt: null }), stop(next)])).toEqual([]);
    expect(legsFromStops([stop(), stop({ ...next, sequence: 2 })])).toEqual([]);
    expect(legsFromStops([stop(), stop({ ...next, routeId: "r2" })])).toEqual([]);
  });
});
