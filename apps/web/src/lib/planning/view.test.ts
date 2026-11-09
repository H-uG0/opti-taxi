import { describe, expect, it } from "vitest";
import { tariffRow } from "@/test/tariff-fixtures";
import type { DriverInput, SettingsInput } from "@/lib/optimizer/build-request";
import type { RunDetails } from "@/lib/optimizer/run-details";
import { computeDayKpis as computeDashboardDayKpis, type KpiData } from "@/lib/kpis";
import { addDays } from "@/lib/time";
import {
  buildPlanningView,
  computeDayKpis,
  dayStatusOf,
  fieldRecordsByTrip,
  sharingAnswerOf,
  toKpiRows,
  waitAtFacility,
  type PlanningRawInput,
  type RawRoute,
  type RawRun,
  type RawTrip,
  type RawVehicle,
} from "./view";

const DATE = "2026-11-03"; // Tuesday

const settings: SettingsInput = {
  waitBeforeAppointmentMin: 30,
  waitAfterSessionMin: 15,
  maxTotalWaitMin: 45,
  maxDetourKmPerExtraPatient: 10,
  maxDetourKmTotal: 30,
  pickupServiceMin: 5,
  dropoffServiceMin: 5,
  unassignedPenalty: 10000,
  solverTimeLimitSec: 10,
};

const driver = (id: string, workDays = [1, 2, 3, 4, 5]): DriverInput => ({
  id,
  firstName: "Jean",
  lastName: id,
  active: true,
  workDays,
  shiftStartMinute: 360,
  shiftEndMinute: 1140,
  // A 13-hour shift needs a break of 20 min or more (lib/staff/work-time.ts).
  breakWindowStartMinute: 690,
  breakWindowEndMinute: 840,
  breakMinutes: 45,
  hourlyCost: 24,
});

const vehicle = (id: string, label: string, workDays?: number[]): RawVehicle => ({
  id,
  label,
  registration: `AA-${id}`,
  type: "TAXI",
  capacity: 2,
  depot: { lat: 43.3, lng: 5.37, name: "Marseille" },
  department: "13",
  costPerKm: 0.3,
  active: true,
  defaultDriver: driver(`d_${id}`, workDays),
  defaultCrewMate: null,
});

const trip = (id: string, overrides: Partial<RawTrip> = {}): RawTrip => ({
  id,
  patientId: `p_${id}`,
  recurrenceId: null,
  facilityId: "f1",
  direction: "OUTBOUND",
  status: "PLANNED",
  pickupLat: 43.31,
  pickupLng: 5.39,
  dropoffLat: 43.52,
  dropoffLng: 5.44,
  appointmentMinute: 480,
  readyMinute: null,
  allowedVehicleTypes: ["TAXI", "VSL"],
  sharingAllowed: true,
  sharingStatus: "NOT_PROPOSED",
  lockedVehicleId: null,
  payer: "CPAM",
  pickupAddress: `Domicile ${id}`,
  dropoffAddress: "Centre de dialyse",
  routeId: null,
  plannedPickupMinute: null,
  plannedDropoffMinute: null,
  shared: false,
  directKm: 20,
  detourKm: null,
  estimatedRevenue: null,
  createdAt: new Date("2026-11-01T10:00:00Z"),
  sharingRespondedAt: null,
  sharingRespondedBy: null,
  patient: { firstName: "Patient", lastName: id.toUpperCase() },
  facility: { name: "Dialyse Aix" },
  ...overrides,
});

const stop = (
  id: string,
  sequence: number,
  tripId: string,
  kind: "PICKUP" | "DROPOFF",
  minute: number,
  loadAfter: number,
  completedAt: Date | null = null,
  completedBy: { name: string } | null = null,
) => ({
  id,
  sequence,
  tripId,
  kind,
  lat: 43.4,
  lng: 5.4,
  address: "adresse",
  arrivalMinute: minute,
  startMinute: minute,
  departureMinute: minute + 5,
  loadAfter,
  completedAt,
  completedBy,
});

