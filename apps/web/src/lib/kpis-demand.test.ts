import { describe, expect, it } from "vitest";
import { computeDayKpis, computeKpisByDay, summarizePeriod } from "./kpis";
import {
  addDemand,
  cancelledBeforeDay,
  demandBucket,
  demandOfDay,
  emptyDemand,
  lostTrips,
  placedTrips,
  serviceRate,
  tripsToCarry,
} from "./kpis-demand";
import type { KpiTrip } from "./kpis-rows";

// November 2026: Europe/Paris is UTC+1.
const DAY = "2026-11-03";

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
    estimatedRevenue: 40,
    allowedVehicleTypes: ["TAXI", "VSL"],
    ...overrides,
  };
}

const cancelled = (at: string, overrides: Partial<KpiTrip> = {}) =>
  trip({ status: "CANCELLED", routeId: null, cancellationReason: "PATIENT", cancelledAt: new Date(at), estimatedRevenue: null, ...overrides });

describe("demand funnel (KPI-01)", () => {
  it("puts every trip of the day in exactly one bucket", () => {
    const trips = [
      trip(),
      trip({ status: "DROPPED_OFF" }),
      trip({ status: "PICKED_UP" }),
      trip({ status: "NO_SHOW" }),
      trip({ status: "PLANNED", routeId: null, estimatedRevenue: null }),
      // The evening before (Paris), and the morning of the day.
      cancelled("2026-11-02T22:30:00+01:00"),
      cancelled("2026-11-03T06:30:00+01:00", { cancellationReason: "REGULATION" }),
      // Handed over to a partner, whenever.
      cancelled("2026-11-02T17:00:00+01:00", { cancellationReason: "PARTNER" }),
      // Cancelled before the instant was recorded: before.
      trip({ status: "CANCELLED", routeId: null, cancellationReason: null, cancelledAt: null }),
    ];
    const d = demandOfDay(trips);
    expect(d).toMatchObject({
      requested: 9,
      cancelledBefore: 2,
      cancelledOnDay: 1,
      handedOver: 1,
      noShows: 1,
      served: 3,
      realized: 1,
      unassigned: 1,
    });
    expect(d.requested).toBe(d.cancelledBefore + d.cancelledOnDay + d.handedOver + d.noShows + d.served + d.unassigned);
    expect(tripsToCarry(d)).toBe(6);
    expect(placedTrips(d)).toBe(4);
    expect(lostTrips(d)).toBe(2);
    // Placed ÷ to carry: 4 / 6. The patients' cancellations are not lost demand.
    expect(serviceRate(d)).toBeCloseTo(4 / 6);
  });

  it("reads a cancellation instant in Paris time", () => {
    // 23:30 UTC on the 2nd is 00:30 on the 3rd in Paris: on the day.
    expect(cancelledBeforeDay({ cancelledAt: new Date("2026-11-02T23:30:00Z") }, DAY)).toBe(false);
    expect(cancelledBeforeDay({ cancelledAt: new Date("2026-11-02T22:59:00Z") }, DAY)).toBe(true);
    expect(demandBucket(cancelled("2026-11-03T05:00:00Z", { cancellationReason: "PARTNER" }))).toBe("handedOver");
  });

  it("prices the lost trips at the day's average served trip of the same kind, else of any", () => {
    const d = demandOfDay([
      trip({ estimatedRevenue: 30 }),
      trip({ estimatedRevenue: 50 }),
      trip({ estimatedRevenue: 120, allowedVehicleTypes: ["AMBULANCE"] }),
      trip({ status: "PLANNED", routeId: null, estimatedRevenue: null }),
      trip({ status: "PLANNED", routeId: null, estimatedRevenue: null, allowedVehicleTypes: ["AMBULANCE"] }),
    ]);
    expect(d.lostRevenue).toBe(40 + 120);
    expect(d.unpricedLost).toBe(0);
    // No lying trip served: the overall average.
    expect(demandOfDay([trip({ estimatedRevenue: 30 }), cancelled("2026-11-02T10:00:00Z", { cancellationReason: "PARTNER", allowedVehicleTypes: ["AMBULANCE"] })]).lostRevenue).toBe(30);
    // Nothing served: unpriced, never NaN.
    const none = demandOfDay([trip({ status: "PLANNED", routeId: null })]);
    expect(none).toMatchObject({ lostRevenue: 0, unpricedLost: 1 });
  });

  it("has no service rate before a day is planned, and sums the planned days of a period only", () => {
    const unplanned = computeDayKpis("2026-11-04", { routes: [], trips: [trip({ serviceDate: "2026-11-04", status: "PLANNED", routeId: null })], runs: [] }, DAY);
    expect(unplanned.demand.unassigned).toBe(1);
    expect(unplanned.serviceRate).toBeNull();

    const route = { id: "r1", serviceDate: DAY, vehicleId: "v1", distanceKm: 10, emptyKm: 2, revenue: 80, cost: 50, margin: 30, validatedAt: null, stopCount: 2, hasRecordedStatus: false };
    const days = computeKpisByDay(DAY, "2026-11-04", {
      routes: [route],
      trips: [trip(), trip({ status: "PLANNED", routeId: null }), trip({ serviceDate: "2026-11-04", status: "PLANNED", routeId: null })],
      runs: [],
    }, DAY);
    const period = summarizePeriod(days);
    expect(period.demand.requested).toBe(2);
    expect(period.serviceRate).toBe(0.5);
  });

  it("adds two days counter by counter", () => {
    const a = demandOfDay([trip(), trip({ status: "NO_SHOW" })]);
    const b = demandOfDay([trip({ status: "PLANNED", routeId: null })]);
    expect(addDemand(a, b)).toMatchObject({ requested: 3, served: 1, noShows: 1, unassigned: 1, lostRevenue: 0, unpricedLost: 1 });
    expect(addDemand(emptyDemand(), emptyDemand())).toEqual(emptyDemand());
    expect(serviceRate(emptyDemand())).toBeNull();
  });
});
