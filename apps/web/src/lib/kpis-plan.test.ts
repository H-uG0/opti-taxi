import { describe, expect, it } from "vitest";
import { computeDayKpis, computeKpisForDates, type KpiData, type KpiRoute, type KpiTrip } from "./kpis";
import { planViewOf, plannedComparison, realizedComparison } from "./kpis-compare";
import {
  addPlanFigures,
  comparisonDates,
  decodeFrozenPlan,
  emptyPlanFigures,
  encodePlanFigures,
  planFiguresOf,
  planRates,
  replacesFrozenPlan,
  vehicleFiguresOf,
} from "./kpis-plan";
import { freezeValidatedPlan } from "./kpis-plan-store";
import type { KpiClient } from "./kpis-load";

// Tuesday 3 November 2026: Europe/Paris is UTC+1.
const DAY = "2026-11-03";

function route(overrides: Partial<KpiRoute> = {}): KpiRoute {
  return {
    id: "r1",
    serviceDate: DAY,
    vehicleId: "v1",
    vehicleType: "VSL",
    depotId: "dep",
    distanceKm: 100,
    emptyKm: 25,
    revenue: 300,
    cost: 200,
    margin: 100,
    validatedAt: null,
    stopCount: 4,
    hasRecordedStatus: false,
    ...overrides,
  };
}

function trip(overrides: Partial<KpiTrip> = {}): KpiTrip {
  return {
    serviceDate: DAY,
    status: "ASSIGNED",
    routeId: "r1",
    direction: "OUTBOUND",
    shared: false,
    appointmentMinute: 480,
    plannedDropoffMinute: 470,
    dropoffCompletedAt: null,
    sharingAllowed: true,
    estimatedRevenue: 75,
    ...overrides,
  };
}

describe("planned, served, done (KPI-07)", () => {
  it("takes the figures of a plan from the dashboard's own formulas, with a line per vehicle", () => {
    const routes = [route(), route({ id: "r2", vehicleId: "v2", vehicleType: "TAXI", depotId: "dep2" }), route({ id: "r3", vehicleId: "v3", stopCount: 0 })];
    const trips = [
      trip({ shared: true }),
      trip({ shared: true, plannedDropoffMinute: 478 }),
      trip({ routeId: "r2" }),
      trip({ status: "PLANNED", routeId: null }),
      trip({ status: "CANCELLED", routeId: null, cancellationReason: "PARTNER" }),
    ];
    const day = computeDayKpis(DAY, { routes, trips, runs: [] }, "2026-11-02");
    const figures = planFiguresOf(day, vehicleFiguresOf(DAY, routes, trips));
    expect(figures).toMatchObject({
      served: 3,
      unassigned: 1,
      handedOver: 1,
      vehicles: 2,
      distanceKm: 200,
      revenue: 600,
      eligible: { VSL: 2, TAXI: 1 },
      eligibleShared: { VSL: 2, TAXI: 0 },
      plannedOutbound: 3,
      tightOutbound: 1,
    });
    expect(figures.byVehicle).toEqual([
      { vehicleId: "v1", vehicleType: "VSL", depotId: "dep", trips: 2, sharedTrips: 2, distanceKm: 100, emptyKm: 25, revenue: 300, cost: 200 },
      { vehicleId: "v2", vehicleType: "TAXI", depotId: "dep2", trips: 1, sharedTrips: 0, distanceKm: 100, emptyKm: 25, revenue: 300, cost: 200 },
    ]);
    const rates = planRates(figures);
    expect(rates.serviceRate).toBeCloseTo(3 / 5);
    expect(rates.tripsPerVehicle).toBe(1.5);
    expect(rates.sharedRate).toBeCloseTo(2 / 3);
    expect(rates.marginPerTrip).toBeCloseTo(200 / 3);
  });

  it("stores a versioned format to the cent and ignores an unknown one", () => {
    const figures = { ...emptyPlanFigures(), margin: 35.889999999, served: 4 };
    const stored = JSON.parse(JSON.stringify(encodePlanFigures(figures)));
    const decoded = decodeFrozenPlan({ serviceDate: DAY, validatedAt: new Date("2026-11-02T16:00:00Z"), figures: stored });
    expect(decoded?.figures).toMatchObject({ margin: 35.89, served: 4 });
    expect(decodeFrozenPlan({ serviceDate: DAY, validatedAt: new Date(), figures: { version: 2, figures } })).toBeNull();
    expect(decodeFrozenPlan({ serviceDate: DAY, validatedAt: new Date(), figures: null })).toBeNull();
  });

  it("keeps the plan validated the day before against a validation on the day itself", () => {
    const eve = { validatedAt: new Date("2026-11-02T16:40:00Z") };
    expect(replacesFrozenPlan(null, DAY, new Date("2026-11-03T06:45:00Z"))).toBe(true);
    // Validated again the evening before (after a late call): replaced.
    expect(replacesFrozenPlan(eve, DAY, new Date("2026-11-02T18:15:00Z"))).toBe(true);
    // Reopened and validated again on the day: the plan of the day before stays.
    expect(replacesFrozenPlan(eve, DAY, new Date("2026-11-03T06:45:00Z"))).toBe(false);
    // 23:30 UTC on the 2nd is already the 3rd in Paris.
    expect(replacesFrozenPlan(eve, DAY, new Date("2026-11-02T23:30:00Z"))).toBe(false);
    // A plan first validated on the day itself is replaced by the next validation of the day.
    expect(replacesFrozenPlan({ validatedAt: new Date("2026-11-03T06:00:00Z") }, DAY, new Date("2026-11-03T07:00:00Z"))).toBe(true);
  });

  it("freezes the plan in the validation's client, unless a plan of the day before must stay", async () => {
    const writes: unknown[] = [];
    const client = (existing: { validatedAt: Date } | null) =>
      ({
        validatedPlan: {
          findUnique: async () => existing,
          findMany: async () => [],
          upsert: async (args: unknown) => {
            writes.push(args);
            return {};
          },
        },
        route: {
          findMany: async () => [
            { ...route(), serviceDate: new Date(`${DAY}T00:00:00Z`), _count: { stops: 4 }, vehicle: { type: "VSL", depotId: "dep" }, driverId: null, matrixSource: null },
          ],
        },
        routeStop: { findMany: async () => [] },
        trip: {
          findMany: async () => [
            { ...trip({ shared: true }), id: "t1", serviceDate: new Date(`${DAY}T00:00:00Z`), payer: "CPAM", allowedVehicleTypes: ["TAXI", "VSL"] },
          ],
        },
        optimizationRun: { findMany: async () => [] },
      }) as unknown as KpiClient;
    const now = new Date("2026-11-02T16:40:00Z");
    expect(await freezeValidatedPlan(client(null), DAY, { now, validatedById: "u1" })).toBe(true);
    const write = writes[0] as { create: { validatedAt: Date; validatedById: string; figures: { version: number; figures: { served: number } } } };
    expect(write.create).toMatchObject({ validatedAt: now, validatedById: "u1", figures: { version: 1, figures: { served: 1, vehicles: 1 } } });
    expect(await freezeValidatedPlan(client({ validatedAt: now }), DAY, { now: new Date("2026-11-03T06:00:00Z"), validatedById: "u1" })).toBe(false);
    expect(writes).toHaveLength(1);
  });

  it("sums plans for the four weeks without their vehicle lines", () => {
    const one = { ...emptyPlanFigures(), served: 10, vehicles: 2, byVehicle: [{ vehicleId: "v", vehicleType: null, depotId: null, trips: 1, sharedTrips: 0, distanceKm: 1, emptyKm: 0, revenue: 1, cost: 1 }] };
    expect(addPlanFigures(one, one)).toMatchObject({ served: 20, vehicles: 4, byVehicle: [] });
    expect(planRates(emptyPlanFigures())).toEqual({
      serviceRate: null,
      tripsPerVehicle: null,
      emptyKmShare: null,
      sharedRate: null,
      tightRate: null,
      marginPerTrip: null,
    });
  });
});