const route = (overrides: Partial<RawRoute> = {}): RawRoute => ({
  id: "r1",
  vehicleId: "v1",
  status: "PROPOSED",
  startMinute: 400,
  endMinute: 560,
  distanceKm: 100,
  emptyKm: 25,
  revenue: 150,
  cost: 90,
  margin: 60,
  breakStartMinute: null,
  breakEndMinute: null,
  validatedAt: null,
  driver: { firstName: "Jean", lastName: "Route" },
  crewMate: null,
  stops: [
    stop("s1", 0, "a", "PICKUP", 420, 1),
    stop("s2", 1, "b", "PICKUP", 430, 2),
    stop("s3", 2, "a", "DROPOFF", 460, 1),
    stop("s4", 3, "b", "DROPOFF", 470, 0),
  ],
  ...overrides,
});

const run = (overrides: Partial<RawRun> = {}): RawRun => ({
  id: "run1",
  status: "SUCCESS",
  startedAt: new Date("2026-11-02T17:00:00Z"),
  finishedAt: new Date("2026-11-02T17:00:12Z"),
  wallTimeMs: 10_000,
  matrixSource: "haversine",
  valid: false,
  error: null,
  tripsCount: 4,
  lockedCount: 0,
  unassignedCount: 1,
  requestedBy: { name: "Régulateur" },
  ...overrides,
});

function input(overrides: Partial<PlanningRawInput> = {}): PlanningRawInput {
  return {
    date: DATE,
    settings,
    vehicles: [vehicle("v1", "Taxi 1"), vehicle("v2", "Taxi 2"), vehicle("v3", "Taxi 3", [6, 7])],
    trips: [
      trip("a", { routeId: "r1", status: "ASSIGNED", shared: true, plannedPickupMinute: 420, plannedDropoffMinute: 460 }),
      trip("b", { routeId: "r1", status: "ASSIGNED", shared: true, plannedPickupMinute: 430, plannedDropoffMinute: 470 }),
      trip("c"),
      trip("d", { createdAt: new Date("2026-11-02T18:00:00Z") }),
      trip("x", { status: "CANCELLED" }),
    ],
    routes: [route()],
    lastRun: run(),
    planRun: run(),
    details: new Map(),
    tariffs: [taxiGrid],
    baseColors: { TAXI: "#c27c0e", VSL: "#2563eb", AMBULANCE: "#dc2626" },
    ...overrides,
  };
}

const taxiGrid = tariffRow({ id: "g1", validFrom: new Date("2026-01-01T00:00:00Z"), createdAt: new Date("2026-01-01T00:00:00Z") });

