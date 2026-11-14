import { describe, expect, it } from "vitest";
import { encodePlanFigures, emptyPlanFigures } from "./kpis-plan";
import { loadKpiRows, serviceDateFilter, toKpiData, type KpiClient, type KpiQueryRows } from "./kpis-load";

const day = new Date("2026-10-12T00:00:00.000Z");
const validatedAt = new Date("2026-10-11T15:40:00.000Z");
const startedAt = new Date("2026-10-11T14:51:00.000Z");

type TripRow = KpiQueryRows["trips"][number];

function tripRow(overrides: Partial<TripRow>): TripRow {
  return {
    id: "t",
    serviceDate: day,
    status: "ASSIGNED",
    routeId: "r1",
    direction: "OUTBOUND",
    shared: false,
    appointmentMinute: 480,
    readyMinute: null,
    plannedPickupMinute: 440,
    plannedDropoffMinute: 470,
    patientId: "p1",
    recurrenceId: "rec1",
    facilityId: "f1",
    payer: "CPAM",
    allowedVehicleTypes: ["TAXI", "VSL"],
    sharingAllowed: true,
    sharingStatus: "NOT_PROPOSED",
    sharingProposedAt: null,
    sharingRespondedAt: null,
    directKm: 12,
    detourKm: 0,
    estimatedRevenue: 30,
    cancellationReason: null,
    cancelledAt: null,
    exceptionalAmbulanceAt: null,
    lockedVehicleId: null,
    ...overrides,
  };
}

const rows: KpiQueryRows = {
  routes: [
    {
      id: "r1",
      serviceDate: day,
      vehicleId: "v1",
      driverId: "d1",
      distanceKm: 120.5,
      emptyKm: 30.25,
      revenue: 410,
      cost: 380,
      margin: 30,
      validatedAt,
      matrixSource: "haversine",
      _count: { stops: 6 },
      vehicle: { type: "TAXI", depotId: "dep" },
    },
    {
      id: "amb",
      serviceDate: day,
      vehicleId: "a1",
      driverId: null,
      distanceKm: 0,
      emptyKm: 0,
      revenue: 0,
      cost: 0,
      margin: 0,
      validatedAt: null,
      matrixSource: null,
      _count: { stops: 0 },
      vehicle: { type: "AMBULANCE", depotId: "dep" },
    },
  ],
  stops: [
    { routeId: "r1", tripId: "t1", kind: "PICKUP", startMinute: 440, departureMinute: 445, completedAt: new Date("2026-10-12T05:46:00.000Z") },
    { routeId: "r1", tripId: "t1", kind: "DROPOFF", startMinute: 470, departureMinute: 475, completedAt: new Date("2026-10-12T05:58:30.000Z") },
    { routeId: "r1", tripId: "t2", kind: "PICKUP", startMinute: 720, departureMinute: 724, completedAt: null },
    { routeId: "r1", tripId: "t2", kind: "DROPOFF", startMinute: 755, departureMinute: 760, completedAt: null },
    // A stop of t2 on another route (an older row): ignored.
    { routeId: "amb", tripId: "t2", kind: "PICKUP", startMinute: 0, departureMinute: 99, completedAt: null },
  ],
  trips: [
    tripRow({ id: "t1", status: "DROPPED_OFF", shared: true }),
    tripRow({ id: "t2", direction: "RETURN", appointmentMinute: null, readyMinute: 715, plannedDropoffMinute: 760 }),
    // Seated, served by the ambulance it is locked on: counted as exceptional.
    tripRow({ id: "t3", routeId: "amb", exceptionalAmbulanceAt: new Date("2026-10-11T16:00:00.000Z"), lockedVehicleId: "a1" }),
    tripRow({ id: "t4", status: "CANCELLED", routeId: null, cancellationReason: "PARTNER", cancelledAt: validatedAt, estimatedRevenue: null }),
  ],
  runs: [
    { id: "cmvzrun", serviceDate: day, startedAt },
    { id: "hist-20261012-run1", serviceDate: day, startedAt },
  ],
  plans: [
    { serviceDate: day, validatedAt, figures: encodePlanFigures({ ...emptyPlanFigures(), served: 3 }) },
    // An unknown format is ignored.
    { serviceDate: new Date("2026-10-13T00:00:00.000Z"), validatedAt, figures: { version: 9 } },
  ],
};