describe("fair comparisons", () => {
  it("compares with the same weekday of the 4 weeks before", () => {
    expect(comparisonDates(DAY)).toEqual(["2026-10-27", "2026-10-20", "2026-10-13", "2026-10-06"]);
  });

  // Today Wednesday 4 November: Tuesday 3 is done, its weekdays before too.
  const TODAY = "2026-11-04";
  const dates = ["2026-10-13", "2026-10-20", "2026-10-27", DAY];
  const data: KpiData = {
    routes: dates.map((date, i) => route({ id: `r${i}`, serviceDate: date })),
    trips: dates.flatMap((date, i) => [
      trip({ serviceDate: date, routeId: `r${i}`, status: "DROPPED_OFF" }),
      trip({ serviceDate: date, routeId: `r${i}`, status: i === 3 ? "NO_SHOW" : "DROPPED_OFF" }),
    ]),
    runs: [],
    // The 27th was validated with 3 trips, one cancelled afterwards; the 3rd has no frozen plan.
    plans: [
      {
        serviceDate: "2026-10-27",
        validatedAt: new Date("2026-10-26T16:00:00Z"),
        figures: { ...emptyPlanFigures(), served: 3, vehicles: 1, distanceKm: 100, emptyKm: 50 },
      },
    ],
  };
  const days = computeKpisForDates(dates, data, TODAY);
  const lookup = new Map(days.map((d) => [d.date, d]));

  it("sums the realized counters of the same weekdays that had routes", () => {
    const { previous, fourWeeks } = realizedComparison(DAY, lookup);
    expect(previous?.date).toBe("2026-10-27");
    expect(fourWeeks?.count).toBe(3);
    expect(fourWeeks?.realizedTrips).toBe(6);
    expect(lookup.get(DAY)?.demand.noShows).toBe(1);
    // A day not in the lookup or without routes is no comparison.
    expect(realizedComparison("2027-01-05", lookup)).toEqual({ previous: null, fourWeeks: null });
  });

  it("reads the frozen plan of a day started, and the routes of a day to come or never frozen", () => {
    const frozen = planViewOf(lookup.get("2026-10-27")!, TODAY);
    expect(frozen).toMatchObject({ frozen: true, figures: { served: 3 } });
    const current = planViewOf(lookup.get("2026-10-20")!, TODAY);
    expect(current).toMatchObject({ frozen: false, figures: { served: 2 } });
    const comparison = plannedComparison(DAY, lookup, TODAY);
    expect(comparison.previous?.frozen).toBe(true);
    expect(comparison.fourWeeks).toMatchObject({ count: 3, frozen: 1, figures: { served: 7 } });
  });
});
