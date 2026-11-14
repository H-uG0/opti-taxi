import { describe, expect, it } from "vitest";
import { computeKpisByDay, summarizePeriod, type KpiRoute } from "./kpis";
import { addFleet, fleetDayFromCrews, fleetOfDay, fleetUseRate, lostVehicleDays } from "./kpis-fleet";
import { loadKpiFleet, type FleetClient } from "./kpis-fleet-load";

const DAY = "2026-11-03";

function crew(vehicleId: string, overrides: Partial<{ driverId: string | null; blocked: string | null; unavailable: boolean }> = {}) {
  return { vehicleId, driverId: "d", blocked: null, unavailable: false, ...overrides };
}

function route(vehicleId: string, overrides: Partial<KpiRoute> = {}): KpiRoute {
  return {
    serviceDate: DAY,
    vehicleId,
    distanceKm: 100,
    emptyKm: 20,
    revenue: 300,
    cost: 120,
    margin: 180,
    validatedAt: null,
    stopCount: 4,
    hasRecordedStatus: true,
    ...overrides,
  };
}

describe("fleet use (KPI-03)", () => {
  it("classifies the crews of the day: unavailable, without a crew, available", () => {
    const day = fleetDayFromCrews(DAY, [
      crew("a"),
      crew("b", { unavailable: true, driverId: null }),
      crew("c", { driverId: null }),
      crew("d", { blocked: "Pas de DEA" }),
      crew("e"),
    ]);
    expect(day).toEqual({ serviceDate: DAY, active: ["a", "b", "c", "d", "e"], unavailable: ["b"], crewless: ["c", "d"] });
    const totals = fleetOfDay(day, new Set(["a"]));
    expect(totals).toEqual({ active: 5, unavailable: 1, crewless: 2, available: 2, used: 1 });
    expect(fleetUseRate(totals)).toBe(0.5);
    expect(lostVehicleDays(totals!)).toBe(3);
  });

  it("counts a vehicle that had a route as active and available, whatever the crews say now", () => {
    const day = { serviceDate: DAY, active: ["a"], unavailable: ["a"], crewless: [] };
    expect(fleetOfDay(day, new Set(["a", "z"]))).toEqual({ active: 2, unavailable: 0, crewless: 0, available: 2, used: 2 });
    expect(fleetOfDay(undefined, new Set(["a"]))).toBeNull();
    expect(addFleet(null, null)).toBeNull();
  });

  it("gives trips per vehicle used and per vehicle available, and sums the planned days of a period", () => {
    const trip = { serviceDate: DAY, status: "ASSIGNED" as const, routeId: "r", direction: "OUTBOUND" as const, shared: false, appointmentMinute: null, plannedDropoffMinute: null, dropoffCompletedAt: null };
    const fleet = [
      { serviceDate: DAY, active: ["a", "b", "c", "d"], unavailable: ["d"], crewless: [] },
      // A Sunday without planning: its idle vehicles do not count.
      { serviceDate: "2026-11-04", active: ["a", "b", "c", "d"], unavailable: [], crewless: [] },
    ];
    const days = computeKpisByDay(DAY, "2026-11-04", { routes: [route("a"), route("b")], trips: [trip, trip, trip, trip, trip, trip], runs: [], fleet }, DAY);
    expect(days[0]).toMatchObject({ tripsPerVehiclePlanned: 3, tripsPerAvailableVehicle: 2, useRate: 2 / 3 });
    // Nothing planned that day: no use rate (not 0 %).
    expect(days[1]?.useRate).toBeNull();
    const period = summarizePeriod(days);
    expect(period.fleet).toEqual({ active: 4, unavailable: 1, crewless: 0, available: 3, used: 2 });
    expect(period.useRate).toBeCloseTo(2 / 3);
  });

  it("loads the dates' crews in a fixed number of queries and resolves each date", async () => {
    const calls: string[] = [];
    const track = <T,>(name: string, value: T) => async () => {
      calls.push(name);
      return value;
    };
    const vehicle = { id: "v1", label: "Taxi 1", type: "TAXI", active: true, depotId: "dep", defaultDriverId: "p1", defaultCrewMateId: null };
    const person = {
      id: "p1",
      firstName: "Ana",
      lastName: "Bel",
      active: true,
      workDays: [1, 2, 3, 4, 5],
      shiftStartMinute: 420,
      shiftEndMinute: 900,
      breakWindowStartMinute: 720,
      breakWindowEndMinute: 840,
      breakMinutes: 30,
      hourlyCost: 20,
      qualifications: ["TAXI_CARD"],
      depotId: "dep",
    };
    const client = {
      vehicle: { findMany: track("vehicle", [vehicle]) },
      driver: { findMany: track("driver", [person]) },
      staffAbsence: { findMany: track("absence", [{ driverId: "p1", kind: "LEAVE", startDate: new Date("2026-11-04T00:00:00Z"), endDate: new Date("2026-11-04T00:00:00Z") }]) },
      crewIncompatibility: { findMany: track("incompatibility", []) },
      dayCrew: { findMany: track("dayCrew", []) },
      vehicleUnavailability: { findMany: track("outage", []) },
      depot: { findMany: track("depot", [{ id: "dep", name: "Marseille", lat: 43.3, lng: 5.4 }]) },
      appSettings: { findUnique: track("settings", null) },
    } as unknown as FleetClient;
    // Tuesday 3: the driver works; Wednesday 4: on leave; Saturday 7: not a working day.
    const fleet = await loadKpiFleet(client, [DAY, "2026-11-04", "2026-11-07"]);
    expect(calls).toHaveLength(8);
    expect(fleet.map((f) => [f.serviceDate, f.crewless.length])).toEqual([
      [DAY, 0],
      ["2026-11-04", 1],
      ["2026-11-07", 1],
    ]);
    expect(await loadKpiFleet(client, [])).toEqual([]);
  });
});