describe("toKpiData", () => {
  const data = toKpiData(rows);

  it("maps the routes with their vehicle and whether the crew recorded a status", () => {
    expect(data.routes).toEqual([
      {
        id: "r1",
        serviceDate: "2026-10-12",
        vehicleId: "v1",
        vehicleType: "TAXI",
        depotId: "dep",
        driverId: "d1",
        distanceKm: 120.5,
        emptyKm: 30.25,
        revenue: 410,
        cost: 380,
        margin: 30,
        validatedAt,
        matrixSource: "haversine",
        stopCount: 6,
        hasRecordedStatus: true,
      },
      expect.objectContaining({ id: "amb", vehicleType: "AMBULANCE", stopCount: 0, hasRecordedStatus: false }),
    ]);
  });

  it("keeps every trip, with its timestamps and planned times read on its own route", () => {
    expect(data.trips).toHaveLength(4);
    expect(data.trips[0]).toMatchObject({
      id: "t1",
      serviceDate: "2026-10-12",
      pickupCompletedAt: new Date("2026-10-12T05:46:00.000Z"),
      dropoffCompletedAt: new Date("2026-10-12T05:58:30.000Z"),
      pickupServiceMinutes: 5,
      plannedRideMinutes: 25,
      exceptionalAmbulance: false,
      payer: "CPAM",
      sharingAllowed: true,
    });
    expect(data.trips[1]).toMatchObject({ id: "t2", pickupCompletedAt: null, pickupServiceMinutes: 4, plannedRideMinutes: 31, readyMinute: 715 });
    expect(data.trips[2]).toMatchObject({ id: "t3", exceptionalAmbulance: true, pickupCompletedAt: null, plannedRideMinutes: null });
    expect(data.trips[3]).toMatchObject({ id: "t4", status: "CANCELLED", cancellationReason: "PARTNER", cancelledAt: validatedAt });
    expect(data.trips[0]).not.toHaveProperty("lockedVehicleId");
  });

  it("flags the simulated runs and decodes the frozen plans", () => {
    // A run of the history simulation (id "hist-…") is flagged: its day shows « simulé ».
    expect(data.runs).toEqual([
      { serviceDate: "2026-10-12", startedAt, simulated: false },
      { serviceDate: "2026-10-12", startedAt, simulated: true },
    ]);
    expect(data.plans).toEqual([{ serviceDate: "2026-10-12", validatedAt, figures: expect.objectContaining({ served: 3 }) }]);
  });
});

describe("loadKpiRows", () => {
  it("reads the five models over the whole range with the given client", async () => {
    const calls: Record<string, unknown> = {};
    const recordCall = (name: string, result: unknown) => async (args: unknown) => {
      calls[name] = args;
      return result;
    };
    const client = {
      route: { findMany: recordCall("routes", rows.routes) },
      routeStop: { findMany: recordCall("stops", rows.stops) },
      trip: { findMany: recordCall("trips", rows.trips) },
      optimizationRun: { findMany: recordCall("runs", rows.runs) },
      validatedPlan: { findMany: recordCall("plans", rows.plans) },
    } as unknown as KpiClient;

    expect(await loadKpiRows(client, { from: "2026-10-05", to: "2026-10-31" })).toEqual(toKpiData(rows));

    const range = { gte: new Date("2026-10-05T00:00:00.000Z"), lte: new Date("2026-10-31T00:00:00.000Z") };
    expect(calls.routes).toMatchObject({ where: { serviceDate: range }, select: { _count: { select: { stops: true } }, vehicle: { select: { type: true, depotId: true } } } });
    expect(calls.stops).toMatchObject({ where: { route: { serviceDate: range } } });
    // Every trip of the dates: the demand counts them all, not only the served ones.
    expect(calls.trips).toMatchObject({ where: { serviceDate: range } });
    expect(calls.runs).toEqual({ where: { serviceDate: range }, select: { id: true, serviceDate: true, startedAt: true } });
    expect(calls.plans).toMatchObject({ where: { serviceDate: range } });
  });

  it("filters on a list of scattered dates (the comparison days)", () => {
    expect(serviceDateFilter({ dates: ["2026-10-06", "2026-10-13"] })).toEqual({
      in: [new Date("2026-10-06T00:00:00.000Z"), new Date("2026-10-13T00:00:00.000Z")],
    });
  });
});
