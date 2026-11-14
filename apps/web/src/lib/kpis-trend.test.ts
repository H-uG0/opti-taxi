import { describe, expect, it } from "vitest";
import { computeKpisByDay, type KpiData, type KpiRoute, type KpiTrip } from "./kpis";
import { addMonths, bucketEnd, bucketStart, movingAverage, MOVING_AVERAGE_DAYS, rangePresets, trendPoints } from "./kpis-trend";

function route(serviceDate: string, overrides: Partial<KpiRoute> = {}): KpiRoute {
  return {
    id: `r-${serviceDate}`,
    serviceDate,
    vehicleId: "v1",
    distanceKm: 100,
    emptyKm: 40,
    revenue: 200,
    cost: 100,
    margin: 100,
    validatedAt: null,
    stopCount: 4,
    hasRecordedStatus: false,
    ...overrides,
  };
}

function trips(serviceDate: string, count: number): KpiTrip[] {
  return Array.from({ length: count }, () => ({
    serviceDate,
    status: "ASSIGNED" as const,
    routeId: `r-${serviceDate}`,
    direction: "OUTBOUND" as const,
    shared: false,
    appointmentMinute: null,
    plannedDropoffMinute: null,
    dropoffCompletedAt: null,
  }));
}

/** Monday 2 November to Sunday 15 November 2026: a route every day but Sundays, day N carries N trips. */
function twoWeeks(): KpiData {
  const data: KpiData = { routes: [], trips: [], runs: [] };
  for (let d = 2; d <= 15; d++) {
    const date = `2026-11-${String(d).padStart(2, "0")}`;
    if (d === 8 || d === 15) continue;
    data.routes.push(route(date));
    data.trips.push(...trips(date, d));
  }
  return data;
}

describe("steps", () => {
  it("starts a week on Monday and a month on the 1st", () => {
    expect(bucketStart("2026-11-05", "week")).toBe("2026-11-02");
    expect(bucketEnd("2026-11-02", "week")).toBe("2026-11-08");
    expect(bucketStart("2026-11-05", "month")).toBe("2026-11-01");
    expect(bucketEnd("2026-02-01", "month")).toBe("2026-02-28");
    expect(bucketEnd("2026-12-01", "month")).toBe("2026-12-31");
    expect(bucketStart("2026-11-05", "day")).toBe("2026-11-05");
    expect(addMonths("2026-11-14", -11)).toBe("2025-12-01");
  });
});

describe("trendPoints", () => {
  const days = computeKpisByDay("2026-11-02", "2026-11-15", twoWeeks(), "2026-11-20");

  it("summarizes each week from its summed counters, and marks a step the range cuts", () => {
    const weeks = trendPoints(days, "week");
    expect(weeks.map((w) => [w.key, w.from, w.to, w.cut])).toEqual([
      ["2026-11-02", "2026-11-02", "2026-11-08", false],
      ["2026-11-09", "2026-11-09", "2026-11-15", false],
    ]);
    // Week 1: 2+3+…+7 = 27 trips on 6 vehicle-days.
    expect(weeks[0]?.summary.tripsPerVehiclePlanned).toBe(27 / 6);
    expect(weeks[0]?.average).toBeNull();
    const months = trendPoints(days.slice(3), "month");
    expect(months).toHaveLength(1);
    expect(months[0]).toMatchObject({ key: "2026-11-01", from: "2026-11-05", cut: true });
  });

  it("averages the last 7 working days, days off skipped, from the counters", () => {
    const points = trendPoints(days, "day");
    // Monday 9: the 7 working days are 2 to 7 and 9 (Sunday 8 has no route).
    const monday = points.find((p) => p.key === "2026-11-09");
    expect(monday?.average?.days).toBe(MOVING_AVERAGE_DAYS);
    expect(monday?.average?.summary.tripsPerVehiclePlanned).toBe((2 + 3 + 4 + 5 + 6 + 7 + 9) / 7);
    // Not enough working days yet, and no average on a day off.
    expect(points.find((p) => p.key === "2026-11-07")?.average).toBeNull();
    expect(points.find((p) => p.key === "2026-11-15")?.average).toBeNull();
  });

  it("starts the average with the range when the days before it are given", () => {
    const all = computeKpisByDay("2026-11-02", "2026-11-15", twoWeeks(), "2026-11-20");
    const points = trendPoints(all.slice(7), "day", all.slice(0, 7));
    expect(points[0]?.key).toBe("2026-11-09");
    expect(points[0]?.average?.days).toBe(7);
    expect(movingAverage(all, 0)).toBeNull();
  });
});

describe("rangePresets", () => {
  it("offers the last days through J+1, last week, the current month and 12 months by month", () => {
    const presets = rangePresets("2026-11-14", "2026-11-15");
    expect(presets.find((p) => p.id === "14j")).toMatchObject({ from: "2026-11-02", to: "2026-11-15", granularity: null });
    expect(presets.find((p) => p.id === "semaine")).toMatchObject({ from: "2026-11-02", to: "2026-11-08", granularity: "day" });
    expect(presets.find((p) => p.id === "mois")).toMatchObject({ from: "2026-11-01", to: "2026-11-15" });
    expect(presets.find((p) => p.id === "12mois")).toMatchObject({ from: "2025-12-01", to: "2026-11-15", granularity: "month" });
    // The last day of a month: J+1 is in the next one, the current month stops at its end.
    expect(rangePresets("2026-11-30", "2026-12-01").find((p) => p.id === "mois")).toMatchObject({ from: "2026-11-01", to: "2026-11-30" });
  });
});
