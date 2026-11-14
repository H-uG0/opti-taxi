import { describe, expect, it } from "vitest";
import { computeKpisByDay, summarizePeriod } from "./kpis";
import {
  crewOf,
  fleetDaysBy,
  groupLines,
  lineRates,
  plannedBy,
  routeLines,
  sumLines,
  usedVehiclesByDate,
} from "./kpis-breakdown";
import { emptyPlanFigures, planRates } from "./kpis-plan";
import { DEFAULT_KPI_OPTIONS, type KpiData, type KpiRoute, type KpiTrip } from "./kpis-rows";
import { inScope, isScoped, NO_SCOPE, scopeKpiData, type VehicleMeta } from "./kpis-scope";

const DAY = "2026-11-03";
const TODAY = "2026-11-05";

function route(overrides: Partial<KpiRoute> = {}): KpiRoute {
  return {
    id: "r1",
    serviceDate: DAY,
    vehicleId: "v1",
    vehicleType: "TAXI",
    depotId: "gap",
    driverId: "d1",
    crewMateId: null,
    distanceKm: 100,
    emptyKm: 40,
    revenue: 300,
    cost: 150,
    margin: 150,
    validatedAt: null,
    stopCount: 4,
    hasRecordedStatus: true,
    activeMinutes: 480,
    onboardMinutes: 120,
    facilityWaitMinutes: 60,
    ...overrides,
  };
}

function trip(overrides: Partial<KpiTrip> = {}): KpiTrip {
  return {
    serviceDate: DAY,
    status: "DROPPED_OFF",
    routeId: "r1",
    direction: "OUTBOUND",
    shared: false,
    appointmentMinute: 480,
    plannedDropoffMinute: 470,
    dropoffCompletedAt: new Date(`${DAY}T08:12:00+01:00`),
    estimatedRevenue: 50,
    ...overrides,
  };
}

const data: KpiData = {
  routes: [
    route(),
    route({ id: "r2", vehicleId: "v2", vehicleType: "AMBULANCE", depotId: "sis", driverId: "d2", crewMateId: "d1", distanceKm: 60, emptyKm: 30, cost: 200 }),
    // Emptied by cancellations: no vehicle, km nor money.
    route({ id: "r3", vehicleId: "v3", stopCount: 0 }),
  ],
  trips: [
    // 12 min late beyond the 5 min tolerance; eligible and shared.
    trip({ shared: true, sharingAllowed: true, estimatedRevenue: 60 }),
    trip({ direction: "RETURN", appointmentMinute: null, status: "ASSIGNED", dropoffCompletedAt: null, sharingAllowed: true }),
    trip({ status: "NO_SHOW", estimatedRevenue: 40 }),
    trip({ routeId: "r2", allowedVehicleTypes: ["AMBULANCE"], dropoffCompletedAt: new Date(`${DAY}T07:58:00+01:00`), estimatedRevenue: 120 }),
    // Left aside: in no line.
    trip({ routeId: null, status: "PLANNED" }),
  ],
  runs: [],
};

describe("routeLines", () => {
  const lines = routeLines(data, TODAY, DEFAULT_KPI_OPTIONS, (id) => (id === "v1" ? 0.3 : undefined));

  it("gives one line per route with stops, its trips, money and recorded outcomes", () => {
    expect(lines.map((l) => l.routeId)).toEqual(["r1", "r2"]);
    const [taxi, ambulance] = lines;
    expect(taxi).toMatchObject({
      trips: 2,
      sharedTrips: 1,
      eligible: 2,
      eligibleShared: 1,
      noShows: 1,
      realized: 1,
      // A finished day: 2 served + 1 absent placed, the drop-off and the absence recorded.
      placedFinished: 3,
      recorded: 2,
      revenue: 50 + 60,
      kmCost: 30,
      measuredOutbound: 1,
      lateArrivals: 1,
      timed: true,
    });
    // A lying patient is never eligible; dropped off on time.
    expect(ambulance).toMatchObject({ trips: 1, eligible: 0, measuredOutbound: 1, lateArrivals: 0, kmCost: null });
  });

  it("matches the dashboard's totals of the same rows", () => {
    const period = summarizePeriod(computeKpisByDay(DAY, DAY, data, TODAY));
    const all = sumLines(lines);
    expect(all.trips).toBe(period.servedTrips);
    expect(all.revenue).toBeCloseTo(period.servedRevenue);
    expect(all.cost).toBe(period.cost);
    expect(all.distanceKm).toBe(period.distanceKm);
    expect(all.vehicleDays).toBe(period.vehicles);
    expect(lineRates(all).marginPerTrip).toBeCloseTo(period.marginPerTrip ?? 0);
  });

  it("does not read the recorded outcomes of a day not over yet", () => {
    const [line] = routeLines(data, DAY, DEFAULT_KPI_OPTIONS);
    expect(line).toMatchObject({ finished: false, placedFinished: 0, recorded: 0 });
  });
});