describe("buildPlanningView", () => {
  it("lists vehicles with a route first, then available ones; unavailable ones only as skipped", () => {
    const view = buildPlanningView(input());
    expect(view.vehicles.map((v) => [v.id, v.route?.id ?? null])).toEqual([
      ["v1", "r1"],
      ["v2", null],
    ]);
    expect(view.skippedVehicles.map((s) => s.vehicleId)).toEqual(["v3"]);
    expect(view.vehicles[0]).toMatchObject({ driverName: "Jean Route", shift: { start: 360, end: 1140 }, available: true });
    expect(view.vehicles[0]?.color).not.toBe(view.vehicles[1]?.color);
  });

  it("derives co-passengers and wait at the facility of served trips", () => {
    const view = buildPlanningView(input());
    const a = view.trips.find((t) => t.id === "a");
    expect(a).toMatchObject({ vehicleId: "v1", coPassengerTripIds: ["b"], waitAtFacilityMin: 20 });
    expect(view.trips.some((t) => t.id === "x")).toBe(false);
  });

  it("explains unassigned trips: optimizer reason, added later, or generic", () => {
    const details: RunDetails = {
      runId: "run1",
      solverStatus: "ROUTING_SUCCESS",
      violations: [{ code: "TIME_WINDOW", message: "Retard de 5 min", tripId: "a", vehicleId: "v1" }],
      warnings: ["Pas de grille"],
      unassigned: [{ tripId: "c", reason: "Aucun véhicule compatible disponible" }],
    };
    const view = buildPlanningView(input({ details: new Map([["run1", details]]) }));
    expect(view.unassigned).toEqual([
      { tripId: "c", reason: "Aucun véhicule compatible disponible" },
      { tripId: "d", reason: "Ajoutée après la dernière optimisation" },
    ]);
    expect(view.violations).toEqual([
      { code: "TIME_WINDOW", label: "Hors fenêtre horaire", message: "Retard de 5 min", tripId: "a", vehicleId: "v1" },
    ]);
    expect(view.violationsKnown).toBe(true);
    expect(view.kpis.violations).toBe(1);
    expect(view.planRun?.warnings).toEqual(["Pas de grille"]);

    const withoutDetails = buildPlanningView(input());
    expect(withoutDetails.unassigned[0]?.reason).toBe("Non affectée lors de la dernière optimisation");
    expect(withoutDetails.violationsKnown).toBe(false);
    expect(withoutDetails.kpis.violations).toBeNull();
  });

  it("flags cancelled trips still on a route and locks contradicted by the plan", () => {
    const view = buildPlanningView(
      input({
        trips: [
          trip("a", { routeId: "r1", status: "CANCELLED" }),
          trip("b", { routeId: "r1", status: "ASSIGNED", lockedVehicleId: "v2" }),
        ],
      }),
    );
    expect(view.staleTrips.map((s) => s.tripId)).toEqual(["a", "b"]);
    expect(view.trips.some((t) => t.id === "a")).toBe(true);
  });

  it("shows a plan waiting for confirmation with its question (patients named) and the routes a run replaced", () => {
    const comparison = {
      current: { served: 2, violations: 0, revenue: 150, margin: 60, km: 100 },
      next: { served: 1, violations: 0, revenue: 80, margin: 30, km: 60 },
      lostTripIds: ["b"],
    };
    const pendingRun = run({ id: "run2", status: "AWAITING_CONFIRMATION" });
    const details = new Map<string, RunDetails>([
      [
        "run2",
        {
          runId: "run2",
          solverStatus: "OK",
          // The violations of the plan it would save.
          violations: [{ code: "TIME_WINDOW", message: "Course b en retard", tripId: "b", vehicleId: "v1" }],
          warnings: [],
          unassigned: [],
          kind: "move",
          comparison,
          question: "Déplacement de {course:a} vers Taxi 2 : ce calcul sert 1 course contre 2 dans le planning actuel : remplacer quand même ?",
        },
      ],
      [
        "run1",
        {
          runId: "run1",
          solverStatus: "OK",
          violations: [],
          warnings: [],
          unassigned: [],
          kind: "restore",
          previous: { runId: "run0", figures: comparison.current, routes: [{ vehicleId: "v1", stops: [] }] },
        },
      ],
    ]);
    const view = buildPlanningView(input({ lastRun: pendingRun, details }));
    expect(view.lastRun?.pending).toEqual({
      question: expect.stringMatching(/^Déplacement de l'aller de Patient A vers Taxi 2 : ce calcul sert 1 course contre 2/),
      comparison,
      // Named, with the leg and time, as the page shows them; the violation's raw message is not shown.
      lostTrips: ["Patient B (aller, RDV 08:00)"],
      violations: ["Hors fenêtre horaire — Taxi 1, Patient B (aller, RDV 08:00)"],
    });
    expect(view.lastRun?.kind).toBe("move");
    expect(view.planRun).toMatchObject({ kind: "restore", previous: comparison.current, pending: null });
    expect(buildPlanningView(input()).planRun?.previous).toBeNull();
  });

  it("flags the available vehicles no tariff grid covers that day", () => {
    expect(buildPlanningView(input()).tariffGaps).toEqual([]);
    // Taxi 3 does not work that day: only the available vehicles count.
    expect(buildPlanningView(input({ tariffs: [] })).tariffGaps).toEqual([
      { vehicleType: "TAXI", department: "13", vehicles: ["Taxi 1", "Taxi 2"] },
    ]);
    const ended = { ...taxiGrid, validTo: new Date(`${addDays(DATE, -1)}T00:00:00Z`) };
    expect(buildPlanningView(input({ tariffs: [ended] })).tariffGaps).toHaveLength(1);
  });

  it("reports the day status, the start of the day and a fitted time range", () => {
    expect(buildPlanningView(input({ routes: [], trips: [] })).dayStatus).toBe("EMPTY");
    const view = buildPlanningView(input());
    expect(view.dayStatus).toBe("PROPOSED");
    expect(view.dayStarted).toBe(false);
    expect(view.timeRange).toEqual({ start: 360, end: 1140 });
    const started = buildPlanningView(input({ trips: [trip("a", { routeId: "r1", status: "PICKED_UP" })] }));
    expect(started.dayStarted).toBe(true);
  });

  it("gives the solver budget an optimization launched now would get, scaled with the trips sent", () => {
    expect(buildPlanningView(input()).timeLimitSec).toBe(10);
    // A run in progress shows its own budget, from the trips it sent.
    const running = buildPlanningView(input({ lastRun: run({ status: "RUNNING", finishedAt: null, tripsCount: 240 }) }));
    expect(running.lastRun?.timeLimitSec).toBe(30);
    // 160 trips that can be sent (+ cancelled ones, not sent): 20 s instead of the configured 10 s.
    const many = [
      ...Array.from({ length: 160 }, (_, i) => trip(`t${i}`)),
      ...Array.from({ length: 40 }, (_, i) => trip(`x${i}`, { status: "CANCELLED" })),
    ];
    expect(buildPlanningView(input({ trips: many, routes: [] })).timeLimitSec).toBe(20);
  });

  it("shows a refused move with the patient's name, which the stored error does not hold", () => {
    const failed = run({
      status: "FAILED",
      error: "Déplacement refusé : l'optimiseur a placé {course:c} sur Taxi 2 et non sur Taxi 1. Le planning n'a pas été modifié.",
    });
    const view = buildPlanningView(input({ lastRun: failed }));
    expect(view.lastRun?.error).toBe(
      "Déplacement refusé : l'optimiseur a placé l'aller de Patient C sur Taxi 2 et non sur Taxi 1. Le planning n'a pas été modifié.",
    );
  });

  it("tells a run still computing from one interrupted by a server restart", () => {
    // 240 trips: 30 s budget + 120 s margin after 17:00:00.
    const running = run({ status: "RUNNING", finishedAt: null, tripsCount: 240 });
    const at = (iso: string) => buildPlanningView(input({ lastRun: running, now: new Date(iso) })).lastRun?.interrupted;
    expect(at("2026-11-02T17:00:20Z")).toBe(false);
    expect(at("2026-11-02T17:02:30Z")).toBe(false);
    expect(at("2026-11-02T17:02:31Z")).toBe(true);
    expect(at("2026-11-03T08:00:00Z")).toBe(true);
    // Finished runs are never "interrupted", however old.
    const old = buildPlanningView(input({ now: new Date("2026-11-10T08:00:00Z") }));
    expect(old.lastRun?.interrupted).toBe(false);
    expect(old.planRun?.interrupted).toBe(false);
  });

  it("flags the open return trip whose outbound leg was closed as patient absent", () => {
    const view = buildPlanningView(
      input({
        trips: [
          trip("a", { routeId: "r1", status: "NO_SHOW", recurrenceId: "rec1", patientId: "p1" }),
          trip("b", { routeId: "r1", status: "ASSIGNED", shared: true }),
          trip("ra", { direction: "RETURN", appointmentMinute: null, readyMinute: 690, recurrenceId: "rec1", patientId: "p1" }),
          trip("rb", { direction: "RETURN", appointmentMinute: null, readyMinute: 690, patientId: "p_b" }),
        ],
      }),
    );
    expect(view.trips.filter((t) => t.outboundNoShow).map((t) => t.id)).toEqual(["ra"]);
  });

  it("shows who recorded the sharing answer and each stop status, and only their names", () => {
    const pickedUp = new Date("2026-11-03T07:02:00Z");
    const droppedOff = new Date("2026-11-03T07:41:00Z");
    const view = buildPlanningView(
      input({
        trips: [
          trip("a", {
            routeId: "r1",
            status: "DROPPED_OFF",
            sharingStatus: "ACCEPTED",
            sharingRespondedAt: new Date("2026-11-02T16:40:00Z"),
            sharingRespondedBy: { name: "Marie Régul" },
          }),
          trip("b", { routeId: "r1", status: "ASSIGNED", sharingStatus: "PROPOSED" }),
        ],
        routes: [
          route({
            stops: [
              stop("s1", 0, "a", "PICKUP", 420, 1, pickedUp, { name: "Jean Route" }),
              stop("s2", 1, "b", "PICKUP", 430, 2),
              // Recorded before the audit trail, or by an account deleted since: no name.
              stop("s3", 2, "a", "DROPOFF", 460, 1, droppedOff, null),
              stop("s4", 3, "b", "DROPOFF", 470, 0),
            ],
          }),
        ],
      }),
    );
    const a = view.trips.find((t) => t.id === "a");
    const b = view.trips.find((t) => t.id === "b");
    expect(a?.sharingAnswer).toEqual({ at: "2026-11-02T16:40:00.000Z", byName: "Marie Régul" });
    expect(a?.fieldRecords).toEqual([
      { stopId: "s1", kind: "PICKUP", at: pickedUp.toISOString(), byName: "Jean Route" },
      { stopId: "s3", kind: "DROPOFF", at: droppedOff.toISOString(), byName: null },
    ]);
    expect(b).toMatchObject({ sharingAnswer: null, fieldRecords: [] });
    // The timeline stops carry the done flag only: no recorded instant, no account.
    const stops = view.vehicles[0]?.route?.stops ?? [];
    expect(stops.map((s) => s.completed)).toEqual([true, false, true, false]);
    for (const s of stops) {
      expect(Object.keys(s).sort()).toEqual([
        "address",
        "arrivalMinute",
        "completed",
        "departureMinute",
        "id",
        "kind",
        "lat",
        "lng",
        "loadAfter",
        "sequence",
        "startMinute",
        "tripId",
      ]);
    }
  });
});

describe("recorded by", () => {
  const at = new Date("2026-11-02T16:40:00Z");

  it("gives the last recorded sharing answer with its time, also after a reset of the answer", () => {
    expect(sharingAnswerOf({ sharingRespondedAt: at, sharingRespondedBy: { name: "Marie Régul" } })).toEqual({
      at: "2026-11-02T16:40:00.000Z",
      byName: "Marie Régul",
    });
    // Recorded before the audit trail, by an account deleted since, or a blank name: no author.
    expect(sharingAnswerOf({ sharingRespondedAt: at, sharingRespondedBy: null })).toEqual({
      at: "2026-11-02T16:40:00.000Z",
      byName: null,
    });
    expect(sharingAnswerOf({ sharingRespondedAt: at, sharingRespondedBy: { name: "  " } })?.byName).toBeNull();
    expect(sharingAnswerOf({ sharingRespondedAt: null, sharingRespondedBy: null })).toBeNull();
  });

  it("lists the recorded stops of each trip in route order, over every route", () => {
    const t1 = new Date("2026-11-03T07:00:00Z");
    const t2 = new Date("2026-11-03T07:30:00Z");
    const t3 = new Date("2026-11-03T09:00:00Z");
    const records = fieldRecordsByTrip([
      // Unsorted on purpose: the order is the stop sequence.
      { stops: [stop("s3", 2, "a", "DROPOFF", 460, 0, t2, { name: "Jean" }), stop("s1", 0, "a", "PICKUP", 420, 1, t1, { name: "Jean" })] },
      { stops: [stop("s9", 0, "n", "PICKUP", 540, 1, t3, { name: "Paul" }), stop("s10", 1, "n", "DROPOFF", 580, 0)] },
    ]);
    expect(records.get("a")?.map((r) => [r.stopId, r.kind, r.byName])).toEqual([
      ["s1", "PICKUP", "Jean"],
      ["s3", "DROPOFF", "Jean"],
    ]);
    expect(records.get("n")).toEqual([{ stopId: "s9", kind: "PICKUP", at: t3.toISOString(), byName: "Paul" }]);
    expect(records.has("b")).toBe(false);
  });
});

describe("day KPIs", () => {
  it("computes the KPIs from routes and trips", () => {
    const kpis = computeDayKpis(
      DATE,
      [
        trip("a", { status: "ASSIGNED", routeId: "r1", shared: true }),
        trip("b", { status: "ASSIGNED", routeId: "r1" }),
        trip("c", { status: "PLANNED" }),
        trip("x", { status: "CANCELLED" }),
      ],
      [route({ stops: [stop("s1", 0, "a", "PICKUP", 420, 1), stop("s2", 1, "a", "DROPOFF", 460, 0)] })],
      0,
    );
    expect(kpis).toEqual({
      tripsTotal: 3,
      tripsServed: 2,
      vehiclesUsed: 1,
      tripsPerVehicle: 2,
      totalKm: 100,
      emptyKm: 25,
      emptyKmRatio: 0.25,
      sharedTrips: 1,
      sharedTripRatio: 0.5,
      revenue: 150,
      margin: 60,
      violations: 0,
    });
  });

  // One day as both pages read it from the database: /planning (buildPlanningView)
  // and /tableau-de-bord (load-kpis.ts rows, then @/lib/kpis).
  const done = new Date("2026-11-03T07:58:00Z");
  const dayRoutes: RawRoute[] = [
    route({
      stops: [
        stop("s1", 0, "a", "PICKUP", 420, 1, new Date("2026-11-03T07:00:00Z")),
        stop("s2", 1, "b", "PICKUP", 430, 2),
        stop("s3", 2, "a", "DROPOFF", 460, 1, done),
        stop("s4", 3, "b", "DROPOFF", 470, 0),
        stop("s5", 4, "n", "PICKUP", 600, 1),
        stop("s6", 5, "n", "DROPOFF", 640, 0),
      ],
    }),
    // Route emptied by cancellations: its stale km and money must not count.
    route({ id: "r2", vehicleId: "v2", distanceKm: 80, emptyKm: 80, revenue: 0, cost: 40, margin: -40, stops: [] }),
  ];
  const dayTrips: RawTrip[] = [
    trip("a", { routeId: "r1", status: "DROPPED_OFF", shared: true, plannedPickupMinute: 420, plannedDropoffMinute: 460 }),
    trip("b", { routeId: "r1", status: "ASSIGNED", shared: true, plannedPickupMinute: 430, plannedDropoffMinute: 470 }),
    trip("n", { routeId: "r1", status: "NO_SHOW", plannedPickupMinute: 600, plannedDropoffMinute: 640 }),
    trip("c"),
    trip("x", { status: "CANCELLED" }),
  ];

  /** What tableau-de-bord/load-kpis.ts returns for the same rows. */
  function dashboardRows(): KpiData {
    const served = new Set(["ASSIGNED", "PICKED_UP", "DROPPED_OFF"]);
    return {
      routes: dayRoutes.map((r) => ({
        serviceDate: DATE,
        vehicleId: r.vehicleId,
        distanceKm: r.distanceKm,
        emptyKm: r.emptyKm,
        revenue: r.revenue,
        cost: r.cost,
        margin: r.margin,
        validatedAt: r.validatedAt,
        stopCount: r.stops.length,
        hasRecordedStatus: r.stops.some((s) => s.completedAt !== null),
      })),
      trips: dayTrips
        .filter((t) => t.routeId !== null && served.has(t.status))
        .map((t) => ({
          serviceDate: DATE,
          status: t.status,
          routeId: t.routeId,
          direction: t.direction,
          shared: t.shared,
          appointmentMinute: t.appointmentMinute,
          plannedDropoffMinute: t.plannedDropoffMinute,
          dropoffCompletedAt: t.id === "a" ? done : null,
        })),
      runs: [],
    };
  }

  it("gives /planning the same numbers as /tableau-de-bord for the same day", () => {
    const planning = buildPlanningView(input({ trips: dayTrips, routes: dayRoutes })).kpis;
    const dashboard = computeDashboardDayKpis(DATE, dashboardRows(), "2026-11-02");
    expect({
      tripsServed: planning.tripsServed,
      vehiclesUsed: planning.vehiclesUsed,
      tripsPerVehicle: planning.tripsPerVehicle,
      totalKm: planning.totalKm,
      emptyKm: planning.emptyKm,
      emptyKmRatio: planning.emptyKmRatio,
      sharedTrips: planning.sharedTrips,
      sharedTripRatio: planning.sharedTripRatio,
      revenue: planning.revenue,
      margin: planning.margin,
    }).toEqual({
      tripsServed: dashboard.servedTrips,
      vehiclesUsed: dashboard.vehicles,
      tripsPerVehicle: dashboard.tripsPerVehiclePlanned,
      totalKm: dashboard.distanceKm,
      emptyKm: dashboard.emptyKm,
      emptyKmRatio: dashboard.emptyKmShare,
      sharedTrips: dashboard.sharedTrips,
      sharedTripRatio: dashboard.sharedRate,
      revenue: dashboard.revenue,
      margin: dashboard.margin,
    });
    // And the figures themselves: the absent patient and the emptied route do not count.
    expect(planning).toMatchObject({
      tripsTotal: 3,
      tripsServed: 2,
      vehiclesUsed: 1,
      tripsPerVehicle: 2,
      totalKm: 100,
      emptyKmRatio: 0.25,
      sharedTripRatio: 1,
      revenue: 150,
      margin: 60,
    });
  });

  it("builds the dashboard rows as load-kpis.ts does (@/lib/kpis keeps only the served trips)", () => {
    const rows = toKpiRows(DATE, dayTrips, dayRoutes);
    const expected = dashboardRows();
    expect(rows.routes).toEqual(expected.routes);
    expect(rows.trips.filter((t) => t.routeId !== null && t.status !== "NO_SHOW")).toEqual(expected.trips);
  });

});

describe("helpers", () => {
  it("derives the day status", () => {
    expect(dayStatusOf(3, [])).toBe("UNPLANNED");
    expect(dayStatusOf(3, [{ status: "VALIDATED" }, { status: "VALIDATED" }])).toBe("VALIDATED");
    expect(dayStatusOf(3, [{ status: "VALIDATED" }, { status: "PROPOSED" }])).toBe("MIXED");
  });

  it("measures the wait at the facility in both directions", () => {
    const base = { appointmentMinute: 480, readyMinute: 690, plannedPickupMinute: 700, plannedDropoffMinute: 455 };
    expect(waitAtFacility({ ...base, direction: "OUTBOUND" })).toBe(25);
    expect(waitAtFacility({ ...base, direction: "RETURN" })).toBe(10);
    expect(waitAtFacility({ ...base, direction: "RETURN", plannedPickupMinute: null })).toBeNull();
  });
});
