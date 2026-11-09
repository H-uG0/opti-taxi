import { describe, expect, it } from "vitest";
import { loadKpiRows, toKpiData, type KpiClient, type KpiQueryRows } from "./kpis-load";

const day = new Date("2026-10-12T00:00:00.000Z");
const validatedAt = new Date("2026-10-11T15:40:00.000Z");
const startedAt = new Date("2026-10-11T14:51:00.000Z");

const rows: KpiQueryRows = {
  routes: [
    {
      id: "r1",
      serviceDate: day,
      vehicleId: "v1",
      distanceKm: 120.5,
      emptyKm: 30.25,
      revenue: 410,
      cost: 380,
      margin: 30,
      validatedAt,
      _count: { stops: 6 },
    },
    {
      id: "r2",
      serviceDate: day,
      vehicleId: "v2",
      distanceKm: 0,
      emptyKm: 0,
      revenue: 0,
      cost: 0,
      margin: 0,
      validatedAt: null,
      _count: { stops: 0 },
    },
  ],
  recorded: [{ routeId: "r1" }],
  trips: [
    {
      serviceDate: day,
      status: "DROPPED_OFF",
      routeId: "r1",
      direction: "OUTBOUND",
      shared: true,
      appointmentMinute: 480,
      plannedDropoffMinute: 470,
      stops: [{ completedAt: new Date("2026-10-12T05:52:00.000Z") }, { completedAt: new Date("2026-10-12T05:58:30.000Z") }],
    },
    {
      serviceDate: day,
      status: "ASSIGNED",
      routeId: "r1",
      direction: "RETURN",
      shared: false,
      appointmentMinute: null,
      plannedDropoffMinute: 760,
      stops: [],
      // Proposed in an ambulance, then moved back to a taxi: no longer counted.
      exceptionalAmbulanceAt: new Date("2026-10-11T16:00:00.000Z"),
      route: { vehicle: { type: "TAXI" } },
    },
    {
      serviceDate: day,
      status: "ASSIGNED",
      routeId: "r1",
      direction: "OUTBOUND",
      shared: false,
      appointmentMinute: 600,
      plannedDropoffMinute: 590,
      stops: [],
      exceptionalAmbulanceAt: new Date("2026-10-11T16:00:00.000Z"),
      route: { vehicle: { type: "AMBULANCE" } },
    },
  ],
  runs: [
    { id: "cmvzrun", serviceDate: day, startedAt },
    { id: "hist-20261012-run1", serviceDate: day, startedAt },
  ],
};

describe("toKpiData", () => {
  it("maps the query rows to the input of @/lib/kpis", () => {
    expect(toKpiData(rows)).toEqual({
      routes: [
        {
          serviceDate: "2026-10-12",
          vehicleId: "v1",
          distanceKm: 120.5,
          emptyKm: 30.25,
          revenue: 410,
          cost: 380,
          margin: 30,
          validatedAt,
          stopCount: 6,
          hasRecordedStatus: true,
        },
        {
          serviceDate: "2026-10-12",
          vehicleId: "v2",
          distanceKm: 0,
          emptyKm: 0,
          revenue: 0,
          cost: 0,
          margin: 0,
          validatedAt: null,
          stopCount: 0,
          hasRecordedStatus: false,
        },
      ],
      trips: [
        {
          serviceDate: "2026-10-12",
          status: "DROPPED_OFF",
          routeId: "r1",
          direction: "OUTBOUND",
          shared: true,
          appointmentMinute: 480,
          plannedDropoffMinute: 470,
          // The latest of the completed drop-off stops.
          dropoffCompletedAt: new Date("2026-10-12T05:58:30.000Z"),
          exceptionalAmbulance: false,
        },
        {
          serviceDate: "2026-10-12",
          status: "ASSIGNED",
          routeId: "r1",
          direction: "RETURN",
          shared: false,
          appointmentMinute: null,
          plannedDropoffMinute: 760,
          dropoffCompletedAt: null,
          exceptionalAmbulance: false,
        },
        {
          serviceDate: "2026-10-12",
          status: "ASSIGNED",
          routeId: "r1",
          direction: "OUTBOUND",
          shared: false,
          appointmentMinute: 600,
          plannedDropoffMinute: 590,
          dropoffCompletedAt: null,
          exceptionalAmbulance: true,
        },
      ],
      // A run of the history simulation (id "hist-…") is flagged: its day shows « simulé ».
      runs: [
        { serviceDate: "2026-10-12", startedAt, simulated: false },
        { serviceDate: "2026-10-12", startedAt, simulated: true },
      ],
    });
  });
});

describe("loadKpiRows", () => {
  it("reads the four models over the whole range with the given client", async () => {
    const calls: Record<string, unknown> = {};
    const recordCall = (name: string, result: unknown) => async (args: unknown) => {
      calls[name] = args;
      return result;
    };
    const client = {
      route: { findMany: recordCall("routes", rows.routes) },
      routeStop: { groupBy: recordCall("recorded", rows.recorded) },
      trip: { findMany: recordCall("trips", rows.trips) },
      optimizationRun: { findMany: recordCall("runs", rows.runs) },
    } as unknown as KpiClient;

    expect(await loadKpiRows(client, "2026-10-05", "2026-10-31")).toEqual(toKpiData(rows));

    const range = { gte: new Date("2026-10-05T00:00:00.000Z"), lte: new Date("2026-10-31T00:00:00.000Z") };
    expect(calls.routes).toMatchObject({ where: { serviceDate: range }, select: { _count: { select: { stops: true } } } });
    expect(calls.recorded).toEqual({ by: ["routeId"], where: { completedAt: { not: null }, route: { serviceDate: range } } });
    expect(calls.trips).toMatchObject({
      where: { serviceDate: range, routeId: { not: null }, status: { in: ["ASSIGNED", "PICKED_UP", "DROPPED_OFF"] } },
      select: { stops: { where: { kind: "DROPOFF", completedAt: { not: null } }, select: { completedAt: true } } },
    });
    expect(calls.runs).toEqual({ where: { serviceDate: range }, select: { id: true, serviceDate: true, startedAt: true } });
  });
});