describe("groups and rates", () => {
  const lines = routeLines(data, TODAY, DEFAULT_KPI_OPTIONS, () => 0.3);

  it("groups by depot, type or person (a crew mate counts the route too)", () => {
    expect([...groupLines(lines, (l) => [l.depotId]).keys()].sort()).toEqual(["gap", "sis"]);
    const people = groupLines(lines, crewOf);
    expect(people.get("d1")?.vehicleDays).toBe(2);
    expect(people.get("d2")?.trips).toBe(1);
  });

  it("computes the unit economics from the sums", () => {
    const rates = lineRates(sumLines(lines));
    expect(rates.tripsPerVehicleDay).toBe(1.5);
    expect(rates.emptyKmShare).toBeCloseTo(70 / 160);
    expect(rates.revenuePerKm).toBeCloseTo(230 / 160);
    expect(rates.costPerKm).toBeCloseTo(350 / 160);
    // Hourly part: 350 - 160 km × 0.30 = 302 € over 16 h.
    expect(rates.hourlyCost).toBeCloseTo(302 / 16);
    expect(rates.occupancy).toBeCloseTo(240 / 960);
    expect(rates.facilityWaitPerVehicleDay).toBe(60);
    expect(rates.plannedHours).toBe(16);
    expect(rates.lateRate).toBe(0.5);
  });

  it("returns unknown rates for an empty group", () => {
    const rates = lineRates(sumLines([]));
    expect(rates).toMatchObject({ tripsPerVehicleDay: null, marginPerTrip: null, hourlyCost: null, occupancy: null, recordingRate: null });
  });
});

describe("fleetDaysBy", () => {
  it("counts used, idle, unavailable and crewless vehicle-days per group", () => {
    const fleet = [{ serviceDate: DAY, active: ["v1", "v2", "v4", "v5"], unavailable: ["v4", "v2"], crewless: ["v5"] }];
    const lines = routeLines(data, TODAY);
    const byDepot = fleetDaysBy(fleet, usedVehiclesByDate(lines), (id) => ({ v1: "gap", v2: "sis", v4: "gap", v5: "sis" })[id] ?? null);
    // v2 had a route although the crews now mark it unavailable: used.
    expect(byDepot.get("gap")).toEqual({ used: 1, available: 1, unavailable: 1, crewless: 0 });
    expect(byDepot.get("sis")).toEqual({ used: 1, available: 1, unavailable: 0, crewless: 1 });
  });
});

describe("plannedBy", () => {
  it("reads the frozen lines of a day started and the routes of a day to come", () => {
    const lines = routeLines(
      { routes: [...data.routes, route({ id: "r9", serviceDate: "2026-11-06", vehicleId: "v9", depotId: "gap" })], trips: data.trips },
      TODAY,
    );
    const frozen = {
      serviceDate: DAY,
      validatedAt: new Date(),
      figures: {
        ...emptyPlanFigures(),
        byVehicle: [{ vehicleId: "v1", vehicleType: "TAXI" as const, depotId: "gap", trips: 5, sharedTrips: 0, distanceKm: 0, emptyKm: 0, revenue: 0, cost: 0 }],
      },
    };
    const planned = plannedBy([DAY, "2026-11-06"], [frozen], lines, TODAY, (l) => l.depotId);
    expect(planned.get("gap")).toEqual({ trips: 5, vehicles: 2 });
    expect(planned.get("sis")).toBeUndefined();
  });
});

describe("scopeKpiData", () => {
  const vehicles = new Map<string, VehicleMeta>([
    ["v1", { depotId: "gap", type: "TAXI" }],
    ["v2", { depotId: "sis", type: "AMBULANCE" }],
    ["v3", { depotId: "gap", type: "TAXI" }],
  ]);
  const full: KpiData = {
    ...data,
    fleet: [{ serviceDate: DAY, active: ["v1", "v2", "v3"], unavailable: ["v3"], crewless: [] }],
    plans: [
      {
        serviceDate: DAY,
        validatedAt: new Date(),
        figures: {
          ...emptyPlanFigures(),
          served: 9,
          unassigned: 2,
          vehicles: 2,
          byVehicle: [
            { vehicleId: "v1", vehicleType: "TAXI", depotId: "gap", trips: 6, sharedTrips: 2, distanceKm: 90, emptyKm: 30, revenue: 400, cost: 150 },
            { vehicleId: "v2", vehicleType: "AMBULANCE", depotId: "sis", trips: 3, sharedTrips: 0, distanceKm: 60, emptyKm: 30, revenue: 300, cost: 200 },
          ],
        },
      },
    ],
  };

  it("keeps the same rows when nothing narrows them", () => {
    expect(isScoped(NO_SCOPE)).toBe(false);
    expect(scopeKpiData(full, NO_SCOPE, vehicles)).toBe(full);
  });

  it("keeps a depot's routes, the trips on them, its fleet and its frozen lines", () => {
    const gap = scopeKpiData(full, { depotId: "gap", vehicleType: null }, vehicles);
    expect(gap.routes.map((r) => r.id)).toEqual(["r1", "r3"]);
    expect(gap.trips).toHaveLength(3);
    expect(gap.fleet).toEqual([{ serviceDate: DAY, active: ["v1", "v3"], unavailable: ["v3"], crewless: [] }]);
    const figures = gap.plans?.[0]?.figures;
    expect(figures).toMatchObject({ served: 6, vehicles: 1, revenue: 400, cost: 150, margin: 250, unassigned: 0, partial: true });
    expect(planRates(figures!)).toMatchObject({ serviceRate: null, tripsPerVehicle: 6, sharedRate: null });
    expect(gap.scoped).toBe(true);
  });

  it("measures no service rate for a depot (its demand is unknown) and keeps the planning activity", () => {
    const ambulances = scopeKpiData(full, { depotId: null, vehicleType: "AMBULANCE" }, vehicles);
    const [day] = computeKpisByDay(DAY, DAY, ambulances, TODAY);
    expect(day).toMatchObject({ scoped: true, servedTrips: 1, vehicles: 1, serviceRate: null });
    expect(summarizePeriod([day!]).serviceRate).toBeNull();
    expect(inScope({ depotId: "gap", vehicleType: "TAXI" }, "gap", "VSL")).toBe(false);
    expect(inScope({ depotId: "gap", vehicleType: null }, null, "TAXI")).toBe(false);
  });
});
